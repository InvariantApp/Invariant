/**
 * Which way a bound on a value moved: the one question `relax` turns on,
 * shared by the compiler that refuses a narrowed request and the proposer
 * that drafts a widened response.
 */
import type { JsonValue } from "./json.ts";

const UPPER = new Set([
  "maximum",
  "exclusiveMaximum",
  "maxLength",
  "maxItems",
  "maxProperties",
]);
const LOWER = new Set([
  "minimum",
  "exclusiveMinimum",
  "minLength",
  "minItems",
  "minProperties",
]);

/** Numeric formats and the wider ones that hold every value they do. */
const WIDER_FORMATS: Record<string, string[]> = {
  int32: ["int64"],
  float: ["double"],
};

/**
 * Whether moving a bound from `before` to `after` rules out a value that was
 * allowed. A bound that appears narrows; one that goes widens. A pattern or a
 * format that changes at all is taken to narrow, since nothing here can
 * compare two of them, except a numeric format moving to one that holds it;
 * a new `multipleOf` narrows unless it divides the old one.
 */
export function narrows(
  keyword: string,
  before: JsonValue | undefined,
  after: JsonValue,
): boolean {
  if (after === null) return false;
  if (keyword === "type") {
    // Types a value may now be narrow only where one it could be is gone,
    // or where it stated none and could be anything; a whole number is also
    // a number.
    if (!Array.isArray(after) || before === undefined || before === null) {
      return after !== before;
    }
    const was = Array.isArray(before) ? before : [before];
    return was.some(
      (type) =>
        !after.includes(type) && !(type === "integer" && after.includes("number")),
    );
  }
  if (keyword === "enum") {
    // A vocabulary narrows when a value it allowed is gone from it.
    if (!Array.isArray(after)) return true;
    if (!Array.isArray(before)) return true;
    const kept = new Set(after.map((value) => JSON.stringify(value)));
    return before.some((value) => !kept.has(JSON.stringify(value)));
  }
  if (before === undefined || before === null)
    return keyword !== "uniqueItems" || after === true;
  if (UPPER.has(keyword)) return Number(after) < Number(before);
  if (LOWER.has(keyword)) return Number(after) > Number(before);
  if (keyword === "multipleOf") return Number(before) % Number(after) !== 0;
  if (keyword === "uniqueItems") return after === true && before !== true;
  if (keyword === "format" && typeof before === "string" && typeof after === "string") {
    return after !== before && !(WIDER_FORMATS[before] ?? []).includes(after);
  }
  return after !== before;
}

/**
 * Whether a bound that moved could both rule out a value it allowed and allow
 * one it ruled out: a pattern or a format replaced by another that nothing
 * here can compare with it, as Twilio's phone number `capabilities` went from
 * a `string-map` to `phone-number-capabilities`. Read as narrowing alone, a
 * response that may now carry values outside the old claim was not declared.
 */
export function movesBothWays(
  keyword: string,
  before: JsonValue | undefined,
  after: JsonValue,
): boolean {
  if (keyword !== "pattern" && keyword !== "format") return false;
  if (typeof before !== "string" || typeof after !== "string" || before === after) {
    return false;
  }
  if (keyword === "format") {
    return !(
      (WIDER_FORMATS[before] ?? []).includes(after) ||
      (WIDER_FORMATS[after] ?? []).includes(before)
    );
  }
  return true;
}

/**
 * Whether a vocabulary gained a value. A response that can hold a value its
 * old callers never heard of is a fold decision, which shows them one they
 * know, and never something `relax` may wave through.
 */
export function vocabularyGrows(
  before: JsonValue | undefined,
  after: JsonValue,
): boolean {
  if (!Array.isArray(after)) return Array.isArray(before);
  if (!Array.isArray(before)) return false;
  const held = new Set(before.map((value) => JSON.stringify(value)));
  return after.some((value) => !held.has(JSON.stringify(value)));
}
