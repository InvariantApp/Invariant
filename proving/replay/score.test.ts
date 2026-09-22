import { describe, expect, it } from "vitest";
import { changedRegions, score } from "./score.mts";

const lines = (text: string) => text.split("\n");

describe("the regions a result changed", () => {
  it("are the shortest edit's, with touching changes as one", () => {
    const before = lines("a\nb\nc\nd\ne");
    expect(changedRegions(before, lines("a\nB\nc\nd\ne\nf"))).toEqual([
      { oldStart: 1, oldEnd: 2, lines: ["B"] },
      { oldStart: 5, oldEnd: 5, lines: ["f"] },
    ]);
    expect(changedRegions(before, lines("a\nd\ne"))).toEqual([
      { oldStart: 1, oldEnd: 3, lines: [] },
    ]);
    expect(changedRegions(before, before)).toEqual([]);
    expect(changedRegions([], lines("x"))).toEqual([
      { oldStart: 0, oldEnd: 0, lines: ["x"] },
    ]);
  });
});

describe("the engine against the humans", () => {
  const base = lines(
    "import Pay from 'pay';\nconst p = new Pay(k, {\n  apiVersion: '1',\n});\nuse(p.coupon);",
  );
  const pinned = lines(
    "import Pay from 'pay';\nconst p = new Pay(k, {\n  apiVersion: '2',\n});\nuse(p.coupon);",
  );
  const human = changedRegions(
    base,
    lines(
      "import Pay from 'pay';\nconst p = new Pay(k, {\n    apiVersion: '2',\n});\nuse(p.promotion.coupon);",
    ),
  );

  it("is identical where it wrote the same lines, whatever the indentation, and missed where it wrote none", () => {
    expect(score(base, human, changedRegions(base, pinned))).toEqual({
      identical: 1,
      differs: 0,
      missed: 1,
      extra: 0,
    });
  });

  it("differs where it wrote other lines, and counts what it changed that no human did", () => {
    const engine = changedRegions(
      base,
      lines(
        "import Pay from 'pay2';\nconst p = new Pay(k, {\n  apiVersion: '3',\n});\nuse(p.coupon);",
      ),
    );
    expect(score(base, human, engine)).toEqual({
      identical: 0,
      differs: 1,
      missed: 1,
      extra: 1,
    });
  });
});
