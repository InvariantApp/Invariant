import type { PairResult } from "@invariant-app/eval";
import { describe, expect, it } from "vitest";
import { compareRuns } from "./regressions.mts";

const pair = (overrides: Partial<PairResult> = {}): PairResult => ({
  api: "acme",
  fromVersion: "1",
  toVersion: "2",
  reached: "done",
  deltas: 4,
  breakingBefore: 2,
  breakingAligned: 2,
  breakingAfter: 0,
  drafts: 2,
  unresolved: 0,
  impasses: 0,
  compileIssues: [],
  breakingKinds: {},
  unexplainedKinds: {},
  elapsedMs: 10,
  ...overrides,
});

describe("comparing a run with the recorded one", () => {
  it("finds nothing when nothing got worse, and ignores new pairs and improvements", () => {
    const recorded = [pair({ breakingAfter: 1 }), pair({ api: "b", reached: "load" })];
    const current = [pair(), pair({ api: "b" }), pair({ api: "new" })];
    expect(compareRuns(recorded, current)).toEqual({ regressions: [], notes: [] });
  });

  it("names a pair that stopped working, and why", () => {
    const { regressions } = compareRuns(
      [pair()],
      [pair({ reached: "load", error: "ENOENT: rename" })],
    );
    expect(regressions).toEqual(["acme 1 -> 2: stopped after load: ENOENT: rename"]);
  });

  it("counts more unexplained breaks and new compile failures", () => {
    const { regressions } = compareRuns(
      [pair()],
      [pair({ breakingAfter: 3, compileIssues: ["enumMap has no pairs"] })],
    );
    expect(regressions).toHaveLength(2);
  });

  it("notes, without failing, unexplained breakage that is only newly seen", () => {
    const before = pair({ breakingAligned: 19, breakingAfter: 0 });
    expect(
      compareRuns([before], [pair({ breakingAligned: 105, breakingAfter: 52 })]),
    ).toEqual({
      regressions: [],
      notes: [
        "acme 1 -> 2: 52 breaking deltas left unexplained, was 0, of 105 now seen where 19 were",
      ],
    });
    expect(
      compareRuns([before], [pair({ breakingAligned: 30, breakingAfter: 12 })])
        .regressions,
    ).toEqual(["acme 1 -> 2: 12 breaking deltas left unexplained, was 0"]);
  });

  it("counts a pair that was recorded and not run", () => {
    expect(compareRuns([pair()], []).regressions).toEqual([
      "acme 1 -> 2: recorded, but not run",
    ]);
  });

  it("notes, without failing, a pair that ran out of time", () => {
    expect(compareRuns([pair()], [pair({ reached: "budget" })])).toEqual({
      regressions: [],
      notes: ["acme 1 -> 2: ran out of its time budget, which it did not before"],
    });
  });
});
