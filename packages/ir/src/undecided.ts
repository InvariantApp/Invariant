import type { Change } from "./change.ts";

/**
 * The placeholder a drafted decision carries where an answer belongs.
 *
 * A draft that needs a provider to choose a value is written with this in the
 * value's place, never with a guess, so the decision cannot be merged by
 * accident. Being a string, it would satisfy a string-typed field, so the
 * gate looks for it explicitly rather than relying on validation to fail: a
 * Change still carrying it is refused, whatever its op and whatever the field
 * it names.
 */
export const CHOOSE_ONE = "CHOOSE_ONE";

/** Whether a value holds the placeholder anywhere in it. */
function holdsPlaceholder(value: unknown): boolean {
  if (value === CHOOSE_ONE) return true;
  if (Array.isArray(value)) return value.some(holdsPlaceholder);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(holdsPlaceholder);
  }
  return false;
}

/** The ops of a Change that still wait for someone to answer them, by index. */
export function undecidedOps(change: Change): number[] {
  return change.ops.flatMap((op, index) => (holdsPlaceholder(op) ? [index] : []));
}
