/**
 * The envelope vectors, run against this engine, and the list of headers no
 * program may touch, held equal to the one the compiler refuses by.
 */
import { DENIED_HEADERS } from "@invariant/ir";
import { describe, expect, it } from "vitest";
import { ENVELOPE_VECTORS, type EnvelopeVector } from "./envelope-vectors.ts";
import { createRuntime } from "./index.ts";
import { RUNTIME_DENIED_HEADERS } from "./program.ts";

function run(vector: EnvelopeVector): { request?: unknown; refusedBy?: string } {
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
            sites: { [`post ${vector.template}`]: { envelope: vector.envelope } },
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

  const site = runtime.siteFor("old", "post", vector.request.path);
  if (!site) throw new Error(`${vector.name}: no site for ${vector.request.path}`);
  try {
    const out = runtime.transformEnvelope(
      site,
      { ...vector.request, body: vector.request.body },
      { contract: "old", operation: "v" },
    );
    return {
      request: {
        path: out.path,
        search: out.search,
        headers: out.headers,
        ...(out.body === undefined ? {} : { body: out.body }),
      },
    };
  } catch (error) {
    return { refusedBy: (error as { changeId?: string }).changeId ?? "error" };
  }
}

describe("envelope vectors", () => {
  for (const vector of ENVELOPE_VECTORS) {
    it(vector.name, () => {
      const result = run(vector);
      if ("refuses" in vector.expect) {
        expect(result.refusedBy).toBe(vector.expect.refuses);
      } else {
        expect(result.refusedBy).toBeUndefined();
        expect(result.request).toEqual(vector.expect.request);
      }
    });
  }
});

describe("the headers no program may touch", () => {
  it("are the same list here as in the compiler", () => {
    expect([...RUNTIME_DENIED_HEADERS].sort()).toEqual([...DENIED_HEADERS].sort());
  });
});

describe("a site whose path is not all lowercase", () => {
  it("is found, since only the method is case-insensitive", () => {
    const runtime = createRuntime({
      program: {
        irVersion: 1,
        api: "a",
        current: "sha256:0",
        currentLabel: "current",
        contracts: {
          old: {
            label: "old",
            routes: [],
            sites: {
              "POST /v1/{name}:batchGet": {
                request: [{ k: "move", from: "/a", to: "/b", c: "chg" }],
              },
            },
            behaviors: [],
            retired: [],
          },
        },
      },
      identity: [{ kind: "default", label: "old" }],
    });
    expect(runtime.siteFor("old", "post", "/v1/projects:batchGet")).toBeDefined();
    expect(runtime.siteFor("old", "post", "/v1/projects:batchget")).toBeUndefined();
  });
});
