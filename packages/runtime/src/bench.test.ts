/**
 * The design promises a latency budget, so the budget is a test.
 *
 * Three things matter. A request that needs no work must not pay for the
 * runtime at all, which is what keeps the cost of serving old contracts off
 * everybody else. A single-resource body has to be far enough under a
 * millisecond that no provider weighs compatibility against latency. And the
 * choice of numeric fidelity has to be justified by measurement rather than by
 * preference, because it is the single largest cost in the path.
 *
 * The logged figures are the real budget. The assertions are deliberately
 * looser, so they catch a regression of several times over without turning a
 * busy shared runner into a failing build.
 */
import { describe, expect, it } from "vitest";
import { type CompiledInstr, execute } from "./interpreter.ts";
import { type NumberFidelity, parseJson, stringifyJson } from "./json.ts";

const PROGRAM: CompiledInstr[] = [
  { k: "move", from: ["amount"], to: ["amount_cents"], c: "money" },
  { k: "scale", path: ["amount_cents"], exp: 2, c: "money" },
  { k: "enum", path: ["status"], map: { succeeded: "paid" }, c: "status" },
  {
    k: "set",
    path: ["capture_method"],
    value: "automatic",
    ifAbsent: true,
    c: "capture",
  },
  { k: "move", from: ["source"], to: ["payment_method", "token"], c: "method" },
];

function payment(index: number): Record<string, unknown> {
  return {
    id: `pay_${index}`,
    object: "payment",
    amount: 49.99,
    currency: "usd",
    source: "tok_visa",
    status: "succeeded",
    description: "A description of roughly the length a real one has",
    created: 1_760_000_000 + index,
  };
}

function inList(path: readonly string[]): string[] {
  return ["data", "*", ...path];
}

const LIST_PROGRAM: CompiledInstr[] = PROGRAM.map((instr) =>
  instr.k === "move"
    ? { ...instr, from: inList(instr.from), to: inList(instr.to) }
    : "path" in instr
      ? { ...instr, path: inList(instr.path) }
      : instr,
);

const SINGLE = JSON.stringify(payment(1));
const LIST = JSON.stringify({
  object: "list",
  data: Array.from({ length: 340 }, (_, index) => payment(index)),
  has_more: false,
});

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] as number;
}

function measure(
  body: string,
  program: CompiledInstr[],
  runs: number,
  fidelity: NumberFidelity = "double",
): { p50: number; p99: number } {
  const once = (): void => {
    const parsed = parseJson(body, fidelity);
    execute(parsed, program);
    stringifyJson(parsed);
  };

  // Warm up, so this measures steady-state work rather than a cold function.
  for (let i = 0; i < Math.min(runs, 2000); i += 1) once();

  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    once();
    samples.push(performance.now() - start);
  }
  return { p50: percentile(samples, 0.5), p99: percentile(samples, 0.99) };
}

/**
 * What these assert, and what they deliberately do not.
 *
 * A wall-clock p99 is not a property of this code. It is a property of what
 * else the machine is doing, and asserting a tight one made this file fail
 * twice while a corpus run was using the other cores, at 8.0 ms and 8.7 ms
 * against a limit of 8. Retrying until it passes would be worse than the flake,
 * so the assertions are chosen to catch what they are actually for.
 *
 * The median is the stable statistic and keeps a tight budget. The tail keeps a
 * loose one, sized to catch a structural regression such as buffering a body
 * that used to stream, or parsing one that used to be skipped, rather than to
 * catch the scheduler. Both real numbers are printed on every run, and the
 * measured figures in DESIGN 5.2 come from an idle machine.
 */
describe("latency budget", () => {
  it("costs nothing when a site has no compiled work", () => {
    // The current contract, and every operation that never changed, take this
    // path. The body is never read, let alone parsed.
    // Held to the rule above. Its p99 once had a 10us budget with no warm-up,
    // and failed at 13us on a busy machine, which measured the scheduler.
    const samples: number[] = [];
    for (let i = 0; i < 22_000; i += 1) {
      const start = performance.now();
      execute(SINGLE, []);
      if (i >= 2000) samples.push(performance.now() - start);
    }
    const p50 = percentile(samples, 0.5);
    const p99 = percentile(samples, 0.99);
    console.log(
      `no compiled work: p50 ${(p50 * 1000).toFixed(3)}us, p99 ${(p99 * 1000).toFixed(3)}us`,
    );
    expect(p50).toBeLessThan(0.001);
    expect(p99).toBeLessThan(0.5);
  });

  it("transforms a single resource in microseconds", () => {
    const { p50, p99 } = measure(SINGLE, PROGRAM, 20_000);
    console.log(
      `single resource (${SINGLE.length} B): p50 ${(p50 * 1000).toFixed(1)}us, p99 ${(p99 * 1000).toFixed(1)}us`,
    );
    expect(p50).toBeLessThan(0.05);
    // As above: the median is the budget, the tail is a regression alarm.
    expect(p99).toBeLessThan(5);
  });

  it("transforms a 64 KiB list of 340 resources in about a millisecond", () => {
    expect(LIST.length).toBeGreaterThan(60 * 1024);
    const { p50, p99 } = measure(LIST, LIST_PROGRAM, 2000);
    console.log(
      `list (${(LIST.length / 1024).toFixed(1)} KiB, 1700 instructions): p50 ${p50.toFixed(2)}ms, p99 ${p99.toFixed(2)}ms`,
    );
    expect(p50).toBeLessThan(4);
    // Loose on purpose: see the note above this block. An idle machine reports
    // about 1.5 ms here, so this catches a change in kind and not a busy box.
    expect(p99).toBeLessThan(50);
  });
});

describe("the cost of numeric fidelity", () => {
  it("is why exact source digits are not the default", () => {
    // Passing any reviver to JSON.parse leaves the fast path, so preserving
    // the caller's original digits is several times the cost of a plain parse.
    // It buys precision beyond a double, which the provider's own handler
    // would lose on its next ordinary parse anyway, so it stays opt-in.
    const fast = measure(LIST, LIST_PROGRAM, 1000, "double");
    const exact = measure(LIST, LIST_PROGRAM, 1000, "preserve");
    console.log(
      `64 KiB list: double ${fast.p50.toFixed(2)}ms, preserve ${exact.p50.toFixed(2)}ms ` +
        `(${(exact.p50 / fast.p50).toFixed(1)}x)`,
    );
    expect(exact.p50).toBeGreaterThan(fast.p50);
  });

  it("is exact either way for every amount a double can hold", () => {
    const body = '{"amount":4.35}';
    for (const fidelity of ["double", "preserve"] as const) {
      const parsed = parseJson(body, fidelity);
      execute(parsed, [{ k: "scale", path: ["amount"], exp: 2, c: "m" }]);
      expect(stringifyJson(parsed)).toBe('{"amount":435}');
    }
  });

  it("only preserve keeps digits a double cannot hold", () => {
    const body = '{"amount":1234567890123456789.01}';
    const exact = parseJson(body, "preserve");
    execute(exact, [{ k: "scale", path: ["amount"], exp: 2, c: "m" }]);
    expect(stringifyJson(exact)).toBe('{"amount":123456789012345678901}');

    // Sixteen digits in a row take the exact path even in double mode, since
    // a double rounds integers past 2^53. What the default still rounds is
    // precision spread across the point, runs of fewer than sixteen digits
    // that together hold more than a double can. Recording what that actually
    // produces keeps the default's limit visible.
    expect(stringifyJson(parseJson(body, "double"))).toBe(body);
    const spread = parseJson('{"amount":12345678.123456789}', "double");
    expect(stringifyJson(spread)).toBe('{"amount":12345678.12345679}');
  });
});
