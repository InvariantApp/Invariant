/**
 * The form vectors, run against this engine, through the same method every
 * binding calls.
 */
import { describe, expect, it } from "vitest";
import { FORM_VECTORS, type FormVector } from "./form-vectors.ts";
import { createRuntime } from "./index.ts";

function run(vector: FormVector): { output?: string; refusedBy?: string } {
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
            sites: { "post /v": { form: vector.form, request: vector.instrs } },
            behaviors: [],
            retired: [],
          },
        },
      },
      identity: [{ kind: "default", label: "old" }],
    });
  } catch {
    return { refusedBy: "decode" };
  }
  const site = runtime.siteFor("old", "post", "/v");
  if (!site) throw new Error(`${vector.name}: no site`);
  try {
    return {
      output: runtime.transformRequestForm(site, vector.input, {
        contract: "old",
        operation: "v",
      }),
    };
  } catch (error) {
    return { refusedBy: (error as { changeId?: string }).changeId ?? "error" };
  }
}

describe("form vectors", () => {
  for (const vector of FORM_VECTORS) {
    it(vector.name, () => {
      const result = run(vector);
      if ("refuses" in vector.expect)
        expect(result.refusedBy).toBe(vector.expect.refuses);
      else {
        expect(result.refusedBy).toBeUndefined();
        expect(result.output).toBe(vector.expect.output);
      }
    });
  }
});
