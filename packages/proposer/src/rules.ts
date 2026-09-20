/**
 * The deterministic judge, and the baseline every other judge has to beat.
 *
 * Most field renames are not semantically interesting. `amount` becomes
 * `amount_cents`, `source` becomes `source_token`, `created` becomes
 * `created_at`. A stem comparison and a table of unit suffixes settle those for
 * nothing, with no model and no network, and the evaluation harness exists
 * partly to find out how large "most" really is.
 *
 * What this cannot do is judge whether two differently named fields mean the
 * same thing. It abstains there rather than guessing, and abstaining cleanly is
 * what makes it a usable first stage.
 */
import { createHash } from "node:crypto";
import type { FieldShape } from "./candidates.ts";
import {
  type AlignmentQuestion,
  abstention,
  type Judge,
  type JudgeResult,
} from "./judge.ts";

/**
 * Suffixes, and whether they change what a field *is*.
 *
 * Two kinds were conflated here and the difference turns out to matter a great
 * deal. `amount` to `amount_cents` re-encodes one quantity: same thing, new
 * units. `seats` to `seats_at` does not - seats is a count and `seats_at` is a
 * time, and they are no more the same field than `price` and `price_changed_by`.
 *
 * Treating both as a stem match let the judge strip `_at` off any candidate,
 * declare a perfect match with the removed field, and answer at full
 * confidence. Against `lag` with candidates `lag_seconds` and `lag_messages`,
 * it confidently picked the duration for a field counting messages. Against
 * `seats` with `seats_at` and `seat_count`, it picked the timestamp.
 *
 * So only re-encoding suffixes reduce a stem now. A concept-changing suffix
 * contributes a little, and never enough on its own to cross the threshold
 * this judge answers above.
 */
export type SuffixKind = "encoding" | "concept";

export const UNIT_SUFFIXES: ReadonlyMap<
  string,
  { kind: string; detail: string; changes: SuffixKind }
> = new Map([
  [
    "cents",
    { kind: "scale10", detail: "minor currency units, exponent 2", changes: "encoding" },
  ],
  [
    "minor",
    { kind: "scale10", detail: "minor currency units, exponent 2", changes: "encoding" },
  ],
  ["ms", { kind: "scale10", detail: "milliseconds", changes: "encoding" }],
  ["millis", { kind: "scale10", detail: "milliseconds", changes: "encoding" }],
  ["seconds", { kind: "scale10", detail: "seconds", changes: "encoding" }],
  ["str", { kind: "cast", detail: "string encoded", changes: "encoding" }],
  ["string", { kind: "cast", detail: "string encoded", changes: "encoding" }],
  // A timestamp of a thing is not that thing, and nor is its identifier.
  ["at", { kind: "timestamp", detail: "a timestamp", changes: "concept" }],
  ["id", { kind: "identifier", detail: "an identifier", changes: "concept" }],
  ["token", { kind: "identifier", detail: "an opaque token", changes: "concept" }],
]);

const NUMERIC = new Set(["integer", "number"]);

function parts(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part !== "");
}

/**
 * A field's name with any trailing *re-encoding* marker removed.
 *
 * Concept-changing suffixes are deliberately left on. Stripping them is what
 * let a timestamp be mistaken for the thing it is a timestamp of.
 */
export function stemOf(name: string): string {
  const segments = parts(name);
  while (segments.length > 1) {
    const last = segments[segments.length - 1] as string;
    if (UNIT_SUFFIXES.get(last)?.changes !== "encoding") break;
    segments.pop();
  }
  return segments.join("_");
}

/** Longest common subsequence length, as a fraction of the longer string. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint16Array(rows * cols);
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      table[i * cols + j] =
        a[i - 1] === b[j - 1]
          ? (table[(i - 1) * cols + (j - 1)] as number) + 1
          : Math.max(
              table[(i - 1) * cols + j] as number,
              table[i * cols + (j - 1)] as number,
            );
    }
  }
  return (table[rows * cols - 1] as number) / Math.max(a.length, b.length);
}

export interface RuleScore {
  score: number;
  /** Why, in words a person can check. */
  reasons: string[];
}

/** Scores one candidate against the removed field, deterministically. */
export function scorePair(removed: FieldShape, candidate: FieldShape): RuleScore {
  const reasons: string[] = [];
  let score = 0;

  const removedStem = stemOf(removed.name);
  const candidateStem = stemOf(candidate.name);

  // The same name is the same field, and it has to outrank a suffix hint:
  // `reading` -> `reading` beats `reading` -> `reading_at`, even though the
  // second looks like the tidier rename.
  //
  // But only while the two could hold the same value. A name that now belongs
  // to a structurally different thing has been reused, not kept, and being
  // certain about it is how this judge came to say at full confidence that a
  // Unix timestamp became an expiry policy object while the timestamp itself
  // sat in the next candidate along. Where the types cannot be reconciled this
  // falls through to ordinary scoring, which weighs the descriptions and lets
  // the field that actually carries the value win.
  if (removed.name === candidate.name && typesInterchangeable(removed, candidate)) {
    return {
      score: 1,
      reasons: [`the field is still called "${candidate.name}"`],
    };
  }

  if (removedStem === candidateStem) {
    score += 0.6;
    reasons.push(`both names reduce to the stem "${removedStem}"`);
  } else {
    const closeness = similarity(removedStem, candidateStem);
    if (closeness >= 0.7) {
      score += 0.3 * closeness;
      reasons.push(
        `stems "${removedStem}" and "${candidateStem}" are ${Math.round(closeness * 100)}% alike`,
      );
    }
  }

  const suffix = parts(candidate.name).at(-1);
  // The same sentence describing both is the strongest evidence available
  // here, and it is evidence about meaning rather than about spelling. It is
  // what lets `created` and `created_at` be recognised as one field while
  // `seats` and `seats_at` are not: whoever wrote the specification said they
  // were the same thing.
  if (
    removed.description !== undefined &&
    removed.description.trim() !== "" &&
    removed.description.trim() === candidate.description?.trim()
  ) {
    score += 0.45;
    reasons.push("both fields carry the same description");
  }

  const unit = suffix === undefined ? undefined : UNIT_SUFFIXES.get(suffix);
  if (unit && removedStem === candidateStem) {
    score += 0.2;
    reasons.push(`the "${suffix}" suffix marks ${unit.detail}`);
  }

  if (removed.type === candidate.type) {
    score += 0.1;
    reasons.push(`both are ${String(removed.type)}`);
  } else if (
    removed.type !== undefined &&
    candidate.type !== undefined &&
    NUMERIC.has(removed.type) &&
    NUMERIC.has(candidate.type)
  ) {
    score += 0.05;
    reasons.push(`${removed.type} and ${candidate.type} are both numeric`);
  }

  if (removed.enumValues && candidate.enumValues) {
    const overlap = removed.enumValues.filter((value) =>
      candidate.enumValues?.includes(value),
    );
    if (overlap.length > 0) {
      score += 0.1 * (overlap.length / removed.enumValues.length);
      reasons.push(`${overlap.length} enum values are shared`);
    }
  }

  return { score: Math.min(1, score), reasons };
}

/**
 * Whether any codec in the catalog could carry one type into the other.
 *
 * Deliberately permissive: an unknown type on either side is not evidence of a
 * mismatch, and `cast` genuinely does move between strings and numbers. What it
 * refuses is the structural jump, because nothing converts a scalar into an
 * object or an object into an array, and no amount of shared spelling changes
 * that.
 */
function typesInterchangeable(left: FieldShape, right: FieldShape): boolean {
  const a = left.type;
  const b = right.type;
  if (a === undefined || b === undefined || a === b) return true;

  const structural = (type: string) => type === "object" || type === "array";
  if (structural(a) || structural(b)) return false;

  // Scalars, which `cast` and `scale10` move between.
  return true;
}

/** Whether `candidate` is `removed` with something appended, token by token. */
function extendsName(removed: string, candidate: string): boolean {
  const left = parts(removed);
  const right = parts(candidate);
  if (right.length <= left.length) return false;
  return left.every((segment, index) => right[index] === segment);
}

/** Threshold above which the rules judge is willing to answer at all. */
export const RULES_ANSWER_THRESHOLD = 0.6;

export class RulesJudge implements Judge {
  readonly id = "rules" as const;

  /**
   * The tables and the threshold, which between them decide every answer.
   *
   * Computed rather than written down, so it cannot be left stale. Adding a
   * suffix or moving the threshold changes it, which retires every cached
   * answer that the old version produced.
   */
  readonly fingerprint = `rules:${createHash("sha256")
    .update(
      JSON.stringify({
        suffixes: [...UNIT_SUFFIXES].sort(),
        threshold: RULES_ANSWER_THRESHOLD,
      }),
    )
    .digest("hex")
    .slice(0, 16)}`;

  align(questions: readonly AlignmentQuestion[]): Promise<JudgeResult[]> {
    return Promise.resolve(questions.map((question) => this.#one(question)));
  }

  #one(question: AlignmentQuestion): JudgeResult {
    const started = performance.now();

    // Several candidates that all extend the removed field's name is the one
    // situation morphology genuinely cannot settle. `lag` with `lag_seconds`
    // and `lag_messages` beside it could be a duration or a count, and the
    // only reason to prefer one is that this judge happens to recognise its
    // suffix - which is a fact about the suffix table, not about the API.
    //
    // An exact name match is excluded, because then the field simply kept its
    // name and the others are new fields that happen to be named after it.
    const siblings = question.candidates.filter((candidate) =>
      extendsName(question.removed.name, candidate.name),
    );
    if (
      siblings.length > 1 &&
      !question.candidates.some((candidate) => candidate.name === question.removed.name)
    ) {
      return { ...abstention("rules"), latencyMs: performance.now() - started };
    }

    const scores: Record<string, number> = {};
    for (const candidate of question.candidates) {
      scores[candidate.name] = scorePair(question.removed, candidate).score;
    }

    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const best = ranked[0];
    const runnerUp = ranked[1];

    if (!best || best[1] < RULES_ANSWER_THRESHOLD) {
      return { ...abstention("rules"), latencyMs: performance.now() - started };
    }

    // A clear winner is what this judge can speak to. Two plausible candidates
    // is exactly the ambiguity it was never going to resolve.
    const margin = best[1] - (runnerUp?.[1] ?? 0);
    if (margin < 0.15) {
      return { ...abstention("rules"), latencyMs: performance.now() - started };
    }

    return {
      answer: {
        successor: best[0],
        confidence: Math.min(1, best[1] * (0.7 + margin)),
        scores,
        stated: false,
        abstained: false,
      },
      judge: "rules",
      model: undefined,
      latencyMs: performance.now() - started,
      inputTokens: 0,
      costUsd: 0,
    };
  }
}
