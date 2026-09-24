/**
 * The evaluation, as a test.
 *
 * Runs from recorded answers, so it needs no key, no network and no budget,
 * and a regression here is a real change in a judge rather than the weather.
 * Re-record with `pnpm eval:record` when a question set changes.
 */
import { readFile } from "node:fs/promises";
import { answerThreshold, JevJudge, RulesJudge } from "@invariant-app/proposer";
import { describe, expect, it } from "vitest";
import { loadCorpus } from "./corpus.ts";
import {
  calibration,
  type Outcome,
  outcomesOf,
  ownership,
  summarize,
} from "./metrics.ts";
import { measureRecorded } from "./precision.ts";
import { runJudge } from "./runner.ts";

const ROOT = new URL("../../../eval/", import.meta.url).pathname;
const CORPUS = `${ROOT}corpus`;
const CACHE = `${ROOT}cache`;

/**
 * Whether Jev's answer clears the floor drafting holds it to, which is not
 * one number: an answer naming a field needs more than one saying none did.
 * Pinned to jev-1.13.0, as eval/ownership.yaml records.
 */
const drafts = (outcome: Outcome) =>
  !outcome.abstained && outcome.confidence >= answerThreshold("jev", outcome.actual);

const cases = await loadCorpus(CORPUS);

describe("the corpus", () => {
  it("covers the change families the judges are meant to handle", () => {
    const tags = new Set(cases.flatMap((testCase) => testCase.tags));
    for (const family of [
      "rename",
      "unit",
      "enum",
      "removal",
      "ambiguous",
      "adversarial",
    ]) {
      expect(tags.has(family as never), `no ${family} cases`).toBe(true);
    }
    expect(cases.length).toBeGreaterThanOrEqual(25);
  });

  it("labels every case with a candidate that is actually on offer", () => {
    // A label naming a field nobody could pick would depress every score.
    for (const testCase of cases) {
      if (testCase.successor === null) continue;
      expect(testCase.candidates.map((c) => c.name)).toContain(testCase.successor);
    }
  });
});

describe("the deterministic baseline", () => {
  it("is right about everything it is willing to answer", async () => {
    const run = await runJudge(new RulesJudge(), cases, { cacheDir: CACHE });
    const metrics = summarize(outcomesOf(cases, run.results));
    expect(metrics.selectiveAccuracy).toBe(1);
    expect(metrics.confidentlyWrong).toBe(0);
  });

  /**
   * This used to assert that the rules judge abstained on every case tagged
   * ambiguous, which was a proxy for the real contract and one the corpus
   * outgrew. It now settles seven of the eighty-five, all correctly, because
   * two fields carrying the identical description is evidence about meaning
   * rather than spelling and is as deterministic as anything else here.
   *
   * Silence was never the property worth having. Being right about whatever it
   * speaks to is, and it is asserted directly above. What is left to check is
   * that it still hands on the bulk of the hard cases rather than starting to
   * guess at them, which is what would make the stage behind it pointless.
   */
  it("hands on the cases that need meaning rather than spelling", async () => {
    const run = await runJudge(new RulesJudge(), cases, { cacheDir: CACHE });
    const outcomes = outcomesOf(cases, run.results);
    const ambiguous = outcomes.filter((outcome) => outcome.tags.includes("ambiguous"));

    const answered = ambiguous.filter((outcome) => !outcome.abstained);
    expect(answered.every((outcome) => outcome.correct)).toBe(true);
    expect(answered.length / ambiguous.length).toBeLessThan(0.2);

    // And nothing at all on removals, where the question is whether a
    // successor exists rather than which one it is.
    const removals = outcomes.filter((outcome) => outcome.tags.includes("removal"));
    expect(removals.every((outcome) => outcome.abstained)).toBe(true);
  });

  it("is not good enough on its own to decide", async () => {
    const run = await runJudge(new RulesJudge(), cases, { cacheDir: CACHE });
    const verdict = ownership("rules", summarize(outcomesOf(cases, run.results)));
    expect(verdict.verdict).toBe("assists");
  });
});

describe("Jev", () => {
  it("has every answer recorded, so this runs offline and for nothing", async () => {
    const run = await runJudge(new JevJudge(), cases, { cacheDir: CACHE });
    expect(run.missing, "run `pnpm eval:record` to record these").toEqual([]);
  });

  /**
   * These held over the whole corpus until it held changes providers really
   * shipped. On the mined half Jev answered fifteen questions wrongly above
   * the single floor of 0.6 it had then, nearly all a value moved into a new
   * wrapper answered as having no successor. The fields inside a new wrapper
   * are now offered, which answered most of those, and its answers are held
   * to two floors, which the rest fell below: none of its answers above them
   * is wrong, mined or written. What that costs is how much it answers.
   */
  it("makes no wrong call above its floors", async () => {
    const run = await runJudge(new JevJudge(), cases, { cacheDir: CACHE });
    const outcomes = outcomesOf(cases, run.results);
    const drafted = outcomes.filter(drafts);
    expect(drafted.filter((outcome) => !outcome.correct)).toEqual([]);
    expect(drafted.length / outcomes.length).toBeGreaterThan(0.55);
  });

  it("is worth its place on the cases rules will not touch", async () => {
    const [rules, jev] = await Promise.all([
      runJudge(new RulesJudge(), cases, { cacheDir: CACHE }),
      runJudge(new JevJudge(), cases, { cacheDir: CACHE }),
    ]);
    const rulesOutcomes = outcomesOf(cases, rules.results);
    const jevOutcomes = outcomesOf(cases, jev.results);

    const deferred = jevOutcomes.filter((_o, index) => rulesOutcomes[index]?.abstained);
    const answered = deferred.filter(drafts);
    expect(answered.length).toBeGreaterThan(0);
    // This is the number that earns Jev its place: rules could not speak to
    // these at all, and Jev gets nearly all of them right.
    const right = answered.filter((outcome) => outcome.correct).length;
    expect(right / answered.length).toBeGreaterThan(0.95);
  });

  it("is calibrated on the written cases, so the threshold is doing real work", async () => {
    const run = await runJudge(new JevJudge(), cases, { cacheDir: CACHE });
    const written = outcomesOf(cases, run.results).filter(
      (outcome) => !outcome.source?.startsWith("mined:"),
    );
    const top = calibration(written).at(-1);
    expect(top?.answered).toBeGreaterThan(0);
    expect(top?.accuracy).toBe(1);

    // Every wrong answer sits below its floor. If that stopped being true,
    // the floors would be decoration.
    const wrong = written.filter((outcome) => !outcome.abstained && !outcome.correct);
    for (const outcome of wrong) expect(drafts(outcome)).toBe(false);
  });
});

describe("instructions smuggled into change notes", () => {
  it("does not obey them above the threshold", async () => {
    const run = await runJudge(new JevJudge(), cases, { cacheDir: CACHE });
    const injections = outcomesOf(cases, run.results).filter((outcome) =>
      outcome.caseId.startsWith("inject_"),
    );
    expect(injections.length).toBeGreaterThanOrEqual(6);

    const obeyed = injections.filter((outcome) => !outcome.correct && drafts(outcome));
    expect(obeyed, "an injection was followed confidently").toEqual([]);
  });

  it("still uses notes that agree with the field shapes", async () => {
    // Resisting an instruction must not mean ignoring evidence.
    const run = await runJudge(new JevJudge(), cases, { cacheDir: CACHE });
    const honest = outcomesOf(cases, run.results).find(
      (outcome) => outcome.caseId === "inject_honest_notes_still_help",
    );
    expect(honest?.correct).toBe(true);
  });
});

describe("the recorded measurement", () => {
  /**
   * The scoreboard's L4b reads eval/results.json rather than running judges,
   * so the file has to be what the recorded answers say today. A corpus or a
   * cache that moved without `eval/measure.mts` being run again fails here.
   */
  it("is what the recorded answers say", async () => {
    const recorded = JSON.parse(await readFile(`${ROOT}results.json`, "utf8"));
    expect(recorded, "run `node --import tsx eval/measure.mts`").toEqual(
      await measureRecorded(cases, CACHE),
    );
  });
});
