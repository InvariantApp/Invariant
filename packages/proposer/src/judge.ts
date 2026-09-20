/**
 * The Judge interface.
 *
 * Every semantic question in the system goes through this, and the three
 * implementations behind it (deterministic rules, Jev, a reasoning model) are
 * interchangeable on purpose. Which one owns which question is decided by the
 * evaluation harness against a labelled corpus, not by preference, and the
 * answer is recorded in `eval/ownership.yaml` where the proposer reads it.
 *
 * A judge never decides anything. It ranks candidates that deterministic code
 * enumerated, and its answer becomes a draft a person merges.
 */
import type { FieldShape, SchemaDelta } from "./candidates.ts";

export type JudgeId = "rules" | "jev" | "s2";

/** The one question worth asking: which added field replaced this removed one? */
export interface AlignmentQuestion {
  kind: "alignment";
  schema: string;
  operations: string[];
  removed: FieldShape;
  candidates: FieldShape[];
  /** Free text from the change's context, such as a pull request body. */
  context?: string;
}

export type Question = AlignmentQuestion;

export interface AlignmentAnswer {
  /** Name of the winning candidate, or null for "nothing replaced it". */
  successor: string | null;
  /** 0 to 1. What it means differs per judge, which is why it is calibrated. */
  confidence: number;
  /** Per-candidate scores, for calibration and for the report. */
  scores: Record<string, number>;
  /** True when the context states the mapping rather than the judge inferring it. */
  stated: boolean;
  /** Whether the judge declined to answer. */
  abstained: boolean;
}

export interface JudgeResult {
  answer: AlignmentAnswer;
  judge: JudgeId;
  model: string | undefined;
  latencyMs: number;
  inputTokens: number;
  costUsd: number;
}

export interface Judge {
  readonly id: JudgeId;
  /** Answers a batch. Batching matters: Jev prices and paces by request. */
  align(questions: readonly AlignmentQuestion[]): Promise<JudgeResult[]>;
}

/** Turns a schema delta into one question per removed field. */
export function questionsFor(delta: SchemaDelta, context?: string): AlignmentQuestion[] {
  if (delta.added.length === 0) return [];
  return delta.removed.map((removed) => ({
    kind: "alignment" as const,
    schema: delta.schema,
    operations: delta.operations,
    removed,
    candidates: delta.added,
    ...(context === undefined ? {} : { context }),
  }));
}

export function abstention(judge: JudgeId): JudgeResult {
  return {
    answer: {
      successor: null,
      confidence: 0,
      scores: {},
      stated: false,
      abstained: true,
    },
    judge,
    model: undefined,
    latencyMs: 0,
    inputTokens: 0,
    costUsd: 0,
  };
}
