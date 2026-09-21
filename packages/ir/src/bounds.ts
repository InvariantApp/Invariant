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

/**
 * Whether moving a bound from `before` to `after` rules out a value that was
 * allowed. A bound that appears narrows; one that goes widens. A pattern that
 * changes at all is taken to narrow, since nothing here can compare two
 * patterns, and a new `multipleOf` narrows unless it divides the old one.
 */
export function narrows(
  keyword: string,
  before: JsonValue | undefined,
  after: JsonValue,
): boolean {
  if (after === null) return false;
  if (before === undefined || before === null)
    return keyword !== "uniqueItems" || after === true;
  if (UPPER.has(keyword)) return Number(after) < Number(before);
  if (LOWER.has(keyword)) return Number(after) > Number(before);
  if (keyword === "multipleOf") return Number(before) % Number(after) !== 0;
  if (keyword === "uniqueItems") return after === true && before !== true;
  return after !== before;
}
