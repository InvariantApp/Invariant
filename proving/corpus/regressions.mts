/**
 * What got worse since the recorded run.
 *
 * Compared pair by pair rather than by headline percentage, so that growing
 * the corpus cannot hide a pair that used to work, and a regression names the
 * pair it happened on instead of moving a number by a tenth of a point.
 *
 * A pair that ran out of its time budget is not counted as a regression: the
 * budget is wall-clock, and a slower runner is not a worse product. It is
 * listed so it is seen.
 *
 * Nor is breakage that was always there and is only now seen. Lining up a
 * moved endpoint lets the differ look inside it, so a pair can go from 19
 * breaking deltas, all explained by the move, to 105 with 52 unexplained.
 * That pair explains more than it did. Unexplained breakage counts against a
 * pair only where it grew by more than the breakage the run can now see.
 */
import type { PairResult } from "@invariant/eval";

export interface Comparison {
  regressions: string[];
  /** Differences worth reading that do not fail a run. */
  notes: string[];
}

const keyOf = (result: PairResult): string =>
  `${result.api} ${result.fromVersion} -> ${result.toVersion}`;

export function compareRuns(
  recorded: readonly PairResult[],
  current: readonly PairResult[],
): Comparison {
  const now = new Map(current.map((result) => [keyOf(result), result]));
  const regressions: string[] = [];
  const notes: string[] = [];

  for (const before of recorded) {
    const key = keyOf(before);
    const after = now.get(key);
    if (!after) {
      regressions.push(`${key}: recorded, but not run`);
      continue;
    }
    if (before.reached === "done" && after.reached !== "done") {
      if (after.reached === "budget") {
        notes.push(`${key}: ran out of its time budget, which it did not before`);
      } else {
        regressions.push(
          `${key}: stopped after ${after.reached}: ${(after.error ?? "").slice(0, 200)}`,
        );
      }
      continue;
    }
    if (before.reached !== "done" || after.reached !== "done") continue;
    const unexplained = after.breakingAfter - before.breakingAfter;
    const newlySeen = Math.max(0, after.breakingAligned - before.breakingAligned);
    if (unexplained > newlySeen) {
      regressions.push(
        `${key}: ${after.breakingAfter} breaking deltas left unexplained, was ${before.breakingAfter}`,
      );
    } else if (unexplained > 0) {
      notes.push(
        `${key}: ${after.breakingAfter} breaking deltas left unexplained, was ${before.breakingAfter}, of ${after.breakingAligned} now seen where ${before.breakingAligned} were`,
      );
    }
    if (after.compileIssues.length > 0 && before.compileIssues.length === 0) {
      regressions.push(
        `${key}: drafts no longer compile: ${after.compileIssues[0] ?? ""}`,
      );
    }
  }
  return { regressions, notes };
}
