/**
 * A response field whose vocabulary grew, and the one decision that fixes it.
 *
 * This is the commonest breaking change in the wild. Across 686 published
 * version pairs it is the largest single category, and it is two thirds of
 * everything Stripe does to its callers: a response enum gains a value that a
 * caller written against the old contract has never heard of.
 *
 * It used to be reported as inexpressible. It is not. `enumMap` takes a `fold`
 * that says which existing value an old caller should be shown instead, and the
 * runtime applies it on the way out. What cannot be read off the documents is
 * *which* existing value, because that is a judgement about meaning rather than
 * a fact about shape.
 *
 * So this file does not guess. It names the decision, lists exactly which
 * values are available to fold onto, and writes the lines out so that making
 * the decision is editing one placeholder rather than learning a format. The
 * release stays blocked until someone does, which is the point: the provider
 * makes the change and the caller pays for it, so the provider is the one who
 * should have to say what the caller sees.
 */
import type { SchemaDelta } from "./candidates.ts";

export interface FoldDecision {
  schema: string;
  field: string;
  pointer: string;
  /** Values the new contract can produce and the old one cannot name. */
  gained: string[];
  /** Values the old contract names. Each gained value folds onto one of these. */
  choices: string[];
  /** Why this is a decision rather than something derivable. */
  why: string;
  /** Lines to paste into a Change file, with one placeholder per gained value. */
  scaffold: string;
}

const PLACEHOLDER = "CHOOSE_ONE";

function yamlPairs(pairs: readonly (readonly [string, string])[]): string {
  return pairs.map(([a, b]) => `      - [${a}, ${b}]`).join("\n");
}

/**
 * One decision per response field that gained values and lost none.
 *
 * Losing values at the same time is a different question: the old values still
 * have to go somewhere, which is what `pairs` is for, and pairing them is the
 * alignment problem rather than this one. Mixing the two into a single prompt
 * would ask the provider two things at once and get a worse answer to both.
 */
export function foldDecisions(deltas: readonly SchemaDelta[]): FoldDecision[] {
  const out: FoldDecision[] = [];

  for (const delta of deltas) {
    for (const { old: before, new: after } of delta.altered) {
      const from = before.enumValues;
      const to = after.enumValues;
      if (!from || !to || from.length === 0) continue;

      const gained = to.filter((value) => !from.includes(value));
      const lost = from.filter((value) => !to.includes(value));
      if (gained.length === 0 || lost.length > 0) continue;

      out.push({
        schema: delta.schema,
        field: before.name,
        pointer: before.pointer,
        gained,
        choices: from,
        why:
          `\`${before.name}\` can now answer with ` +
          `${gained.map((value) => `\`${value}\``).join(", ")}, which the old ` +
          "contract never named. A caller that switches on this field has no " +
          "branch for it. Which of its own values it should be shown instead is " +
          "a decision about meaning, so it is not derivable from the two documents.",
        scaffold: [
          "  - op: convert",
          `    path: ${before.pointer}`,
          "    codec:",
          "      kind: enumMap",
          "      pairs:",
          yamlPairs(from.map((value) => [value, value] as const)),
          `      # One line per new value. Replace ${PLACEHOLDER} with one of: ` +
            from.join(", "),
          "      fold:",
          yamlPairs(gained.map((value) => [value, PLACEHOLDER] as const)),
        ].join("\n"),
      });
    }
  }

  return out;
}
