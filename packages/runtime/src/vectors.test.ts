/**
 * The vectors, run against this engine.
 *
 * Passing here is the weak half of what they are for. The strong half is that
 * they are data, so the next engine - in another language, by someone who has
 * not read this one - can be held to the same contract, including the
 * refusals. An engine that rounds where this one rejects would pass a test
 * suite written against its own behaviour and fail these.
 */
import { Instr } from "@invariant/ir";
import { describe, expect, it } from "vitest";
import { createRuntime } from "./index.ts";
import { CONFORMANCE_VECTORS, type Vector } from "./vectors.ts";

function run(vector: Vector): { output?: unknown; refusedBy?: string } {
  let runtime: ReturnType<typeof createRuntime>;
  try {
    runtime = createRuntime({
      program: {
        irVersion: 1,
        api: "conformance",
        current: "sha256:0",
        currentLabel: "current",
        contracts: {
          old: {
            label: "old",
            routes: [],
            sites: { "post /v": { request: vector.instrs } },
            ...(vector.blocks === undefined ? {} : { blocks: vector.blocks }),
            behaviors: [],
          },
        },
      },
      identity: [{ kind: "default", label: "old" }],
      ...(vector.maxMatches === undefined
        ? {}
        : { limits: { maxMatches: vector.maxMatches } }),
    });
  } catch {
    // A program the decoder refuses never reaches the interpreter, which is
    // the strongest form of refusal and one a port has to reproduce.
    return { refusedBy: "decode" };
  }

  const site = runtime.siteFor("old", "post", "/v");
  if (!site) throw new Error(`${vector.name}: the program compiled to no work`);

  try {
    return {
      output: JSON.parse(
        runtime.transformRequest(site, JSON.stringify(vector.input), {
          contract: "old",
          operation: "v",
        }),
      ) as unknown,
    };
  } catch (error) {
    const changeId = (error as { changeId?: string }).changeId;
    return { refusedBy: changeId ?? "error" };
  }
}

describe("conformance vectors", () => {
  for (const vector of CONFORMANCE_VECTORS) {
    it(vector.name, () => {
      const result = run(vector);

      if ("refuses" in vector.expect) {
        expect(result.refusedBy, `${vector.name} should have been refused`).toBe(
          vector.expect.refuses,
        );
        return;
      }

      expect(result.refusedBy, `${vector.name} was refused unexpectedly`).toBeUndefined();
      expect(result.output).toEqual(vector.expect.output);
    });
  }

  it("covers every instruction the IR has", () => {
    const covered = new Set(
      CONFORMANCE_VECTORS.flatMap((vector) => vector.instrs.map((instr) => instr.k)),
    );

    // A portability contract that omits an instruction is one a port can get
    // wrong while passing. The list is read from the IR's own schema, so a new
    // instruction fails here until it has a vector.
    const kinds = (Instr.anyOf as { properties: { k: { const: string } } }[]).map(
      (entry) => entry.properties.k.const,
    );
    expect(kinds.length).toBeGreaterThanOrEqual(9);
    expect(covered).toEqual(new Set(kinds));
  });

  it("states what must be refused, not only what must be produced", () => {
    const refusals = CONFORMANCE_VECTORS.filter((vector) => "refuses" in vector.expect);

    // An engine that rounds an inexact amount instead of rejecting it would
    // pass every positive case here and still be unsafe to put in front of
    // money.
    expect(refusals.length).toBeGreaterThanOrEqual(3);
  });

  it("says why each case is in the list", () => {
    for (const vector of CONFORMANCE_VECTORS) {
      expect(vector.why.length, `${vector.name} has no reason recorded`).toBeGreaterThan(
        20,
      );
    }
  });
});
