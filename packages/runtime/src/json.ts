/**
 * JSON that keeps the number the caller actually wrote.
 *
 * `JSON.parse` turns every number into a double before a transform ever sees
 * it, which is the wrong place to lose information when the value is money.
 * Node's source-text reviver hands back the original digits, and `JSON.rawJSON`
 * puts them back unchanged, so a body that is not touched comes out byte for
 * byte as it went in.
 *
 * The reviver costs something, so it is used only where the compiled program
 * actually contains numeric work. Everywhere else, parsing stays ordinary.
 */
import { numberToDecimalText } from "@invariant/decimal";

export type Json = unknown;

export function parseJson(text: string, preserveNumbers: boolean): Json {
  if (!preserveNumbers) return JSON.parse(text);
  return JSON.parse(text, function reviveNumbers(_key, value, context) {
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

/** The exact decimal text of a numeric value, whatever form it is held in. */
export function numberTextOf(value: unknown): string {
  if (JSON.isRawJSON(value)) return (value as { rawJSON: string }).rawJSON;
  if (typeof value === "number") return numberToDecimalText(value);
  throw new TypeError("Not a number");
}

/** Builds a JSON number from exact decimal text, without going through a double. */
export function numberFromText(text: string): unknown {
  return JSON.rawJSON(text);
}
