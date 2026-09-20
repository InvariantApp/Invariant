import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type CompiledInstr, execute, TransformError } from "./interpreter.ts";
import { parseJson, stringifyJson } from "./json.ts";

function run(body: string, program: CompiledInstr[], numeric = true): string {
  const parsed = parseJson(body, numeric);
  execute(parsed, program);
  return stringifyJson(parsed);
}

const seg = (pointer: string): string[] =>
  pointer === "" ? [] : pointer.slice(1).split("/");

const move = (from: string, to: string): CompiledInstr => ({
  k: "move",
  from: seg(from),
  to: seg(to),
  c: "c",
});
const scale = (path: string, exp: number): CompiledInstr => ({
  k: "scale",
  path: seg(path),
  exp,
  c: "c",
});
const mapEnum = (
  path: string,
  map: Record<string, string>,
  lenient = false,
): CompiledInstr => ({
  k: "enum",
  path: seg(path),
  map,
  ...(lenient ? { lenient: true } : {}),
  c: "c",
});
const set = (path: string, value: unknown, ifAbsent: boolean): CompiledInstr => ({
  k: "set",
  path: seg(path),
  value,
  ifAbsent,
  c: "c",
});
const del = (path: string): CompiledInstr => ({ k: "del", path: seg(path), c: "c" });

describe("move", () => {
  it("renames a field in place", () => {
    expect(run('{"a":1,"z":2}', [move("/a", "/b")])).toBe('{"z":2,"b":1}');
  });

  it("nests a value and prunes the husk when unnesting", () => {
    const nested = run('{"source":"tok"}', [move("/source", "/payment_method/token")]);
    expect(nested).toBe('{"payment_method":{"token":"tok"}}');
    expect(run(nested, [move("/payment_method/token", "/source")])).toBe(
      '{"source":"tok"}',
    );
  });

  it("applies to every element behind a wildcard, index by index", () => {
    expect(run('{"data":[{"a":1},{"a":2}]}', [move("/data/*/a", "/data/*/b")])).toBe(
      '{"data":[{"b":1},{"b":2}]}',
    );
  });

  it("leaves an absent optional field alone", () => {
    expect(run('{"z":1}', [move("/a", "/b")])).toBe('{"z":1}');
  });
});

describe("scale", () => {
  it("scales exactly, where a double would not", () => {
    expect(run('{"amount":4.35}', [scale("/amount", 2)])).toBe('{"amount":435}');
    expect(run('{"amount":435}', [scale("/amount", -2)])).toBe('{"amount":4.35}');
  });

  it("keeps precision beyond what a double can hold", () => {
    const body = '{"amount":1234567890123456789.01}';
    expect(run(body, [scale("/amount", 2)])).toBe('{"amount":123456789012345678901}');
  });

  it("refuses a value with more precision than the contract allows", () => {
    expect(() => run('{"amount":1.00}', [scale("/amount", 2)])).not.toThrow();
    // 1.005 is a tenth of a cent. Rounding it would change an amount, so the
    // request is refused rather than quietly adjusted.
    expect(() => run('{"amount":1.005}', [scale("/amount", 2)])).toThrow(TransformError);
  });

  it("refuses a value that is not a number", () => {
    expect(() => run('{"amount":"49.99"}', [scale("/amount", 2)])).toThrow(
      /Expected a number/,
    );
  });

  it("leaves null alone, since an optional field may legitimately be null", () => {
    expect(run('{"amount":null}', [scale("/amount", 2)])).toBe('{"amount":null}');
  });
});

describe("enum", () => {
  it("maps a value both ways", () => {
    expect(run('{"s":"succeeded"}', [mapEnum("/s", { succeeded: "paid" })])).toBe(
      '{"s":"paid"}',
    );
  });

  it("refuses a value the target contract cannot express", () => {
    expect(() => run('{"s":"refunded"}', [mapEnum("/s", { succeeded: "paid" })])).toThrow(
      /No mapping for "refunded"/,
    );
  });

  it("passes an unfamiliar diagnostic label through when lenient", () => {
    expect(
      run('{"p":"currency"}', [mapEnum("/p", { amount_cents: "amount" }, true)]),
    ).toBe('{"p":"currency"}');
  });

  it("walks a chained rename back through each step in order", () => {
    // Newest step first, exactly how a chained response program is built.
    const program = [mapEnum("/p", { c: "b" }, true), mapEnum("/p", { b: "a" }, true)];
    expect(run('{"p":"c"}', program)).toBe('{"p":"a"}');
  });
});

describe("set and del", () => {
  it("supplies a default without overwriting what the caller sent", () => {
    expect(run("{}", [set("/capture", "automatic", true)])).toBe(
      '{"capture":"automatic"}',
    );
    expect(run('{"capture":"manual"}', [set("/capture", "automatic", true)])).toBe(
      '{"capture":"manual"}',
    );
  });

  it("restores a removed field unconditionally", () => {
    expect(run('{"a":1}', [set("/b", 0, false)])).toBe('{"a":1,"b":0}');
  });

  it("drops a field the old contract never had", () => {
    expect(run('{"a":1,"b":2}', [del("/b")])).toBe('{"a":1}');
  });

  it("drops a field from every element of a list", () => {
    expect(run('{"d":[{"a":1,"b":2},{"a":3,"b":4}]}', [del("/d/*/b")])).toBe(
      '{"d":[{"a":1},{"a":3}]}',
    );
  });

  it("writes into every element of a list", () => {
    expect(run('{"d":[{"a":1},{"a":2}]}', [set("/d/*/b", true, true)])).toBe(
      '{"d":[{"a":1,"b":true},{"a":2,"b":true}]}',
    );
  });
});

describe("a body nothing touches", () => {
  it("comes back byte for byte, including number formatting", () => {
    const body = '{"a":1.0,"b":1e3,"c":[0.10,-0],"d":"x","e":null}';
    expect(run(body, [])).toBe(body);
  });

  it("keeps untouched numbers intact while rewriting one", () => {
    const body = '{"keep":1.50,"amount":2.25}';
    expect(run(body, [scale("/amount", 2)])).toBe('{"keep":1.50,"amount":225}');
  });
});

describe("counting", () => {
  it("counts each Change once per value it actually changed", () => {
    const parsed = parseJson('{"d":[{"a":1},{"a":2},{"a":3}]}', false);
    const result = execute(parsed, [
      { k: "move", from: seg("/d/*/a"), to: seg("/d/*/b"), c: "chg_one" },
      { k: "del", path: seg("/missing"), c: "chg_two" },
    ]);
    expect(result.applied.get("chg_one")).toBe(3);
    expect(result.applied.has("chg_two")).toBe(false);
  });
});

describe("hostile input", () => {
  it("survives deeply nested and oddly shaped documents without hanging", () => {
    const deep = `${"[".repeat(200)}1${"]".repeat(200)}`;
    expect(() => run(deep, [del("/a")])).not.toThrow();

    const wide = JSON.stringify({
      d: Array.from({ length: 5000 }, (_, i) => ({ a: i })),
    });
    const out = run(wide, [move("/d/*/a", "/d/*/b")]);
    expect(out.startsWith('{"d":[{"b":0}')).toBe(true);
  });

  it("never reads a prototype or writes one", () => {
    // A payload carrying __proto__ is inert: JSON.parse makes it an ordinary
    // key, and nothing here treats it as anything else.
    const body = '{"__proto__":{"polluted":true},"a":1}';
    run(body, [move("/a", "/b")]);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();

    // A program that tried to write through one is refused rather than obeyed.
    expect(() => run('{"a":1}', [set("/__proto__/polluted", true, false)])).toThrow(
      TransformError,
    );
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("refuses to walk through a value that is not a container", () => {
    expect(run('{"a":5}', [move("/a/b", "/c")])).toBe('{"a":5}');
  });
});

describe("lens laws", () => {
  const amount = fc
    .tuple(fc.integer({ min: 0, max: 10 ** 12 }), fc.integer({ min: 0, max: 99 }))
    .map(([whole, cents]) => `${whole}.${String(cents).padStart(2, "0")}`);

  it("scaling out and back is the identity", () => {
    fc.assert(
      fc.property(amount, (text) => {
        const there = run(`{"amount":${text}}`, [scale("/amount", 2)]);
        const back = run(there, [scale("/amount", -2)]);
        // Normalize the input the same way, since 1.50 and 1.5 are one number.
        expect(back).toBe(run(`{"amount":${text}}`, [scale("/amount", 0)]));
      }),
      { numRuns: 1000 },
    );
  });

  it("a move and its inverse restore the original document", () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 3 }), (value) => {
        const body = JSON.stringify({ field: value, other: 1 });
        const there = run(body, [move("/field", "/nested/inner")], false);
        const back = run(there, [move("/nested/inner", "/field")], false);
        expect(JSON.parse(back)).toEqual(JSON.parse(body));
      }),
      { numRuns: 500 },
    );
  });

  it("an enum mapping and its inverse restore the original value", () => {
    const pairs: Record<string, string> = {
      succeeded: "paid",
      failed: "failed",
      pending: "processing",
    };
    const inverse = Object.fromEntries(Object.entries(pairs).map(([a, b]) => [b, a]));
    fc.assert(
      fc.property(fc.constantFrom(...Object.keys(pairs)), (value) => {
        const there = run(`{"s":${JSON.stringify(value)}}`, [mapEnum("/s", pairs)]);
        expect(run(there, [mapEnum("/s", inverse)])).toBe(
          `{"s":${JSON.stringify(value)}}`,
        );
      }),
      { numRuns: 200 },
    );
  });
});
