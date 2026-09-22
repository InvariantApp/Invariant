import { describe, expect, it } from "vitest";
import { scoreboard } from "./scoreboard.mts";

/** A completed pair with this many breaking places, and what is left of them. */
const pair = (aligned: number, after: number, decided: number, behaviorOnly = 0) => ({
  api: "acme",
  provider: "acme.com",
  fromVersion: "1",
  toVersion: "2",
  reached: "done",
  deltas: aligned,
  breakingBefore: aligned,
  breakingAligned: aligned,
  breakingAfter: after,
  breakingAfterDecided: decided,
  drafts: 0,
  unresolved: 0,
  impasses: 0,
  compileIssues: [],
  breakingKinds: {},
  unexplainedKinds: {},
  elapsedMs: 1,
  places: { aligned, after, decided, behaviorOnly, behaviorOnlyDecided: behaviorOnly },
});

const l4 = (corpus: ReturnType<typeof pair>[]) =>
  scoreboard({
    corpus: corpus as never,
    manifestPairs: [],
    traffic: undefined,
    servers: undefined,
    replay: undefined,
    fuzz: undefined,
  }).find((line) => line.id === "L4");

describe("L4", () => {
  it("is met once decisions answered explain 90% of places and 80% of pairs close", () => {
    const closing = Array.from({ length: 8 }, () => pair(10, 5, 0));
    // 10 of 100 places left once decisions are answered: 90%.
    expect(l4([...closing, pair(10, 10, 5), pair(10, 10, 5)])?.status).toBe("met");
  });

  it("is not met below 90%, however many pairs close", () => {
    const closing = Array.from({ length: 8 }, () => pair(10, 5, 0));
    expect(l4([...closing, pair(10, 10, 10), pair(10, 10, 10)])?.status).toBe("not met");
  });

  it("credits behavior-only places only up to the cap", () => {
    // Nine pairs close; one of 20 places has 17 left, all behavior-only. Of
    // 110 places the cap credits 5, leaving 12: 89.1%, so the cap is what
    // keeps it from being met.
    const closing = Array.from({ length: 9 }, () => pair(10, 5, 0));
    expect(l4([...closing, pair(20, 17, 17, 17)])?.status).toBe("not met");
    // 16 left, 11 after the cap: 90.0%.
    expect(l4([...closing, pair(20, 16, 16, 16)])?.status).toBe("met");
  });
});
