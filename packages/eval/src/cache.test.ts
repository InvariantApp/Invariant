/**
 * The cache, and the way it used to lie.
 *
 * Judge answers are recorded to disk so that continuous integration can replay
 * them for free and deterministically. That is the right design and it had a
 * hole in it: the key was the judge's *name* and the question, so a change to
 * the rules judge's tables, to the wording Jev is asked with, or to the pinned
 * model version, all left every recorded answer looking current.
 *
 * Which means the evaluation could report numbers describing code nobody was
 * running any more, and stay green while doing it. For a harness whose whole
 * job is to decide which judge is allowed to draft changes, that is the worst
 * available failure: not being wrong, but being confidently out of date.
 *
 * It was found the way these things should be found. Deleting the cache by hand
 * moved the rules judge from 100% to 96.2%, on a corpus and an implementation
 * that had not changed since the cached answers were written.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AlignmentQuestion, Judge, JudgeResult } from "@invariant-app/proposer";
import { afterEach, describe, expect, it } from "vitest";
import type { EvalCase } from "./corpus.ts";
import { runJudge } from "./runner.ts";

let scratch: string | undefined;

afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/** A judge whose answer and fingerprint are both under the test's control. */
class StubJudge implements Judge {
  readonly id = "rules" as const;
  calls = 0;

  readonly fingerprint: string;
  readonly #successor: string;

  constructor(fingerprint: string, successor: string) {
    this.fingerprint = fingerprint;
    this.#successor = successor;
  }

  align(questions: readonly AlignmentQuestion[]): Promise<JudgeResult[]> {
    this.calls += questions.length;
    return Promise.resolve(
      questions.map(() => ({
        answer: {
          successor: this.#successor,
          confidence: 1,
          scores: {},
          stated: false,
          abstained: false,
        },
        judge: "rules" as const,
        model: undefined,
        latencyMs: 0,
        inputTokens: 0,
        costUsd: 0,
      })),
    );
  }
}

const CASES: EvalCase[] = [
  {
    id: "amount_to_cents",
    tags: ["unit"],
    schema: "Payment",
    operations: ["payments.create request"],
    removed: {
      name: "amount",
      pointer: "/amount",
      type: "number",
      format: undefined,
      enumValues: undefined,
      description: undefined,
      required: true,
      nullable: false,
    },
    candidates: [
      {
        name: "amount_cents",
        pointer: "/amount_cents",
        type: "integer",
        format: undefined,
        enumValues: undefined,
        description: undefined,
        required: true,
        nullable: false,
      },
      {
        name: "currency",
        pointer: "/currency",
        type: "string",
        format: undefined,
        enumValues: undefined,
        description: undefined,
        required: true,
        nullable: false,
      },
    ],
    successor: "amount_cents",
    rationale: "test",
  },
];

describe("replaying recorded answers", () => {
  it("reuses a recording when nothing about the judge moved", async () => {
    scratch = await mkdtemp(join(tmpdir(), "invariant-eval-cache-"));
    const judge = new StubJudge("rules:v1", "amount_cents");

    const first = await runJudge(judge, CASES, { cacheDir: scratch, record: true });
    expect(first.recorded).toBe(1);

    const again = await runJudge(judge, CASES, { cacheDir: scratch, record: true });
    expect(again.fromCache).toBe(1);
    // The point of the cache: continuous integration pays nothing to replay it.
    expect(judge.calls).toBe(1);
  });

  /**
   * The bug. Same name, same question, different judge, and the old answer
   * used to come straight back as though it described the new one.
   */
  it("refuses a recording made by a judge that has since changed", async () => {
    scratch = await mkdtemp(join(tmpdir(), "invariant-eval-cache-"));

    const before = new StubJudge("rules:v1", "amount_cents");
    await runJudge(before, CASES, { cacheDir: scratch, record: true });

    // The tables moved and the judge now answers differently.
    const after = new StubJudge("rules:v2", "currency");
    const run = await runJudge(after, CASES, { cacheDir: scratch, record: true });

    expect(run.fromCache).toBe(0);
    expect(run.recorded).toBe(1);
    expect(run.results[0]?.answer.successor).toBe("currency");
  });

  /**
   * And the shape the failure actually takes in CI, where recording is off.
   *
   * Reporting a stale answer here would be worse than reporting nothing: the
   * run would pass, and the metrics would describe an implementation that no
   * longer exists.
   */
  it("reports a changed judge as unmeasured rather than as cached", async () => {
    scratch = await mkdtemp(join(tmpdir(), "invariant-eval-cache-"));

    await runJudge(new StubJudge("rules:v1", "amount_cents"), CASES, {
      cacheDir: scratch,
      record: true,
    });

    const replay = await runJudge(new StubJudge("rules:v2", "currency"), CASES, {
      cacheDir: scratch,
      record: false,
    });

    expect(replay.missing).toEqual(["amount_to_cents"]);
    expect(replay.fromCache).toBe(0);
  });

  it("gives two real judges different keys for the same question", () => {
    // Not a detail: the whole cache is one flat directory, so two judges that
    // hashed alike would answer for each other.
    expect(new StubJudge("rules:v1", "a").fingerprint).not.toBe(
      new StubJudge("rules:v2", "a").fingerprint,
    );
  });
});
