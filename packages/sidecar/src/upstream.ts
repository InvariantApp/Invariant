/**
 * Calling the provider with Node's own HTTP client rather than `fetch`.
 *
 * `fetch` is a browser's client, and two of a browser's rules are wrong for a
 * proxy. It will not send a Host header of the caller's choosing, so the
 * provider sees the proxy's own address where the caller's was, and anything
 * it builds from that, as Gitea builds its avatar links, points at an address
 * no caller can reach. And it throws away the body of a 205, because the
 * standard says one has none, although servers send one: Gitea answers
 * marking notifications read with 205 and the threads it marked. Found by
 * running go-sdk 0.22.1's own suite through the proxy (proving/servers).
 *
 * The answer is what `fetch` would give, otherwise: a body decoded from the
 * encodings `fetch` decodes, redirects not followed, and the caller's signal
 * honoured, so a timeout still rejects with the reason it was given.
 */
import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable, type Transform } from "node:stream";
import * as zlib from "node:zlib";
import { responseOf } from "@invariant-app/runtime";

/** The decoders for what `fetch` decodes, by the coding's name. */
function decoderFor(coding: string): Transform | undefined {
  switch (coding.trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "deflate":
      return zlib.createInflate();
    case "br":
      return zlib.createBrotliDecompress();
    case "zstd":
      return "createZstdDecompress" in zlib
        ? (
            zlib as unknown as { createZstdDecompress: () => Transform }
          ).createZstdDecompress()
        : undefined;
    default:
      return undefined;
  }
}

/**
 * The provider's answer, decoded where it can be. Codings are undone last
 * applied first; one this cannot undo leaves the body as it came, with the
 * header that says so.
 */
function decoded(answer: IncomingMessage, headers: Headers): Readable {
  const codings = (headers.get("content-encoding") ?? "")
    .split(",")
    .map((coding) => coding.trim())
    .filter(Boolean)
    .reverse();
  const decoders = codings.map(decoderFor);
  if (codings.length === 0 || decoders.some((decoder) => decoder === undefined)) {
    return answer;
  }
  headers.delete("content-encoding");
  headers.delete("content-length");
  let stream: Readable = answer;
  for (const decoder of decoders as Transform[]) {
    stream.on("error", (error) => decoder.destroy(error));
    stream = stream.pipe(decoder);
  }
  return stream;
}

/** Statuses and methods whose answer never has a body to read. */
const EMPTY = new Set([204, 304]);

export const sendUpstream = ((input: string | URL | Request, init: RequestInit = {}) => {
  const target = new URL(input instanceof Request ? input.url : input);
  const method = (init.method ?? "GET").toUpperCase();
  const outgoing: Record<string, string> = {};
  for (const [name, value] of new Headers(init.headers)) outgoing[name] = value;
  const signal = init.signal ?? undefined;

  return new Promise<Response>((resolve, reject) => {
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    // An empty Host is HTTP/1.1's way of naming no host, which Node's client
    // would fill in with the provider's address unless told not to.
    const setHost = outgoing["host"] !== "";
    const call = send(
      target,
      { method, headers: outgoing, signal, setHost },
      (answer) => {
        const headers = new Headers();
        const raw = answer.rawHeaders;
        for (let index = 0; index < raw.length; index += 2) {
          headers.append(raw[index] as string, raw[index + 1] as string);
        }
        const status = answer.statusCode ?? 502;
        if (method === "HEAD" || EMPTY.has(status)) {
          answer.resume();
          resolve(responseOf(null, status, headers));
          return;
        }
        const body = Readable.toWeb(
          decoded(answer, headers),
        ) as ReadableStream<Uint8Array>;
        resolve(responseOf(body, status, headers));
      },
    );
    // A timeout is reported as the reason the signal gave, as `fetch` does,
    // so the proxy tells a slow provider from an unreachable one.
    call.on("error", (error) => reject(signal?.aborted ? signal.reason : error));

    const body = init.body;
    if (body === undefined || body === null) {
      call.end();
    } else if (typeof body === "string" || body instanceof Uint8Array) {
      call.end(body);
    } else if (body instanceof ReadableStream) {
      const source = Readable.fromWeb(body as never);
      source.on("error", (error) => call.destroy(error));
      source.pipe(call);
    } else {
      call.destroy(new TypeError("The proxy only forwards text, bytes or a stream"));
    }
  });
}) as typeof fetch;
