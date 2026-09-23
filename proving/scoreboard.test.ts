import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scoreboard } from "./scoreboard.mts";
import type { ThreatManifest } from "./threats/summary.ts";

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

/** L15 from the threat-model record as committed, with every gap closed when asked. */
const l15 = (inputs: { threatsResult?: string; fuzz?: string; closeGaps?: boolean }) => {
  const manifest = JSON.parse(
    readFileSync(new URL("./threats/manifest.json", import.meta.url), "utf8"),
  ) as ThreatManifest;
  if (inputs.closeGaps) {
    manifest.rows = manifest.rows.map(({ gaps: _, ...row }) => row);
  }
  return scoreboard({
    corpus: undefined,
    manifestPairs: [],
    traffic: undefined,
    servers: undefined,
    replay: undefined,
    fuzz: inputs.fuzz,
    threats: manifest,
    threatsResult: inputs.threatsResult,
  }).find((line) => line.id === "L15");
};

describe("L15", () => {
  it("reports threat-model coverage from the record, and whether its tests passed", () => {
    const line = l15({ threatsResult: "success", fuzz: "success" });
    expect(line?.value).toMatch(
      /^threat-model tests passing: of the 12 rows of DESIGN 11\.1, \d+ covered here, \d+ covered here for this repository's part/,
    );
    expect(line?.value).toContain("not yet built:");
    expect(l15({})?.value).toMatch(/^threat-model tests not run here/);
    expect(l15({ threatsResult: "failure" })?.value).toMatch(/failing \(failure\)/);
  });

  it("is not met while releases carry no SBOM and provenance, even with every test passing", () => {
    const line = l15({ threatsResult: "success", fuzz: "success", closeGaps: true });
    expect(line?.status).toBe("not met");
    expect(line?.value).toContain("SBOM and provenance wait on the first publish");
  });
});
