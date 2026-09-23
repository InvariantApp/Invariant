/**
 * Binds the proxy to a socket.
 *
 * Kept apart from the proxy itself so that everything about what a request
 * becomes is tested without a network, and this file only has to be right about
 * one thing: moving bytes between Node's HTTP types and the web's, streaming in
 * both directions so that a request the proxy has no work for is never held in
 * memory.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  ServerResponse,
} from "node:http";
import {
  createSecureServer,
  type Http2SecureServer,
  type Http2ServerRequest,
  type Http2ServerResponse,
} from "node:http2";
import type { AddressInfo, Socket } from "node:net";
import { type Duplex, Readable } from "node:stream";
import { ERROR_CODES } from "@invariant-app/runtime";
import type { FetchHandler } from "./proxy.ts";
import { asksForH2c, hasBody, type UpgradeHandler } from "./upgrade.ts";

export interface Listening {
  server: Server | Http2SecureServer;
  /** Where it is listening, which matters when the port was chosen by the system. */
  url: string;
  /** Stops accepting, lets requests in flight finish, then resolves. */
  close: () => Promise<void>;
}

export interface ServeOptions {
  port: number;
  host?: string;
  /**
   * Longest a whole request may take to arrive from the caller, so one
   * trickling bytes cannot hold a connection open indefinitely. The upstream's
   * answer is not included. Default two minutes, for large uploads on slow
   * links.
   */
  requestTimeoutMs?: number;
  /** Longest the request headers may take to arrive. Default 30 seconds. */
  headersTimeoutMs?: number;
  /** Most connections held at once; past it new ones are refused. Default 10,000. */
  maxConnections?: number;
  /** Called with anything thrown past the proxy's own handling. */
  onError?: (error: unknown) => void;
  /**
   * Terminate TLS here, with this certificate and key in PEM. Callers are
   * then served HTTP/2 or HTTP/1.1 on the one port, whichever they offer:
   * some official SDKs, stripe-go among them, insist on HTTP/2.
   */
  tls?: { cert: string | Buffer; key: string | Buffer };
  /** Where a request asking to `Upgrade`, a WebSocket among them, is sent. */
  upgrade?: UpgradeHandler;
}

type Incoming = IncomingMessage | Http2ServerRequest;
type Outgoing = ServerResponse | Http2ServerResponse;

/**
 * Headers that belong to one HTTP/1.1 connection. HTTP/2 has no such thing,
 * and a response carrying one is refused by the protocol layer.
 */
const CONNECTION_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
]);

export async function serve(
  handler: FetchHandler,
  options: ServeOptions,
): Promise<Listening> {
  const requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
  const server = options.tls
    ? secureServer(handler, options, requestTimeoutMs)
    : createServer(
        {
          requestTimeout: requestTimeoutMs,
          headersTimeout: options.headersTimeoutMs ?? 30_000,
          // Longer than a typical load balancer's idle timeout, so the
          // balancer closes idle connections rather than finding them closed
          // under it.
          keepAliveTimeout: 65_000,
        },
        (incoming, outgoing) => {
          void handle(handler, incoming, outgoing, options.onError);
        },
      );
  server.maxConnections = options.maxConnections ?? 10_000;
  const upgrade = options.upgrade;
  if (upgrade) {
    server.on("upgrade", (incoming: IncomingMessage, socket: Duplex, head: Buffer) => {
      // HTTP/2 in cleartext is declined the way RFC 7540 lets a server that
      // does not speak it decline: by answering as if nobody had asked.
      if (asksForH2c(incoming)) servePlainly(handler, incoming, socket, options.onError);
      else upgrade(incoming, socket, head);
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    server,
    url: `${options.tls ? "https" : "http"}://${host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        if ("closeIdleConnections" in server) server.closeIdleConnections();
      }),
  };
}

/**
 * TLS terminated here, serving HTTP/2 and HTTP/1.1 alike. HTTP/2 has no
 * whole-request timeout of its own, so each request is given one: a stream
 * that has not finished arriving in time is closed.
 */
function secureServer(
  handler: FetchHandler,
  options: ServeOptions,
  requestTimeoutMs: number,
): Http2SecureServer {
  const tls = options.tls as NonNullable<ServeOptions["tls"]>;
  const server = createSecureServer({ cert: tls.cert, key: tls.key, allowHTTP1: true });
  server.on("request", (incoming: Incoming, outgoing: Outgoing) => {
    const timer = setTimeout(() => {
      if (!incoming.complete) destroy(outgoing);
    }, requestTimeoutMs);
    timer.unref();
    incoming.once("end", () => clearTimeout(timer));
    outgoing.once("close", () => clearTimeout(timer));
    void handle(handler, incoming, outgoing, options.onError);
  });
  // A connection idle this long, one whose handshake never finished among
  // them, is closed rather than held.
  server.setTimeout(options.headersTimeoutMs ?? 30_000);
  return server;
}

function destroy(outgoing: Outgoing): void {
  if ("stream" in outgoing) outgoing.stream.close();
  else outgoing.destroy();
}

/**
 * An upgrade request answered as an ordinary one, on the socket it came in on,
 * which then closes. Its body, if it had one, was never parsed as one, so such
 * a request is refused rather than sent on without it.
 */
function servePlainly(
  handler: FetchHandler,
  incoming: IncomingMessage,
  socket: Duplex,
  onError: ((error: unknown) => void) | undefined,
): void {
  const outgoing = new ServerResponse(incoming);
  outgoing.shouldKeepAlive = false;
  outgoing.assignSocket(socket as Socket);
  outgoing.once("finish", () => {
    outgoing.detachSocket(socket as Socket);
    socket.end();
  });
  socket.on("error", () => socket.destroy());
  if (hasBody(incoming)) {
    refuse(
      outgoing,
      "This request asks to switch to HTTP/2 in cleartext and carries a body, which this proxy does not accept. Send it without `Upgrade: h2c`.",
    );
    return;
  }
  void handle(handler, incoming, outgoing, onError);
}

/** A request this proxy cannot read as one, answered in the shape of its own errors. */
function refuse(outgoing: Outgoing, message: string): void {
  outgoing.statusCode = 400;
  outgoing.setHeader("content-type", "application/json");
  outgoing.end(
    JSON.stringify({
      error: {
        type: "invalid_request_error",
        message,
        code: ERROR_CODES.requestNotTranslatable,
      },
    }),
  );
}

async function handle(
  handler: FetchHandler,
  incoming: Incoming,
  outgoing: Outgoing,
  onError: ((error: unknown) => void) | undefined,
): Promise<void> {
  let request: Request;
  try {
    request = toRequest(incoming);
  } catch {
    // Node's parser takes a `Host` of `a b`, which no URL can hold. That is
    // the caller's mistake, and answering it 500 would page the provider for
    // it. Found by the threat-model tests.
    refuse(outgoing, "The request's Host header is not a host.");
    return;
  }
  try {
    const response = await handler(request);
    await write(response, outgoing);
  } catch (error) {
    onError?.(error);
    // Nothing about the failure is sent back: it may describe the provider's
    // internals, and the caller can do nothing with it.
    if (!outgoing.headersSent) {
      outgoing.statusCode = 500;
      outgoing.setHeader("content-type", "application/json");
      outgoing.end(
        JSON.stringify({
          error: {
            type: "api_error",
            message: "Internal proxy error.",
            code: "invariant_internal",
          },
        }),
      );
    } else {
      destroy(outgoing);
    }
  }
}

function toRequest(incoming: Incoming): Request {
  // Only the path and query are taken from the request line. A request written
  // in absolute form names a host, and nothing here should let a caller choose
  // one; the proxy sends everything to its configured upstream regardless.
  const target = new URL(incoming.url ?? "/", "http://placeholder.invalid");
  // HTTP/2 names the host in :authority, which carries what Host would.
  const authority = incoming.headers[":authority"];
  const host =
    incoming.headers.host ?? (typeof authority === "string" ? authority : "localhost");
  const url = new URL(`${target.pathname}${target.search}`, `http://${host}`);

  const headers = new Headers();
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    const name = incoming.rawHeaders[index] as string;
    // HTTP/2's pseudo-headers are the request line, already read above.
    if (name.startsWith(":")) continue;
    headers.append(name, incoming.rawHeaders[index + 1] as string);
  }
  const peer = incoming.socket.remoteAddress;
  if (peer) {
    const prior = headers.get("x-forwarded-for");
    headers.set("x-forwarded-for", prior ? `${prior}, ${peer}` : peer);
  }

  const method = incoming.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url, {
    method,
    headers,
    ...(hasBody
      ? { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: "half" }
      : {}),
  } as RequestInit);
}

async function write(response: Response, outgoing: Outgoing): Promise<void> {
  const http2 = "stream" in outgoing;
  outgoing.statusCode = response.status;
  for (const [name, value] of response.headers) {
    if (name === "set-cookie") continue;
    if (http2 && CONNECTION_HEADERS.has(name)) continue;
    outgoing.setHeader(name, value);
  }
  // Several cookies cannot share one header line, so they are written one each.
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) outgoing.setHeader("set-cookie", cookies);

  if (!response.body) {
    outgoing.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const source = Readable.fromWeb(response.body as never);
    source.on("error", reject);
    outgoing.on("error", reject);
    outgoing.on("finish", resolve);
    source.pipe(outgoing as NodeJS.WritableStream);
  });
}
