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
import type { FieldShape } from "./candidates.ts";
import {
  type AlignmentQuestion,
  abstention,
  type Judge,
  type JudgeResult,
} from "./judge.ts";

/** Suffixes that encode a unit or representation rather than a different thing. */
export const UNIT_SUFFIXES: ReadonlyMap<string, { kind: string; detail: string }> =
  new Map([
    ["cents", { kind: "scale10", detail: "minor currency units, exponent 2" }],
    ["minor", { kind: "scale10", detail: "minor currency units, exponent 2" }],
    ["ms", { kind: "scale10", detail: "milliseconds" }],
    ["millis", { kind: "scale10", detail: "milliseconds" }],
    ["seconds", { kind: "scale10", detail: "seconds" }],
    ["at", { kind: "timestamp", detail: "a timestamp" }],
    ["id", { kind: "identifier", detail: "an identifier" }],
    ["token", { kind: "identifier", detail: "an opaque token" }],
    ["str", { kind: "cast", detail: "string encoded" }],
    ["string", { kind: "cast", detail: "string encoded" }],
  ]);

const NUMERIC = new Set(["integer", "number"]);

function parts(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part !== "");
}

/** A field's name with any trailing unit or representation marker removed. */
export function stemOf(name: string): string {
  const segments = parts(name);
  while (segments.length > 1) {
    const last = segments[segments.length - 1] as string;
    if (!UNIT_SUFFIXES.has(last)) break;
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

  // The same name is the same field, whatever else changed about it. This has
  // to outrank a suffix hint: `reading` -> `reading` beats `reading` ->
  // `reading_at`, even though the second looks like a tidy rename.
  if (removed.name === candidate.name) {
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

/** Threshold above which the rules judge is willing to answer at all. */
export const RULES_ANSWER_THRESHOLD = 0.6;

export class RulesJudge implements Judge {
  readonly id = "rules" as const;

  align(questions: readonly AlignmentQuestion[]): Promise<JudgeResult[]> {
    return Promise.resolve(questions.map((question) => this.#one(question)));
  }

  #one(question: AlignmentQuestion): JudgeResult {
    const started = performance.now();
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
