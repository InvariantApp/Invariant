import { describe, expect, it } from "vitest";
import { met, p95, summarize } from "./summary.ts";

const runs = (os: string, seconds: number[], ok = true) =>
  seconds.map((value) => ({ os, seconds: value, ok }));

describe("the L9 summary", () => {
  it("takes the nearest-rank 95th percentile", () => {
    expect(p95([])).toBeNull();
    expect(p95([5])).toBe(5);
    expect(p95([1, 2, 3, 4, 5, 6, 7, 8, 9, 100])).toBe(100);
    expect(p95(Array.from({ length: 20 }, (_, i) => i + 1))).toBe(19);
  });

  it("is met by ten blocked runs on each system under the budget", () => {
    const ten = Array.from({ length: 10 }, () => 200);
    expect(
      met(
        summarize([...runs("linux", ten), ...runs("darwin", ten), ...runs("win32", ten)]),
      ),
    ).toBe(true);
  });

  it("is not met by a missing system, a run that did not block, or a slow tail", () => {
    const ten = Array.from({ length: 10 }, () => 200);
    expect(met(summarize([...runs("linux", ten), ...runs("darwin", ten)]))).toBe(false);
    expect(
      met(
        summarize([
          ...runs("linux", ten),
          ...runs("darwin", ten),
          ...runs("win32", [...ten.slice(1), 200], false),
        ]),
      ),
    ).toBe(false);
    expect(
      met(
        summarize([
          ...runs("linux", ten),
          ...runs("darwin", ten),
          ...runs("win32", [...ten.slice(1), 900]),
        ]),
      ),
    ).toBe(false);
  });
});
