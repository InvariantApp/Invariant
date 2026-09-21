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
