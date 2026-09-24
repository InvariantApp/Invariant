/**
 * Running a judge over the corpus.
 *
 * Answers are cached on disk keyed by the question and the model that answered
 * it. That makes a run in CI free, offline and deterministic, and it means a
 * regression is a real change in the judge rather than the weather. Recording
 * fresh answers is a deliberate act, not something that happens because a test
 * ran.
 *
 * The cache stores the model id that actually answered, because an alias moves
 * and a threshold tuned against one version is not evidence about another.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AlignmentQuestion, Judge, JudgeResult } from "@invariant-app/proposer";
import { type EvalCase, questionOf } from "./corpus.ts";

export interface RunOptions {
  /** Where recorded answers live. */
  cacheDir: string;
  /** Call the judge for anything not cached. Off means cache-only. */
  record?: boolean;
}

interface CachedResult {
  answer: JudgeResult["answer"];
  model: string | undefined;
  latencyMs: number;
  inputTokens: number;
  costUsd: number;
}

function keyOf(judge: Judge, question: AlignmentQuestion): string {
  const shape = JSON.stringify({
    // What the judge is, not just what it is called. A judge whose tables,
    // prompt or model have moved is a different judge, and reusing its old
    // answers reports on code that is no longer there.
    judge: judge.fingerprint,
    schema: question.schema,
    removed: question.removed,
    candidates: question.candidates,
    context: question.context ?? null,
  });
  return `${judge.id}-${createHash("sha256").update(shape).digest("hex").slice(0, 32)}`;
}

async function readCached(path: string): Promise<CachedResult | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as CachedResult;
  } catch {
    return undefined;
  }
}

export interface RunResult {
  results: JudgeResult[];
  /** Cases that had no recorded answer and could not be asked for one. */
  missing: string[];
  fromCache: number;
  recorded: number;
  /** The recorded answers this run is keyed on, whether or not they exist yet. */
  files: string[];
  /** Why requests failed, once each, where any did; those cases are missing. */
  failures: string[];
}

export async function runJudge(
  judge: Judge,
  cases: readonly EvalCase[],
  options: RunOptions,
): Promise<RunResult> {
  await mkdir(options.cacheDir, { recursive: true });

  const questions = cases.map(questionOf);
  const paths = questions.map((question) =>
    join(options.cacheDir, `${keyOf(judge, question)}.json`),
  );
  const cached = await Promise.all(paths.map(readCached));

  const pending: number[] = [];
  cached.forEach((entry, index) => {
    if (!entry) pending.push(index);
  });

  const missing: string[] = [];
  const failures = new Set<string>();
  let recorded = 0;

  if (pending.length > 0) {
    if (!options.record) {
      for (const index of pending) missing.push((cases[index] as EvalCase).id);
    } else {
      const answers = await judge.align(
        pending.map((index) => questions[index] as AlignmentQuestion),
      );
      await Promise.all(
        pending.map(async (index, position) => {
          const result = answers[position];
          if (!result) return;
          // A request that failed is not an answer to the question: recorded,
          // it would be replayed as the judge declining on every later run.
          if (result.failure !== undefined) {
            missing.push((cases[index] as EvalCase).id);
            failures.add(result.failure);
            return;
          }
          cached[index] = {
            answer: result.answer,
            model: result.model,
            latencyMs: result.latencyMs,
            inputTokens: result.inputTokens,
            costUsd: result.costUsd,
          };
          await writeFile(
            paths[index] as string,
            `${JSON.stringify(cached[index], null, 2)}\n`,
          );
          recorded += 1;
        }),
      );
    }
  }

  const results: JudgeResult[] = cases.map((_testCase, index) => {
    const entry = cached[index];
    if (!entry) {
      return {
        answer: {
          successor: null,
          confidence: 0,
          scores: {},
          stated: false,
          abstained: true,
        },
        judge: judge.id,
        model: undefined,
        latencyMs: 0,
        inputTokens: 0,
        costUsd: 0,
      };
    }
    return { ...entry, judge: judge.id };
  });

  return {
    results,
    missing,
    fromCache: cases.length - recorded - missing.length,
    recorded,
    files: paths,
    failures: [...failures],
  };
}
