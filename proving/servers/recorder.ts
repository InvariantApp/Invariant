/**
 * A pass-through that writes down what it carried.
 *
 * Rig D's false-closure measurement needs to see three answers to one call:
 * what the old server said, what the new server said, and what the adapter
 * turned that into. This sits in front of whatever it is given and forwards
 * every request and response untouched, streaming both ways, while keeping
 * the status and, for a JSON answer, the parsed body. Nothing it records is
 * sent anywhere; the rig reads it back once the arm has run.
 *
 * Two of them bracket the proxy in arm c. The outer one numbers each call in
 * a header and the inner one reads that number, so the adapter's answer and
 * the answer it was made from are paired by what they are, not by timing.
 * Upgrades (websockets) are piped through and not recorded.
 */
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
  type Server,
} from "node:http";
import { connect } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import type { Exchange, Json } from "./closure.ts";

/**
 * Carries an exchange's number from the outer recorder to the inner one. Not
 * `x-invariant-`, which the proxy drops on arrival since a caller could forge it.
 */
export const EXCHANGE_HEADER = "x-proving-exchange";

/** Larger answers are forwarded whole and recorded without a body. */
const MAX_RECORDED_BYTES = 2 * 1024 * 1024;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
]);

function forwardable(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase())),
  );
}

function decoded(bytes: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? "").toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return gunzipSync(bytes);
    case "deflate":
      return inflateSync(bytes);
    case "br":
      return brotliDecompressSync(bytes);
    default:
      return bytes;
  }
}

function jsonOf(message: IncomingMessage, chunks: Buffer[], size: number): unknown {
  const type = String(message.headers["content-type"] ?? "");
  if (!/\bjson\b/i.test(type) || size === 0 || size > MAX_RECORDED_BYTES)
    return undefined;
  try {
    const text = decoded(
      Buffer.concat(chunks),
      message.headers["content-encoding"] as string | undefined,
    ).toString("utf8");
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface Recorder {
  /** Stops listening and returns what was carried, in the order calls began. */
  close(): Promise<Exchange[]>;
}

/**
 * Listens on `port` and forwards to `upstream`. `numbering` is `assign` for
 * the recorder a suite calls, `read` for one behind the proxy.
 */
export async function startRecorder(options: {
  port: number;
  upstream: string;
  numbering: "assign" | "read";
}): Promise<Recorder> {
  const target = new URL(options.upstream);
  const exchanges: Exchange[] = [];
  let next = 0;

  const server: Server = createServer((incoming, outgoing) => {
    const id =
      options.numbering === "assign"
        ? next++
        : Number(incoming.headers[EXCHANGE_HEADER] ?? Number.NaN);
    const headers = forwardable(incoming.headers);
    if (options.numbering === "assign") headers[EXCHANGE_HEADER] = String(id);
    const url = new URL(incoming.url ?? "/", "http://recorder");
    const upstream = request(
      {
        host: target.hostname,
        port: target.port,
        method: incoming.method,
        path: `${url.pathname}${url.search}`,
        headers,
      },
      (answer) => {
        outgoing.writeHead(answer.statusCode ?? 502, forwardable(answer.headers));
        const chunks: Buffer[] = [];
        let size = 0;
        answer.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size <= MAX_RECORDED_BYTES) chunks.push(chunk);
          outgoing.write(chunk);
        });
        answer.on("end", () => {
          outgoing.end();
          if (Number.isFinite(id)) {
            const body = jsonOf(answer, chunks, size);
            exchanges.push({
              id,
              method: incoming.method ?? "GET",
              path: url.pathname,
              status: answer.statusCode ?? 0,
              ...(body === undefined ? {} : { body: body as Json }),
            });
          }
        });
        answer.on("error", () => outgoing.destroy());
      },
    );
    upstream.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(upstream);
  });

  // A websocket, or anything else that upgrades, is joined end to end.
  server.on("upgrade", (incoming, socket, head) => {
    const peer = connect(Number(target.port), target.hostname, () => {
      const lines = [`${incoming.method} ${incoming.url} HTTP/1.1`];
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        lines.push(`${incoming.rawHeaders[index]}: ${incoming.rawHeaders[index + 1]}`);
      }
      peer.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) peer.write(head);
      peer.pipe(socket);
      socket.pipe(peer);
    });
    peer.on("error", () => socket.destroy());
    socket.on("error", () => peer.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolve());
  });

  return {
    close: async () => {
      // A websocket still open would hold the server's close forever; what
      // was recorded is complete once the suite has finished either way.
      await Promise.race([
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref()),
      ]);
      return [...exchanges].sort((a, b) => a.id - b.id);
    },
  };
}
