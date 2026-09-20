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
import { numberToDecimalText } from "@invariant/decimal";

export type Json = unknown;

/**
 * How much numeric fidelity a body is parsed with.
 *
 * `double` is exact for every amount a double can hold and costs nothing extra.
 * `preserve` keeps the caller's original digits whatever their length.
 */
export type NumberFidelity = "double" | "preserve";

export function parseJson(text: string, fidelity: NumberFidelity): Json {
  if (fidelity === "double") return JSON.parse(text);

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
