/**
 * What a long chain costs: compile time, program size, load time and the time
 * to transform one response for a caller on the oldest contract (launch gate
 * L18).
 */

import type { ContractStep } from "@invariant/compiler";
import { type ChainResult, chainProgram, predictDocument } from "@invariant/compiler";
import { createRuntime } from "@invariant/runtime";
import { type ChainShape, changeAt, documentAt } from "./synthetic.ts";

export interface ChainCost {
  shape: ChainShape;
  compileMs: number;
  programBytes: number;
  loadMs: number;
  transformP50Ms: number;
  transformP99Ms: number;
}

/**
 * What L18 holds a Stripe-sized, 50-step chain to.
 *
 * The size is exact and is what catches a program that grows with the square
 * of its history again: written out in full, this chain was over 100 MB, and
 * linked it is about 3. The times are generous, since they are measured on
 * whatever machine runs the suite, and are there to catch a cost that has
 * changed kind, not one that has drifted.
 */
export const BUDGET = {
  programBytes: 6_000_000,
  compileMs: 30_000,
  loadMs: 1_500,
  transformP99Ms: 10,
} as const;

/** The chain's steps, oldest first, from `v0` to `v<steps>`. */
export function stepsOf(shape: ChainShape): ContractStep[] {
  const documents = Array.from({ length: shape.steps + 1 }, (_, version) =>
    documentAt(shape, version),
  );
  return Array.from({ length: shape.steps }, (_, index) => {
    const change = changeAt(index);
    const from = documents[index] as ContractStep["from"];
    return {
      label: `v${index + 1}`,
      parent: `v${index}`,
      from,
      to: predictDocument(from, documents[index + 1] as ContractStep["to"], [change])
        .document,
      changes: [change],
    };
  });
}

/** A response a caller on the oldest contract is sent, in the current shape. */
export function currentResource(shape: ChainShape): string {
  const resource: Record<string, unknown> = { id: "r_1" };
  for (let step = 0; step < shape.steps; step += 1) resource[`field_${step}_v2`] = 1999;
  return JSON.stringify({ name: "n", count: 1, resource });
}

export function compile(shape: ChainShape): ChainResult {
  return chainProgram("synthetic", `v${shape.steps}`, "sha256:head", stepsOf(shape));
}

export function measureChain(shape: ChainShape): ChainCost {
  const steps = stepsOf(shape);
  let started = performance.now();
  const { program, issues } = chainProgram(
    "synthetic",
    `v${shape.steps}`,
    "sha256:head",
    steps,
  );
  const compileMs = performance.now() - started;
  if (issues.length > 0) {
    throw new Error(
      issues
        .slice(0, 3)
        .map((issue) => issue.message)
        .join("; "),
    );
  }
  const text = JSON.stringify(program);

  started = performance.now();
  const runtime = createRuntime({
    program: JSON.parse(text),
    identity: [{ kind: "default", label: "v0" }],
  });
  const loadMs = performance.now() - started;

  const site = runtime.siteFor("v0", "get", "/v1/objects1/o_1");
  if (!site) throw new Error("no site for the oldest contract");
  const answer = currentResource(shape);
  const times: number[] = [];
  for (let run = 0; run < 200; run += 1) {
    const at = performance.now();
    runtime.transformResponse(site, 200, answer, {
      contract: "v0",
      operation: "operation1",
    });
    times.push(performance.now() - at);
  }
  times.sort((a, b) => a - b);

  return {
    shape,
    compileMs: Math.round(compileMs),
    programBytes: text.length,
    loadMs: Math.round(loadMs),
    transformP50Ms: Number((times[100] ?? 0).toFixed(3)),
    transformP99Ms: Number((times[197] ?? 0).toFixed(3)),
  };
}
