/**
 * WebSocket and every other `Upgrade`, passed through to the upstream.
 *
 * An upgraded connection stops being HTTP, so there is no message for a
 * program to adapt: after the handshake it is bytes in both directions,
 * piped as they come. The handshake itself is forwarded with the caller's
 * path, query and headers, and the upstream's answer, `101` or a refusal,
 * reaches the caller as it was sent.
 *
 * Nothing the caller sends after the handshake reaches the upstream until the
 * upstream has answered `101`. The first version piped both ways as soon as
 * the handshake was written, and a threat-model test found what that allows:
 * an upstream that ignores `Upgrade` on an ordinary route answers it as a
 * request and keeps the connection open, and the caller's next bytes arrive
 * there as a second request that never went through this proxy. `GET /ws`
 * with `Upgrade: websocket`, then `GET /admin` on the same socket, reached
 * `/admin` on an upstream configured as `http://host/api`: outside the base
 * path, with any `x-invariant-` header the caller liked. So the handshake is
 * sent as one request of its own, on a connection of its own, and a refusal is
 * relayed and the connection closed.
 */
import {
  type ClientRequest,
  request as httpRequest,
  type IncomingMessage,
  STATUS_CODES,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import { hidesTraversal } from "./proxy.ts";

export type UpgradeHandler = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => void;

/**
 * Headers describing the connection the answer arrived on, which the caller's
 * connection does not share: the body is relayed without its chunking and the
 * connection then closes, which is how the caller learns where it ends.
 */
const RELAY_DROPPED = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
]);

export function passUpgrades(
  upstream: string | URL,
  host: "caller" | "upstream" = "upstream",
): UpgradeHandler {
  const target = new URL(upstream);
  const secure = target.protocol === "https:";
  const base = target.pathname.replace(/\/$/, "");

  return (request, socket, head) => {
    // Only the path and query are taken from the request line, as for every
    // other request: a caller never chooses where the proxy connects.
    const at = new URL(request.url ?? "/", "http://placeholder.invalid");
    const headers: [string, string][] = [];
    let forwarded: string | undefined;
    // The Host the provider is sent, as for every other request.
    const callerHost = request.headers.host;
    let forwardedHost = false;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index] as string;
      const value = request.rawHeaders[index + 1] as string;
      const lower = name.toLowerCase();
      if (lower === "host") continue;
      if (lower === "x-forwarded-host") forwardedHost = true;
      // Nothing a caller claims as the engine's own conclusion is passed on.
      if (lower.startsWith("x-invariant-")) continue;
      if (lower === "x-forwarded-for") {
        forwarded = forwarded ? `${forwarded}, ${value}` : value;
        continue;
      }
      headers.push([name, value]);
    }
    if (host === "caller" && callerHost) {
      headers.push(["Host", callerHost]);
    } else {
      headers.push(["Host", target.host]);
      if (callerHost && !forwardedHost) headers.push(["X-Forwarded-Host", callerHost]);
    }
    const peer = request.socket.remoteAddress;
    if (peer) forwarded = forwarded ? `${forwarded}, ${peer}` : peer;
    if (forwarded) headers.push(["X-Forwarded-For", forwarded]);

    // A handshake has no body. One that claims one is either confused or
    // hoping its bytes are read as something else, and they would not be sent
    // until the upstream had switched protocols anyway. A path that leaves the
    // API is refused here as it is for every other request.
    if (hasBody(request) || hidesTraversal(at.pathname)) {
      socket.end(
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }

    // Whatever the caller sends from here on waits for the upstream's answer.
    // A WebSocket client sends nothing before the `101` it is waiting for, so
    // this delays nobody honest.
    socket.pause();

    const onward: ClientRequest = (secure ? httpsRequest : httpRequest)({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: request.method ?? "GET",
      path: `${base}${at.pathname}${at.search}`,
      headers: headers.flat(),
      ...(secure ? { servername: target.hostname } : {}),
      // A connection of its own, never one kept for another request: the one
      // this handshake is sent on becomes the caller's once it is upgraded.
      agent: false,
      setHost: false,
    });

    const close = () => {
      onward.destroy();
      socket.destroy();
    };
    socket.on("error", close);
    socket.on("close", () => onward.destroy());

    onward.on("upgrade", (answer: IncomingMessage, upgraded: Duplex, rest: Buffer) => {
      socket.write(`${statusLine(answer)}${headerLines(answer.rawHeaders)}\r\n`);
      if (rest.length > 0) socket.write(rest);
      if (head.length > 0) upgraded.write(head);
      upgraded.on("error", close);
      upgraded.on("close", () => socket.destroy());
      socket.on("close", () => upgraded.destroy());
      upgraded.pipe(socket);
      socket.pipe(upgraded);
      socket.resume();
    });

    // The upstream did not switch protocols, so this was one request and its
    // answer is the whole of the exchange. The caller hears it, and then the
    // connection closes: nothing else it sent is ever read.
    onward.on("response", (answer: IncomingMessage) => {
      const kept: string[] = [];
      for (let index = 0; index < answer.rawHeaders.length; index += 2) {
        const name = answer.rawHeaders[index] as string;
        if (RELAY_DROPPED.has(name.toLowerCase())) continue;
        kept.push(name, answer.rawHeaders[index + 1] as string);
      }
      kept.push("Connection", "close");
      socket.write(`${statusLine(answer)}${headerLines(kept)}\r\n`);
      answer.on("data", (chunk: Buffer) => socket.write(chunk));
      answer.on("end", () => socket.end());
      answer.on("error", close);
    });

    onward.on("error", () => {
      // The upstream never answered, so the caller is told so, once.
      if (socket.writable) {
        socket.end(
          "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
      } else close();
    });

    onward.end();
  };
}

/** Whether a request says a body follows its headers. */
export function hasBody(request: IncomingMessage): boolean {
  const length = request.headers["content-length"];
  return (
    request.headers["transfer-encoding"] !== undefined ||
    (length !== undefined && length !== "0")
  );
}

/**
 * Whether a request asks to switch to HTTP/2 in cleartext. Such a request is
 * never passed on as an upgrade: an upstream that accepted would then take
 * HTTP/2 frames naming any path at all, straight from the caller.
 */
export function asksForH2c(request: IncomingMessage): boolean {
  return (request.headers.upgrade ?? "")
    .split(",")
    .some((token) => token.trim().toLowerCase() === "h2c");
}

function statusLine(answer: IncomingMessage): string {
  const status = answer.statusCode ?? 502;
  return `HTTP/1.1 ${status} ${answer.statusMessage || STATUS_CODES[status] || ""}\r\n`;
}

function headerLines(raw: readonly string[]): string {
  let out = "";
  for (let index = 0; index < raw.length; index += 2) {
    out += `${raw[index]}: ${raw[index + 1]}\r\n`;
  }
  return out;
}
