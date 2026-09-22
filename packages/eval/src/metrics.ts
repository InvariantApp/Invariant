/**
 * What "better" means, stated before anything is measured.
 *
 * Aggregate accuracy is close to useless here. A judge that answers every case
 * at 70% is worse than one that answers half at 99% and hands the rest on,
 * because the second one can be trusted with the half it takes. So the headline
 * numbers are selective: accuracy among the cases a judge actually answered,
 * and how much of the corpus that was.
 *
 * Calibration gets its own number because the whole pipeline leans on it. If a
 * judge's high-confidence answers are no better than its low-confidence ones,
 * then a confidence threshold is decoration.
 */
import type { JudgeResult } from "@invariant-app/proposer";
import type { EvalCase } from "./corpus.ts";

export interface Outcome {
  caseId: string;
  /** `mined:<url>` when a real provider shipped this change, else undefined. */
  source?: string | undefined;
  tags: string[];
  expected: string | null;
  actual: string | null;
  correct: boolean;
  abstained: boolean;
  confidence: number;
  latencyMs: number;
  costUsd: number;
}

export interface Metrics {
  total: number;
  answered: number;
  /** Share of the corpus the judge was willing to answer. */
  coverage: number;
  /** Accuracy among answered cases. The number that decides trust. */
  selectiveAccuracy: number;
  /** Accuracy if a wrong answer and an abstention count the same. */
  overallAccuracy: number;
  /** Answered, confidently, and wrong. The expensive mistake. */
  confidentlyWrong: number;
  p50LatencyMs: number;
  totalCostUsd: number;
}

export interface CalibrationBin {
  lowerBound: number;
  answered: number;
  accuracy: number;
}

export function outcomesOf(
  cases: readonly EvalCase[],
  results: readonly JudgeResult[],
): Outcome[] {
  return cases.map((testCase, index) => {
    const result = results[index];
    const answer = result?.answer;
    const actual = answer?.abstained ? null : (answer?.successor ?? null);
    return {
      caseId: testCase.id,
      source: testCase.source,
      tags: testCase.tags,
      expected: testCase.successor,
      actual,
      correct: !answer?.abstained && actual === testCase.successor,
      abstained: answer?.abstained ?? true,
      confidence: answer?.confidence ?? 0,
      latencyMs: result?.latencyMs ?? 0,
      costUsd: result?.costUsd ?? 0,
    };
  });
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

export function summarize(outcomes: readonly Outcome[], confidenceFloor = 0): Metrics {
  const considered = outcomes.filter(
    (outcome) => !outcome.abstained && outcome.confidence >= confidenceFloor,
  );

  return {
    total: outcomes.length,
    answered: considered.length,
    coverage: outcomes.length === 0 ? 0 : considered.length / outcomes.length,
    selectiveAccuracy:
      considered.length === 0
        ? 0
        : considered.filter((outcome) => outcome.correct).length / considered.length,
    overallAccuracy:
      outcomes.length === 0
        ? 0
        : outcomes.filter((outcome) => outcome.correct).length / outcomes.length,
    confidentlyWrong: considered.filter((outcome) => !outcome.correct).length,
    p50LatencyMs: median(outcomes.map((outcome) => outcome.latencyMs)),
    totalCostUsd: outcomes.reduce((sum, outcome) => sum + outcome.costUsd, 0),
  };
}

/** Accuracy by confidence band, which is what makes a threshold defensible. */
export function calibration(outcomes: readonly Outcome[], bins = 5): CalibrationBin[] {
  const answered = outcomes.filter((outcome) => !outcome.abstained);
  return Array.from({ length: bins }, (_unused, index) => {
    const lowerBound = index / bins;
    const upperBound = (index + 1) / bins;
    const inBin = answered.filter(
      (outcome) =>
        outcome.confidence >= lowerBound &&
        (outcome.confidence < upperBound ||
          (index === bins - 1 && outcome.confidence <= 1)),
    );
    return {
      lowerBound,
      answered: inBin.length,
      accuracy:
        inBin.length === 0
          ? 0
          : inBin.filter((outcome) => outcome.correct).length / inBin.length,
    };
  });
}

export function byTag(outcomes: readonly Outcome[]): Map<string, Metrics> {
  const tags = new Set(outcomes.flatMap((outcome) => outcome.tags));
  const out = new Map<string, Metrics>();
  for (const tag of [...tags].sort()) {
    out.set(tag, summarize(outcomes.filter((outcome) => outcome.tags.includes(tag))));
  }
  return out;
}

/**
 * The same metrics, split by where the cases came from.
 *
 * Reported separately and never added together. A corpus somebody wrote
 * measures the questions they thought to ask; only changes a provider actually
 * shipped say anything about how the work really arrives, and a single number
 * over both would let the easier half carry the harder one.
 */
export function bySource(outcomes: readonly Outcome[]): Map<string, Metrics> {
  const out = new Map<string, Metrics>();
  const mined = outcomes.filter((outcome) => outcome.source?.startsWith("mined:"));
  const written = outcomes.filter((outcome) => !outcome.source?.startsWith("mined:"));
  if (mined.length > 0) out.set("mined from real changelogs", summarize(mined));
  if (written.length > 0) out.set("written for this corpus", summarize(written));
  return out;
}

export type Verdict = "owns" | "assists" | "rejected";

export interface OwnershipVerdict {
  judge: string;
  verdict: Verdict;
  reason: string;
  metrics: Metrics;
}

export interface OwnershipPolicy {
  /** Selective accuracy a judge must reach to own a question outright. */
  requiredAccuracy: number;
  /** And it has to answer enough of the corpus to be worth having. */
  requiredCoverage: number;
  /** Below this it is not even useful as a first pass. */
  minimumUsefulAccuracy: number;
}

export const DEFAULT_POLICY: OwnershipPolicy = {
  requiredAccuracy: 0.95,
  requiredCoverage: 0.5,
  minimumUsefulAccuracy: 0.8,
};

/**
 * Decides what a judge is allowed to do, from its numbers alone.
 *
 * "Owns" means its drafts go straight into the pull request for a person to
 * review. "Assists" means it may rank candidates and route, but something else
 * decides. "Rejected" means it is not used for this question at all.
 */
export function ownership(
  judge: string,
  metrics: Metrics,
  policy: OwnershipPolicy = DEFAULT_POLICY,
): OwnershipVerdict {
  const accuracy = (metrics.selectiveAccuracy * 100).toFixed(1);

  if (metrics.answered === 0) {
    return {
      judge,
      verdict: "rejected",
      reason: "answered nothing, so there is no evidence either way",
      metrics,
    };
  }
  if (metrics.selectiveAccuracy < policy.minimumUsefulAccuracy) {
    return {
      judge,
      verdict: "rejected",
      reason: `${accuracy}% of its answers were right, below the ${(policy.minimumUsefulAccuracy * 100).toFixed(0)}% floor`,
      metrics,
    };
  }
  if (
    metrics.selectiveAccuracy >= policy.requiredAccuracy &&
    metrics.coverage >= policy.requiredCoverage
  ) {
    return {
      judge,
      verdict: "owns",
      reason: `${accuracy}% right across ${(metrics.coverage * 100).toFixed(0)}% of the corpus`,
      metrics,
    };
  }
  return {
    judge,
    verdict: "assists",
    reason:
      metrics.coverage < policy.requiredCoverage
        ? `${accuracy}% right, but only answered ${(metrics.coverage * 100).toFixed(0)}% of the corpus`
        : `${accuracy}% right, short of the ${(policy.requiredAccuracy * 100).toFixed(0)}% needed to decide alone`,
    metrics,
  };
}
