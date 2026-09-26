/**
 * Calibration has to be repeatable before a comparison against it means
 * anything.
 *
 * The differential check runs the old build twice and treats whatever differs
 * between those two runs as volatile: generated identifiers, timestamps,
 * anything the build does not promise to reproduce. Everything else has to match
 * the new build exactly.
 *
 * Steps missing from the second run used to be skipped. That looks harmless and
 * is the opposite of harmless: a step with no calibration has no volatile paths,
 * so every value it derives from the clock is then reported as a difference
 * between the two builds. It failed exactly that way once, under load, on a
 * fixture whose timestamps come from the second its server started, and the
 * three differences it reported were all the same clock tick.
 */
import { describe, expect, it } from "vitest";
import {
  CalibrationError,
  checkDifferential,
  clockPaths,
  type StepObservation,
  volatilePaths,
} from "./differential.ts";
import type { Scenario } from "./scenarios.ts";

const step = (id: string, body: Record<string, unknown>): StepObservation =>
  ({ id, status: 200, headers: {}, body }) as unknown as StepObservation;

describe("calibrating against the old build", () => {
  it("marks a value the build did not reproduce", () => {
    const paths = volatilePaths(
      [step("create", { id: "a_1", amount: 100 })],
      [step("create", { id: "a_2", amount: 100 })],
    );
    expect(paths.has("create/id")).toBe(true);
    expect(paths.has("create/amount")).toBe(false);
  });

  it("marks a value that appeared in only one run", () => {
    const paths = volatilePaths(
      [step("create", { id: "a" })],
      [step("create", { id: "a", extra: 1 })],
    );
    expect(paths.has("create/extra")).toBe(true);
  });

  it("refuses when the two runs answered a different number of steps", () => {
    // The old behaviour returned a partial calibration, which is worse than
    // none: the caller cannot tell that some steps were never calibrated.
    expect(() =>
      volatilePaths(
        [step("create", { created: 1 }), step("retrieve", { created: 1 })],
        [step("create", { created: 2 })],
      ),
    ).toThrow(CalibrationError);
    expect(() => volatilePaths([step("a", {}), step("b", {})], [step("a", {})])).toThrow(
      /answered 2 steps and then 1/,
    );
  });

  it("is happy when both runs are identical, which means nothing is volatile", () => {
    expect(volatilePaths([step("a", { x: 1 })], [step("a", { x: 1 })]).size).toBe(0);
  });
});

describe("values read from the clock", () => {
  const window = {
    from: Date.parse("2026-09-26T12:34:10Z"),
    to: Date.parse("2026-09-26T12:34:12Z"),
  };

  it("are found when both runs read the same minute or day, which the tick cannot expose", () => {
    const run = () => [
      step("create", {
        minute: "2026-09-26T12:34Z",
        day: "2026-09-26",
        seconds: 1_790_426_050,
        local: "2026-09-26 08:34:11",
        since: "2019-01-01T00:00:00Z",
        amount: 1_790_426_050_000_000,
        name: "2026-09-26 is a date in a sentence",
      }),
    ];
    const paths = clockPaths(run(), run(), window);
    expect([...paths].sort()).toEqual([
      "create/day",
      "create/local",
      "create/minute",
      "create/seconds",
    ]);
  });

  it("are found only when both runs read it", () => {
    expect(
      clockPaths(
        [step("create", { at: "2026-09-26T12:34:11Z" })],
        [step("create", { at: "2020-01-01T00:00:00Z" })],
        window,
      ).size,
    ).toBe(0);
  });
});

describe("starting builds once per contract", () => {
  const scenario = (name: string): Scenario => ({
    name,
    contract: "2026-01-01",
    steps: [
      {
        id: "read",
        method: "GET",
        path: "/thing",
        headers: {},
        body: undefined,
        capture: {},
        expectStatus: undefined,
      },
    ],
    acknowledged: [],
  });

  it("asks one start of each build every scenario in turn, three starts in all", async () => {
    const starts: string[] = [];
    const launch = async (build: string) => {
      starts.push(build);
      let asked = 0;
      return {
        fetch: async () => {
          asked += 1;
          return Response.json({ asked, build: build === "head" ? "2026-01-01" : build });
        },
        close: async () => {},
      };
    };
    const report = await checkDifferential([scenario("one"), scenario("two")], {
      launch,
      startPer: "contract",
    });
    expect(starts).toEqual(["2026-01-01", "2026-01-01", "head"]);
    // The second scenario sees the state the first left, the same way in all
    // three runs, so nothing about it is volatile and both builds agree.
    expect(report.differences).toEqual([]);
    expect(report.volatile.get("two")).toEqual([]);
    expect(report.evidence.map((entry) => entry.result)).toEqual(["pass", "pass"]);
  });

  it("starts fresh builds for each scenario by default", async () => {
    const starts: string[] = [];
    const launch = async (build: string) => {
      starts.push(build);
      return {
        fetch: async () => Response.json({ ok: true }),
        close: async () => {},
      };
    };
    await checkDifferential([scenario("one"), scenario("two")], { launch });
    expect(starts).toHaveLength(6);
  });
});

describe("comparing a media type", () => {
  const one: Scenario = {
    name: "read",
    contract: "2026-01-15",
    steps: [
      {
        id: "read",
        method: "GET",
        path: "/thing",
        headers: {},
        body: undefined,
        capture: {},
        expectStatus: undefined,
      },
    ],
    acknowledged: [],
  };
  const answering = (old: string, now: string) => async (build: string) => ({
    fetch: async () =>
      new Response("{}", { headers: { "content-type": build === "head" ? now : old } }),
    close: async () => {},
  });

  it("reads the same media type written with other spacing as the same", async () => {
    const report = await checkDifferential([one], {
      launch: answering("text/plain;charset=utf-8", "text/plain; charset=utf-8"),
    });
    expect(report.differences).toEqual([]);
  });

  it("still tells two media types apart", async () => {
    const report = await checkDifferential([one], {
      launch: answering("application/json", "text/plain"),
    });
    expect(report.differences.map((entry) => entry.pointer)).toEqual([
      "header content-type",
    ]);
  });
});
