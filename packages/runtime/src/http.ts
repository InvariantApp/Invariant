/**
 * The HTTP rules every binding follows when it has to read a body.
 *
 * They lived in the proxy alone, and the in-process binding had none: it read
 * whatever arrived, however large, whatever its type, and handed it to
 * `JSON.parse`. A CSV export, a multipart upload or a compressed response on
 * an adapted operation all became errors a caller could do nothing about. One
 * copy of the rules, here, is how the bindings stop disagreeing.
 *
 * Nothing in this file touches the network or the file system. It uses only
 * web-standard globals, so it runs wherever the runtime does.
 */
import { BodyTooLargeError, UnsupportedEncodingError } from "./errors.ts";

/**
 * Whether a body of this type is one a compiled program describes.
 *
 * Programs are compiled from a document's JSON representations, so anything
 * else, an HTML error page, a file, an event stream, is outside what the
 * program says and passes through untouched rather than being guessed at.
 */
export function isJsonMediaType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const media = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return media === "application/json" || media.endsWith("+json");
}

/** Web-standard names for each encoding `DecompressionStream` understands. */
const DECODERS: Record<string, string> = {
  gzip: "gzip",
  "x-gzip": "gzip",
  deflate: "deflate",
  br: "brotli",
};

export interface ReadOptions {
  /** Largest body, in decoded bytes, that will be buffered. */
  limit: number;
  /**
   * Whether the bytes on the stream are still encoded. False where the
   * transport has already decoded them, as `fetch` does, so they are not
   * decoded twice.
   */
  encoded: boolean;
}

export interface BodyText {
  text: string;
  /**
   * True when an encoding was removed, so the message rebuilt from this text
   * must not declare it any more. A client told to decompress plain text
   * fails in a way nobody can diagnose from the outside.
   */
  decoded: boolean;
}

/**
 * Reads a body as text, refusing past the limit without holding the rest.
 *
 * A declared length over the limit is refused before a byte is read. One that
 * lies, or none at all, is counted as it arrives. The count is of decoded
 * bytes, because a small compressed body can expand to anything, and a limit
 * that only measured the wire would let a caller buffer an unbounded one.
 */
export async function readBodyText(
  message: Request | Response,
  options: ReadOptions,
): Promise<BodyText> {
  const encoding = (message.headers.get("content-encoding") ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token !== "" && token !== "identity");
  const decoding = options.encoded && encoding.length > 0;

  const declared = Number(message.headers.get("content-length"));
  if (!decoding && Number.isFinite(declared) && declared > options.limit) {
    throw new BodyTooLargeError(options.limit);
  }
  if (!message.body) return { text: "", decoded: false };

  let stream: ReadableStream<Uint8Array> = message.body;
  if (decoding) {
    // Listed in the order they were applied, so undone in reverse.
    for (const token of [...encoding].reverse()) {
      const format = DECODERS[token];
      if (format === undefined) throw new UnsupportedEncodingError(token);
      let decoder: DecompressionStream;
      try {
        decoder = new DecompressionStream(
          format as ConstructorParameters<typeof DecompressionStream>[0],
        );
      } catch {
        throw new UnsupportedEncodingError(token);
      }
      stream = stream.pipeThrough(
        decoder as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
      );
    }
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > options.limit) {
        await reader.cancel();
        throw new BodyTooLargeError(options.limit);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw error;
    // A stream that claims an encoding and does not decode as one is not a
    // body anything downstream can read either.
    if (decoding) throw new UnsupportedEncodingError(encoding.join(", "));
    throw error;
  }

  const whole = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    whole.set(chunk, at);
    at += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(whole), decoded: decoding };
}

/** Headers for a body rebuilt from text: new length, and no stale encoding. */
export function headersForText(source: Headers, text: string, decoded: boolean): Headers {
  const headers = new Headers(source);
  if (decoded) headers.delete("content-encoding");
  // Any digest of the original bytes describes a body that is no longer sent.
  headers.delete("content-md5");
  headers.delete("digest");
  headers.delete("repr-digest");
  headers.delete("content-digest");
  headers.set("content-length", String(new TextEncoder().encode(text).byteLength));
  return headers;
}

/**
 * What separates a handler's entity tag from the contract it was adapted for.
 * Legal inside an entity tag, and not in a contract label.
 */
const ETAG_MARK = "~";

/**
 * The entity tag a response adapted for `contract` carries: the handler's,
 * marked with the contract, or nothing when the handler's cannot be read.
 *
 * The handler's tag names the bytes it produced, and an old caller is sent
 * other bytes. Passed on unchanged, a cache holding one contract's shape would
 * revalidate it for another's, and a client sending `If-Match` would be told
 * its copy is current when it is not.
 */
export function markEtag(etag: string, contract: string): string | undefined {
  const match = /^(W\/)?"([^"]*)"$/.exec(etag.trim());
  if (!match) return undefined;
  return `${match[1] ?? ""}"${match[2]}${ETAG_MARK}${contract}"`;
}

/** An entity tag no handler issued, so a precondition naming it cannot hold. */
const NO_MATCH = '"~"';

/**
 * Conditional request headers as the handler should compare them, for a
 * caller on `contract`: each tag marked for that contract has its mark taken
 * off, so the handler compares against its own tags and can still answer
 * `304`. A tag without that mark names the bytes of another contract, never
 * the ones this caller holds, so it must not match: it is dropped from
 * `If-None-Match`, which then asks for the whole answer, and replaced in
 * `If-Match` by one no handler issued, so the write is refused rather than
 * made against a copy the caller never saw. `*` is kept. The headers
 * themselves when nothing changed.
 */
export function unmarkConditionals(headers: Headers, contract: string): Headers {
  const suffix = `${ETAG_MARK}${contract}"`;
  let out: Headers | undefined;
  for (const name of ["if-none-match", "if-match"]) {
    const value = headers.get(name);
    if (value === null) continue;
    const tags = value
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    const kept = tags.flatMap((tag) => {
      if (tag === "*") return [tag];
      if (tag.endsWith(suffix)) return [`${tag.slice(0, -suffix.length)}"`];
      return name === "if-match" ? [NO_MATCH] : [];
    });
    const next = [...new Set(kept)].join(", ");
    if (next === value) continue;
    out ??= new Headers(headers);
    if (next === "") out.delete(name);
    else out.set(name, next);
  }
  return out ?? headers;
}

/**
 * Adds header names to `Vary`, once each.
 *
 * A response shaped by which contract the caller named is a different
 * representation for each value of that header, and a shared cache that does
 * not know it would hand one contract's shape to another's callers.
 */
export function appendVary(headers: Headers, names: readonly string[]): void {
  if (names.length === 0) return;
  const current = headers.get("vary");
  if (current?.trim() === "*") return;
  const held = new Set(
    (current ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  const missing = names.filter((name) => !held.has(name.toLowerCase()));
  if (missing.length === 0) return;
  headers.set("vary", [...(current ? [current] : []), ...missing].join(", "));
}
