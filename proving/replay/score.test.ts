import { describe, expect, it } from "vitest";
import { changedRegions, hunksOf, newCodeIn, type Region, score } from "./score.mts";

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
      flagged: 0,
      missed: 1,
      extra: 0,
      extraFlags: 0,
      newCode: 0,
      outcomes: ["identical", "missed"],
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
      flagged: 0,
      missed: 1,
      extra: 1,
      extraFlags: 0,
      newCode: 0,
      outcomes: ["differs", "missed"],
    });
  });

  it("is flagged where it wrote nothing but sent a person to the line", () => {
    // `p.coupon` is gone; the engine cannot say what replaces it and says so.
    expect(
      score(base, human, changedRegions(base, pinned), [{ from: 4, to: 5, at: 4 }]),
    ).toMatchObject({
      identical: 1,
      flagged: 1,
      missed: 0,
      outcomes: ["identical", "flagged"],
    });
  });

  it("is flagged where the site sits anywhere inside what the engine flagged", () => {
    // The engine flagged the whole options object; the human edited one line of it.
    expect(score(base, human, [], [{ from: 1, to: 4, at: 1 }]).outcomes).toEqual([
      "flagged",
      "missed",
    ]);
    // A flag where nobody changed anything is counted against it.
    expect(score(base, human, [], [{ from: 0, to: 1, at: 0 }]).extraFlags).toBe(1);
  });
});

describe("a rewrite around a changed element", () => {
  // The humans rewrote a webhook handler: the read of the field that moved,
  // and the lines around it, in one hunk, as git draws it.
  const base = lines(
    [
      "def handle(event):",
      "    sub = event.data.object",
      "    end = sub.current_period_end",
      "    record(end)",
      "    notify(sub.customer)",
      "    log('handled')",
      "    return True",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "def other():",
      "    return sub_total()",
    ].join("\n"),
  );
  const rewritten = lines(
    [
      "def handle(event):",
      "    sub = event.data.object",
      "    item = sub['items']['data'][0]",
      "    record(item.current_period_end)",
      "    notify(sub.customer)",
      "    log('handled', sub.id)",
      "    return True",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "def other():",
      "    return sub_total(1)",
    ].join("\n"),
  );
  const human = changedRegions(base, rewritten);

  it("is one hunk where changes share their context, and another past it", () => {
    expect(human.map((region) => region.oldStart)).toEqual([2, 5, 15]);
    expect(hunksOf(human)).toEqual([[0, 1], [2]]);
  });

  it("is handled in each of its regions where the engine flagged the element on a line the humans replaced", () => {
    // The flag shows line 2 only, where the moved field is read.
    const result = score(base, human, [], [{ from: 2, to: 3, at: 2 }]);
    expect(result.outcomes).toEqual(["flagged", "flagged", "missed"]);
  });

  it("is not carried by a flag whose element is outside every line the humans replaced", () => {
    // Shown as the whole function, but the element is on line 1, which the
    // humans kept: only the regions the extent reaches count.
    const result = score(base, human, [], [{ from: 0, to: 4, at: 1 }]);
    expect(result.outcomes).toEqual(["flagged", "missed", "missed"]);
  });

  it("does not count where the engine edited", () => {
    const engine = changedRegions(
      base,
      lines(base.join("\n").replace("current_period_end", "items")),
    );
    const result = score(base, human, engine, [{ from: 5, to: 6, at: 5 }]);
    expect(result.outcomes[0]).toBe("differs");
    expect(result.outcomes[1]).toBe("flagged");
  });
});

describe("new code", () => {
  it("is a whole file the base did not have", () => {
    const region = { oldStart: 0, oldEnd: 0, lines: ["import stripe", "x = 1"] };
    expect(newCodeIn([""], region, "python")).toBe(true);
    expect(newCodeIn(["import stripe", ""], region, "python")).toBe(false);
  });

  it("is a new helper inserted whole, in each language", () => {
    const at = (inserted: string[]) => ({ oldStart: 3, oldEnd: 3, lines: inserted });
    const base = ["a", "b", "c", "d"];
    expect(
      newCodeIn(
        base,
        at([
          "@cache",
          "def _period(item: Any) -> int:",
          '    """The period, from the item."""',
          "",
          "    return item['current_period_end']",
          "",
          "",
        ]),
        "python",
      ),
    ).toBe(true);
    expect(
      newCodeIn(
        base,
        at([
          "export function period(item: Item): number {",
          "  return item.end;",
          "}",
          "",
        ]),
        "typescript",
      ),
    ).toBe(true);
    expect(
      newCodeIn(
        base,
        at(["const period = (item) => {", "  return item.end;", "};"]),
        "javascript",
      ),
    ).toBe(true);
    expect(
      newCodeIn(
        base,
        at(["func period(item Item) int64 {", "\treturn item.End", "}"]),
        "go",
      ),
    ).toBe(true);
  });

  it("is found wherever the insertion could equally have been drawn", () => {
    const base = [
      "def a():",
      "    x = 1",
      "    return None",
      "",
      "",
      "def b():",
      "    pass",
    ];
    const after = [
      "def a():",
      "    x = 1",
      "    return None",
      "",
      "",
      "def helper():",
      "    y = 2",
      "    return None",
      "",
      "",
      "def b():",
      "    pass",
    ];
    // Drawn keeping the helper's `return None` against the old one: the same
    // result, starting from the old function's last line.
    const region: Region = {
      oldStart: 2,
      oldEnd: 2,
      lines: ["    return None", "", "", "def helper():", "    y = 2"],
    };
    const drawn = [
      ...base.slice(0, region.oldStart),
      ...region.lines,
      ...base.slice(region.oldStart),
    ];
    expect(drawn).toEqual(after);
    expect(newCodeIn(base, region, "python")).toBe(true);
  });

  it("is not a line added to what was there, or a change to existing lines", () => {
    const base = ["stripe.Subscription.create(", "    customer=c,", ")"];
    // A keyword argument added inside an existing call.
    expect(
      newCodeIn(
        base,
        { oldStart: 2, oldEnd: 2, lines: ['    payment_behavior="default_incomplete",'] },
        "python",
      ),
    ).toBe(false);
    // A helper defined, then a statement of the existing function after it.
    expect(
      newCodeIn(
        base,
        { oldStart: 1, oldEnd: 1, lines: ["def f():", "    return 1", "x = f()"] },
        "python",
      ),
    ).toBe(false);
    // Lines replaced are never new code.
    expect(
      newCodeIn(
        base,
        { oldStart: 1, oldEnd: 2, lines: ["def f():", "    pass"] },
        "python",
      ),
    ).toBe(false);
    // Braces that close something the insertion did not open.
    expect(
      newCodeIn(base, { oldStart: 1, oldEnd: 1, lines: ["func f() {", "}", "}"] }, "go"),
    ).toBe(false);
  });

  it("is counted apart, neither handled nor missed", () => {
    const base = ["x = 1", ""];
    const human = changedRegions(base, [
      "x = 1",
      "",
      "def helper():",
      "    return 2",
      "",
    ]);
    const result = score(base, human, [], [], (region) =>
      newCodeIn(base, region, "python"),
    );
    expect(result).toMatchObject({
      newCode: 1,
      missed: 0,
      flagged: 0,
      outcomes: ["new"],
    });
  });
});
