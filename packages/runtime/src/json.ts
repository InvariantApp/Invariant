/**
 * JSON that keeps money exact.
 *
 * The important guarantee is that `49.99` scaled to minor units is `4999`, not
 * `4998.9999999999995`. That comes from doing the arithmetic on the decimal
 * text rather than on the double, and `String(value)` recovers that text
 * exactly for every number a double represents, which is every JSON number of
 * up to 15 significant digits.
 *
 * Node can also hand back the original source text of every number, which
 * preserves precision beyond what a double holds. That is switched off by
 * default, for two measured reasons. It costs roughly six times a plain parse,
 * because passing any reviver to `JSON.parse` leaves the fast path. And it buys
 * nothing on its own: the provider's handler parses the body it is given with
 * an ordinary parse, so precision the adapter preserved would be lost one step
 * later anyway. A provider that really does read bodies with arbitrary
 * precision can turn it on.
 */
import { numberToDecimalText } from "@invariant-app/decimal";
import { BodyTooDeepError } from "./errors.ts";

export type Json = unknown;

/**
 * How much numeric fidelity a body is parsed with.
 *
 * `double` is exact for every amount a double can hold and costs nothing extra.
 * `preserve` keeps the caller's original digits whatever their length.
 */
export type NumberFidelity = "double" | "preserve";

/**
 * A number that a double, or writing one back, would not keep as it was sent.
 *
 * `1e400` parses to Infinity and `1e-400` to 0, and Infinity is written back
 * as `null`, so a transform on such a body would change what the caller sent
 * without a word. Found by fuzzing. Nor does a double hold every integer:
 * past 2^53, which has sixteen digits, it rounds. Qdrant's own suite sends a
 * search `limit` of u64::MAX, 18446744073709551615, which came out of the
 * proxy as 18446744073709552000, no longer a u64, and the search was refused.
 *
 * And a double written back is spelled the shortest way: `1.0` comes out as
 * `1`, `1e99` as `1e+99`, `-0` as `0`. The value is the same, but not every
 * server reads only the value. Qdrant tells a list of vectors from other
 * inputs by how its numbers are written, and a multivector sent as
 * `[[1.0, 2.0, 3.0]]` stopped being one on its way through. A proxy changes
 * what it transforms and nothing else, so a body holding any number that
 * would be spelled differently takes the exact path too: a fraction that ends
 * in zero, an exponent, or a negative zero.
 *
 * The regular expression has no lookahead so that the Go engine's test can
 * hold its hand-written scanner to the very same pattern. What it matches
 * inside a string, such as a version called `1.0` or a card number, pays for
 * an exact parse and loses nothing.
 */
const EXACT_PARSE = /\d{16}|\.\d*0(?:[^\d]|$)|[\d.][eE]|-0(?:[^.\d]|$)/;

/**
 * How deeply a body may nest. Far beyond anything a real API sends: GitHub's
 * deepest responses nest a dozen levels.
 */
export const MAX_DEPTH = 256;

/** Whether a JSON text nests deeper than the limit, found in one pass without parsing. */
function tooDeep(text: string, limit: number): boolean {
  // Each level needs at least one character, so a short text cannot be.
  if (text.length <= limit) return false;
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (inString) {
      if (code === 0x5c) index += 1;
      else if (code === 0x22) inString = false;
      continue;
    }
    if (code === 0x22) inString = true;
    else if (code === 0x5b || code === 0x7b) {
      depth += 1;
      if (depth > limit) return true;
    } else if (code === 0x5d || code === 0x7d) depth -= 1;
  }
  return false;
}

export function parseJson(text: string, fidelity: NumberFidelity): Json {
  if (tooDeep(text, MAX_DEPTH)) throw new BodyTooDeepError(MAX_DEPTH);
  if (fidelity === "double" && !EXACT_PARSE.test(text)) return JSON.parse(text);

  return JSON.parse(text, function preserveNumbers(_key, value, context) {
    if (typeof value !== "number") return value;
    const source = (context as { source?: string } | undefined)?.source;
    return source === undefined ? value : JSON.rawJSON(source);
  });
}

export function stringifyJson(value: Json): string {
  return JSON.stringify(value) ?? "null";
}

export function isNumberLike(value: unknown): boolean {
  return typeof value === "number" || JSON.isRawJSON(value);
}

/**
 * The exact decimal text of a numeric value, whatever form it is held in.
 *
 * For a plain number this is the shortest text that reads back as the same
 * double, which is precisely the value the caller sent.
 */
export function numberTextOf(value: unknown): string {
  if (JSON.isRawJSON(value)) return (value as { rawJSON: string }).rawJSON;
  if (typeof value === "number") return numberToDecimalText(value);
  throw new TypeError("Not a number");
}

/** Builds a JSON number from exact decimal text, without going through a double. */
export function numberFromText(text: string): unknown {
  return JSON.rawJSON(text);
}
