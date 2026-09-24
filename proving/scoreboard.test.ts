import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ReleaseResults } from "./releases/verify.mts";
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

  it("closes a pair whose only open places are behavior-only, within the same cap", () => {
    // Seven of ten pairs close by Changes. Two more have only behavior-only
    // places left, 4 of 100, inside the cap of 5: nine of ten close.
    const closing = Array.from({ length: 7 }, () => pair(10, 5, 0));
    const open = pair(10, 3, 3);
    const declared = l4([...closing, pair(10, 2, 2, 2), pair(10, 2, 2, 2), open]);
    expect(declared?.status).toBe("met");
    expect(declared?.value).toContain("counting the 2 whose only open places are");
    // With 12 behavior-only places the cap of 5 admits neither pair, so
    // seven of ten close and the line is not met, though places reach 90%.
    const over = l4([...closing, pair(10, 6, 6, 6), pair(10, 6, 6, 6), open]);
    expect(over?.status).toBe("not met");
    expect(over?.value).toContain("counting the 0 whose only open places are");
  });
});

/** L15 from the threat-model record as committed, with every gap closed when asked. */
const l15 = (inputs: {
  threatsResult?: string;
  fuzz?: string;
  closeGaps?: boolean;
  releases?: ReleaseResults;
}) => {
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
    releases: inputs.releases,
  }).find((line) => line.id === "L15");
};

describe("L15", () => {
  it("reports threat-model coverage from the record, and whether its tests passed", () => {
    const line = l15({ threatsResult: "success", fuzz: "success" });
    expect(line?.value).toMatch(
      /^threat-model tests passing: of the 12 rows of DESIGN 11\.1, \d+ covered here, \d+ covered here for this repository's part/,
    );
    expect(l15({})?.value).toMatch(/^threat-model tests not run here/);
    expect(l15({ threatsResult: "failure" })?.value).toMatch(/failing \(failure\)/);
  });

  it("is not met while the latest release is unchecked or lacks an SBOM or provenance", () => {
    const passing = { threatsResult: "success", fuzz: "success", closeGaps: true };
    const unchecked = l15(passing);
    expect(unchecked?.status).toBe("not met");
    expect(unchecked?.value).toContain(
      "SBOM and provenance of the latest release not yet checked",
    );
    const missing = l15({
      ...passing,
      releases: {
        artifacts: [
          {
            artifact: "@invariant-app/cli",
            version: "0.3.0",
            sbom: true,
            provenance: true,
          },
          {
            artifact: "@invariant-app/migrate-go",
            version: "0.2.0",
            sbom: true,
            provenance: false,
            problem: "no provenance on the registry",
          },
        ],
      },
    });
    expect(missing?.status).toBe("not met");
    expect(missing?.value).toContain(
      "missing on 1 of 2 (@invariant-app/migrate-go@0.2.0: no provenance on the registry)",
    );
  });

  it("is met once every artifact of the latest release carries both, and everything else holds", () => {
    const releases: ReleaseResults = {
      artifacts: [
        {
          artifact: "@invariant-app/cli",
          version: "0.3.0",
          sbom: true,
          provenance: true,
        },
        {
          artifact: "the action (v0)",
          version: "301d55b9dcbf",
          sbom: true,
          provenance: true,
        },
        {
          artifact: "ghcr.io/invariantapp/sidecar",
          version: "0.3.0",
          sbom: true,
          provenance: true,
          signed: true,
        },
      ],
    };
    const line = l15({
      threatsResult: "success",
      fuzz: "success",
      closeGaps: true,
      releases,
    });
    expect(line?.status).toBe("met");
    expect(line?.value).toContain(
      "the latest release's 1 npm package, the action and the proxy image each carry a CycloneDX SBOM and provenance",
    );
    expect(
      l15({ threatsResult: "success", fuzz: "failure", closeGaps: true, releases })
        ?.status,
    ).toBe("not met");
  });
});

describe("L11", () => {
  const l11 = (soak?: unknown) =>
    scoreboard({
      corpus: undefined,
      manifestPairs: undefined,
      traffic: undefined,
      servers: undefined,
      replay: undefined,
      fuzz: undefined,
      soak: soak as never,
    }).find((line) => line.id === "L11");
  const soak = (met: boolean) => ({
    hours: met ? 24.01 : 0.17,
    rps: { stated: 50, achieved: 50 },
    requests: { issued: 30_000, completed: 30_000, shed: 0 },
    violations: { responses: 0, requests: 0, samples: [] },
    transport: { duringRestart: 3, streamedCut: 40, otherwise: 0, samples: [] },
    disturbances: {
      flagFlips: 12,
      reloads: { written: 8, broken: 2, served: 6, kept: 2 },
      restarts: 1,
      crashes: 0,
    },
    rss: { maxMb: 140, trend: undefined, samples: 60 },
    sockets: { baseline: 3, max: 90, final: 3, leaked: 0, upstreamLeftOpen: 0 },
    verdict: {
      met,
      criteria: [
        { name: "ran 24 hours", met, value: met ? "24.01 hours" : "0.17 hours" },
        { name: "no socket leaked", met: true, value: "0 left open" },
      ],
    },
  });

  it("is not measured until a soak is recorded", () => {
    expect(l11()?.status).toBe("not measured");
  });

  it("says what a recorded soak measured, and which criteria it missed", () => {
    const short = l11(soak(false));
    expect(short?.status).toBe("not met");
    expect(short?.value).toContain("0.17 hours at 50 of 50 requests a second");
    expect(short?.value).toContain("Missed: ran 24 hours (0.17 hours)");
    expect(l11(soak(true))?.status).toBe("met");
  });
});
