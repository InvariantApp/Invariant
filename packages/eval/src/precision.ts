/**
 * L4b's judge half: precision per family, at the threshold each judge drafts
 * from.
 *
 * Precision is the share of answers above the threshold that were right. An
 * answer below it drafts nothing (the question goes to a person), so it is
 * neither right nor wrong here; how much is answered is reported beside it as
 * coverage, since a judge that answers nothing is precise and useless.
 *
 * Per family, because an aggregate lets the easy families carry the hard
 * ones: a hundred renames at 100% hide ten removals at 70%. Mined and written
 * cases are reported apart for the same reason.
 */
import {
  ANSWER_THRESHOLDS,
  JEV_MODEL,
  JevJudge,
  type Judge,
  RulesJudge,
  S2_MODEL,
  S2Judge,
} from "@invariant-app/proposer";
import type { EvalCase } from "./corpus.ts";
import { type Outcome, outcomesOf } from "./metrics.ts";
import { runJudge } from "./runner.ts";

export interface Precision {
  cases: number;
  answered: number;
  wrong: number;
  /** Right among answered; 1 when nothing was answered, which `answered` shows. */
  precision: number;
}

export interface JudgePrecision {
  judge: string;
  model: string | null;
  threshold: number;
  /** Cases with no recorded answer: a judge with any is not measured. */
  missing: number;
  overall: Precision;
  mined: Precision;
  written: Precision;
  byFamily: Record<string, Precision>;
  /** The wrong answers above the threshold, by case, so they can be argued with. */
  wrongCases: {
    id: string;
    said: string | null;
    expected: string | null;
    confidence: number;
  }[];
}

export interface CorpusShape {
  cases: number;
  mined: number;
  written: number;
  byFamily: Record<string, number>;
}

function precisionOf(outcomes: readonly Outcome[], threshold: number): Precision {
  const answered = outcomes.filter(
    (outcome) => !outcome.abstained && outcome.confidence >= threshold,
  );
  const wrong = answered.filter((outcome) => !outcome.correct).length;
  return {
    cases: outcomes.length,
    answered: answered.length,
    wrong,
    precision: answered.length === 0 ? 1 : (answered.length - wrong) / answered.length,
  };
}

const isMined = (outcome: Outcome) => outcome.source?.startsWith("mined:") === true;

export function judgePrecision(
  judge: string,
  model: string | null,
  outcomes: readonly Outcome[],
  threshold: number,
  missing: number,
): JudgePrecision {
  const families = [...new Set(outcomes.flatMap((outcome) => outcome.tags))].sort();
  return {
    judge,
    model,
    threshold,
    missing,
    overall: precisionOf(outcomes, threshold),
    mined: precisionOf(outcomes.filter(isMined), threshold),
    written: precisionOf(
      outcomes.filter((outcome) => !isMined(outcome)),
      threshold,
    ),
    byFamily: Object.fromEntries(
      families.map((family) => [
        family,
        precisionOf(
          outcomes.filter((outcome) => outcome.tags.includes(family)),
          threshold,
        ),
      ]),
    ),
    wrongCases: outcomes
      .filter(
        (outcome) =>
          !outcome.abstained && outcome.confidence >= threshold && !outcome.correct,
      )
      .map((outcome) => ({
        id: outcome.caseId,
        said: outcome.actual,
        expected: outcome.expected,
        confidence: Math.round(outcome.confidence * 1000) / 1000,
      })),
  };
}

export function corpusShape(cases: readonly EvalCase[]): CorpusShape {
  const mined = cases.filter((testCase) => testCase.source?.startsWith("mined:")).length;
  const byFamily: Record<string, number> = {};
  for (const testCase of cases) {
    for (const tag of testCase.tags) byFamily[tag] = (byFamily[tag] ?? 0) + 1;
  }
  return {
    cases: cases.length,
    mined,
    written: cases.length - mined,
    byFamily: Object.fromEntries(
      Object.entries(byFamily).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

export interface Measurement {
  corpus: CorpusShape;
  judges: JudgePrecision[];
}

/**
 * Every judge that drafts, from recorded answers alone, each held to the
 * threshold drafting uses for it. S2 is also the auto-provider the proving
 * ground answers decisions with, so its row is that precision too.
 */
export async function measureRecorded(
  cases: readonly EvalCase[],
  cacheDir: string,
): Promise<Measurement> {
  // Never asked anything: a question that reached this client would mean an
  // answer was missing from the cache, which is counted instead.
  const offline = {
    messages: {
      create: () => Promise.reject(new Error("measuring reads recorded answers only")),
    },
  };
  const judges: { judge: Judge; model: string | null }[] = [
    { judge: new RulesJudge(), model: null },
    { judge: new JevJudge(), model: JEV_MODEL },
    { judge: new S2Judge({ client: offline }), model: S2_MODEL },
  ];
  const measured: JudgePrecision[] = [];
  for (const { judge, model } of judges) {
    const run = await runJudge(judge, cases, { cacheDir });
    measured.push(
      judgePrecision(
        judge.id,
        model,
        outcomesOf(cases, run.results),
        ANSWER_THRESHOLDS[judge.id],
        run.missing.length,
      ),
    );
  }
  return { corpus: corpusShape(cases), judges: measured };
}
