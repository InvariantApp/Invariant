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
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type { FetchHandler } from "./proxy.ts";

export interface Listening {
  server: Server;
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
}

export async function serve(
  handler: FetchHandler,
  options: ServeOptions,
): Promise<Listening> {
  const server = createServer(
    {
      requestTimeout: options.requestTimeoutMs ?? 120_000,
      headersTimeout: options.headersTimeoutMs ?? 30_000,
    },
    (incoming, outgoing) => {
      void handle(handler, incoming, outgoing, options.onError);
    },
  );
  server.maxConnections = options.maxConnections ?? 10_000;
  // Longer than a typical load balancer's idle timeout, so the balancer closes
  // idle connections rather than finding them closed under it.
  server.keepAliveTimeout = 65_000;

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
    url: `http://${host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}

async function handle(
  handler: FetchHandler,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  onError: ((error: unknown) => void) | undefined,
): Promise<void> {
  try {
    const response = await handler(toRequest(incoming));
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
      outgoing.destroy();
    }
  }
}

function toRequest(incoming: IncomingMessage): Request {
  // Only the path and query are taken from the request line. A request written
  // in absolute form names a host, and nothing here should let a caller choose
  // one; the proxy sends everything to its configured upstream regardless.
  const target = new URL(incoming.url ?? "/", "http://placeholder.invalid");
  const host = incoming.headers.host ?? "localhost";
  const url = new URL(`${target.pathname}${target.search}`, `http://${host}`);

  const headers = new Headers();
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    headers.append(
      incoming.rawHeaders[index] as string,
      incoming.rawHeaders[index + 1] as string,
    );
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

async function write(response: Response, outgoing: ServerResponse): Promise<void> {
  outgoing.statusCode = response.status;
  for (const [name, value] of response.headers) {
    if (name === "set-cookie") continue;
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
    source.pipe(outgoing);
  });
}
