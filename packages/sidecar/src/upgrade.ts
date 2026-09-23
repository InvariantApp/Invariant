/**
 * WebSocket and every other `Upgrade`, passed through to the upstream.
 *
 * An upgraded connection stops being HTTP, so there is no message for a
 * program to adapt: after the handshake it is bytes in both directions,
 * piped as they come. The handshake itself is forwarded with the caller's
 * path, query and headers, and the upstream's answer, `101` or a refusal,
 * reaches the caller as it was sent.
 */
import type { IncomingMessage } from "node:http";
import { connect as connectTcp, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { connect as connectTls } from "node:tls";

export type UpgradeHandler = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => void;

export function passUpgrades(
  upstream: string | URL,
  host: "caller" | "upstream" = "caller",
): UpgradeHandler {
  const target = new URL(upstream);
  const secure = target.protocol === "https:";
  const port = Number(target.port || (secure ? 443 : 80));
  const base = target.pathname.replace(/\/$/, "");

  return (request, socket, head) => {
    // Only the path and query are taken from the request line, as for every
    // other request: a caller never chooses where the proxy connects.
    const at = new URL(request.url ?? "/", "http://placeholder.invalid");
    const lines = [
      `${request.method ?? "GET"} ${base}${at.pathname}${at.search} HTTP/1.1`,
    ];
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
      lines.push(`${name}: ${value}`);
    }
    if (host === "caller" && callerHost) {
      lines.push(`Host: ${callerHost}`);
    } else {
      lines.push(`Host: ${target.host}`);
      if (callerHost && !forwardedHost) lines.push(`X-Forwarded-Host: ${callerHost}`);
    }
    const peer = request.socket.remoteAddress;
    if (peer) forwarded = forwarded ? `${forwarded}, ${peer}` : peer;
    if (forwarded) lines.push(`X-Forwarded-For: ${forwarded}`);

    const onward: Socket = secure
      ? connectTls({ host: target.hostname, port, servername: target.hostname })
      : connectTcp({ host: target.hostname, port });
    const ready = secure ? "secureConnect" : "connect";
    onward.once(ready, () => {
      onward.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) onward.write(head);
      onward.pipe(socket);
      socket.pipe(onward);
    });
    const close = () => {
      onward.destroy();
      socket.destroy();
    };
    onward.on("error", () => {
      // The upstream never answered, so the caller is told so, once.
      if (socket.writable && onward.bytesRead === 0) {
        socket.end(
          "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
      } else close();
    });
    socket.on("error", close);
    socket.on("close", () => onward.destroy());
    onward.on("close", () => socket.destroy());
  };
}
