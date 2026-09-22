/**
 * Long chains (launch gate L18): a program that stays the size of its history
 * rather than its square, and still means what every step run in turn means.
 */
import { expandChains } from "@invariant-app/compiler";
import { createRuntime } from "@invariant-app/runtime";
import { checkChainEquivalence } from "@invariant-app/verifier";
import { describe, expect, it } from "vitest";
import { BUDGET, compile, currentResource, measureChain, stepsOf } from "./cost.ts";
import { STRIPE_SIZED } from "./synthetic.ts";

const SMALL = { operations: 30, schemas: 10, steps: 12 };

describe("a long chain", () => {
  it("means what each step run in turn means, on every contract", () => {
    const report = checkChainEquivalence(stepsOf(SMALL), { runs: 50, seed: 7 });
    expect(report.failures).toEqual([]);
    expect(report.evidence).toHaveLength(SMALL.steps);
  });

  it("answers every contract as the program written out in full does", () => {
    const { program, issues } = compile(SMALL);
    expect(issues).toEqual([]);
    const answer = currentResource(SMALL);
    const identity = [{ kind: "default" as const, label: "v0" }];
    const linked = createRuntime({ program, identity });
    const written = createRuntime({ program: expandChains(program), identity });
    for (let version = 0; version < SMALL.steps; version += 1) {
      const contract = `v${version}`;
      for (const operation of [0, 1, 17]) {
        const method = operation % 10 === 0 ? "post" : "get";
        const path = `/v1/objects${operation}/o_1`;
        const context = { contract, operation: `operation${operation}` };
        const [a, b] = [linked, written].map((runtime) => {
          const site = runtime.siteFor(contract, method, path);
          if (!site) throw new Error(`no site for ${contract} ${method} ${path}`);
          return runtime.transformResponse(site, 200, answer, context);
        });
        expect(a).toBe(b);
        // Every contract but the current one is sent something else.
        expect(a).not.toBe(answer);
      }
    }
  });

  it("stays within its budgets at Stripe's size", () => {
    const cost = measureChain(STRIPE_SIZED);
    expect(cost.programBytes).toBeLessThan(BUDGET.programBytes);
    expect(cost.compileMs).toBeLessThan(BUDGET.compileMs);
    expect(cost.loadMs).toBeLessThan(BUDGET.loadMs);
    expect(cost.transformP99Ms).toBeLessThan(BUDGET.transformP99Ms);
  }, 120_000);
});
