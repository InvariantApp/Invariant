import { describe, expect, it } from "vitest";
import {
  BUDGET,
  judge,
  type Measured,
  MODE_WEIGHTS,
  percentile,
  plan,
  random,
  rssTrend,
  scheduleFor,
  slope,
} from "./plan.ts";

describe("what the soak sends", () => {
  it("is the same request for request from the same seed", () => {
    const first = random(7);
    const second = random(7);
    const a = Array.from({ length: 200 }, (_, index) => plan(first, index));
    const b = Array.from({ length: 200 }, (_, index) => plan(second, index));
    expect(a).toEqual(b);
  });

  it("sends a body only with a POST, and slow or oversized bodies only there", () => {
    const next = random(3);
    for (let index = 0; index < 2_000; index += 1) {
      const planned = plan(next, index);
      expect(planned.body !== undefined).toBe(planned.operation.method === "POST");
      if (planned.mode === "trickle" || planned.mode === "bloated") {
        expect(planned.operation.method).toBe("POST");
      }
    }
  });

  it("keeps to the modes a run allows", () => {
    const next = random(5);
    const modes = new Set(
      Array.from(
        { length: 2_000 },
        (_, index) => plan(next, index, ["normal", "stall"]).mode,
      ),
    );
    expect([...modes].sort()).toEqual(["normal", "stall"]);
  });

  it("goes wrong about one time in five", () => {
    const total = Object.values(MODE_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
    expect(total).toBe(1_000);
    expect(MODE_WEIGHTS.normal / total).toBe(0.8);
  });
});

describe("how often the proxy is disturbed", () => {
  it("restarts a day's run every four hours, and a short run once", () => {
    const day = scheduleFor(24 * 3_600_000);
    expect(day.restartMs).toBe(4 * 3_600_000);
    expect(day.checkpointMs).toBe(15 * 60_000);
    expect(day.warmupMs).toBe(10 * 60_000);
    const short = scheduleFor(10 * 60_000);
    expect(short.restartMs).toBe(5 * 60_000);
    expect(short.flipMs).toBeLessThan(short.durationMs / 5);
    expect(short.reloadMs).toBeLessThan(short.durationMs / 5);
  });
});

describe("the measurements", () => {
  it("fits a line", () => {
    expect(
      slope([
        { x: 0, y: 1 },
        { x: 1, y: 3 },
        { x: 2, y: 5 },
      ]),
    ).toBe(2);
    expect(slope([{ x: 1, y: 1 }])).toBeUndefined();
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([], 99)).toBeUndefined();
  });

  it("judges memory on the floor each minute reaches, after warm-up, in the longest process", () => {
    const samples = [];
    // A sawtooth a collector makes, on a floor that does not rise, in a
    // process that lives two hours, after a short one that grew.
    for (let at = 0; at < 10 * 60_000; at += 10_000) {
      samples.push({ at, incarnation: 1, age: at, rssMb: 100 + at / 60_000 });
    }
    for (let at = 10 * 60_000; at < 130 * 60_000; at += 10_000) {
      const age = at - 10 * 60_000;
      samples.push({ at, incarnation: 2, age, rssMb: 120 + ((at / 10_000) % 6) * 5 });
    }
    const trend = rssTrend(samples, 10 * 60_000);
    expect(trend?.incarnation).toBe(2);
    expect(Math.abs(trend?.mbPerHour ?? 1)).toBeLessThan(0.01);
    expect(trend?.windowMs).toBeGreaterThan(60 * 60_000);
  });

  it("finds a leak in the floor under the sawtooth", () => {
    const samples = [];
    for (let at = 0; at < 3 * 3_600_000; at += 10_000) {
      samples.push({
        at,
        incarnation: 1,
        age: at,
        rssMb: 100 + (at / 3_600_000) * 4 + ((at / 10_000) % 6) * 5,
      });
    }
    expect(rssTrend(samples, 10 * 60_000)?.mbPerHour).toBeCloseTo(4, 0);
  });
});

describe("L11", () => {
  const day: Measured = {
    hours: 24.01,
    rps: { stated: 50, achieved: 49.99 },
    violations: 0,
    unanswered: 0,
    crashes: 0,
    rss: { maxMb: 140, trend: { windowMs: 3.5 * 3_600_000, mbPerHour: 0.2 } },
    sockets: { leaked: 0 },
  };

  it("is met by a clean day", () => {
    expect(judge(day).met).toBe(true);
  });

  it("is not met by any one thing wrong", () => {
    const wrong: Measured[] = [
      { ...day, hours: 0.17 },
      { ...day, rps: { stated: 20, achieved: 20 } },
      { ...day, rps: { stated: 50, achieved: 40 } },
      { ...day, violations: 1 },
      { ...day, unanswered: 1 },
      { ...day, crashes: 1 },
      { ...day, rss: { maxMb: 140, trend: { windowMs: 3_600_000, mbPerHour: 2 } } },
      { ...day, rss: { maxMb: 300, trend: day.rss.trend } },
      { ...day, sockets: { leaked: 1 } },
      { ...day, sockets: { leaked: undefined } },
    ];
    for (const measured of wrong) expect(judge(measured).met).toBe(false);
  });

  it("does not judge a trend over less than an hour", () => {
    const short = judge({
      ...day,
      hours: 0.17,
      rss: { maxMb: 120, trend: { windowMs: 4 * 60_000, mbPerHour: 30 } },
    });
    const criterion = short.criteria.find((entry) =>
      entry.name.startsWith("memory floor"),
    );
    expect(criterion?.met).toBe(false);
    expect(criterion?.value).toContain("not judged");
    expect(BUDGET.trendWindowMs).toBe(3_600_000);
  });
});
