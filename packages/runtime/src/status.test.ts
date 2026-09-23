/**
 * The status vectors, run against this engine, and what a status rule does
 * that the vectors cannot say as data: a HEAD, the kill switch, and counting.
 */
import { describe, expect, it } from "vitest";
import { responseOf } from "./http.ts";
import { createRuntime, type UsageEvent } from "./index.ts";
import { STATUS_VECTORS, type StatusVector } from "./status-vectors.ts";

const programWith = (site: unknown) => ({
  irVersion: 2,
  api: "conformance",
  current: "sha256:0",
  currentLabel: "current",
  contracts: {
    old: {
      label: "old",
      routes: [],
      sites: { "post /v": site },
      behaviors: [],
      retired: [],
    },
  },
});

async function run(
  vector: StatusVector,
): Promise<{ response?: Response; refusedBy?: string }> {
  let runtime: ReturnType<typeof createRuntime>;
  try {
    runtime = createRuntime({
      program: programWith(vector.site),
      identity: [{ kind: "default", label: "old" }],
    });
  } catch {
    return { refusedBy: "decode" };
  }
  const site = runtime.siteFor("old", "post", "/v");
  if (!site) throw new Error(`${vector.name}: no site for /v`);
  const response = await runtime.adaptResponse(
    site,
    responseOf(
      vector.answer.body ?? null,
      vector.answer.status,
      new Headers(vector.answer.headers),
    ),
    { contract: "old", operation: "post /v" },
    { encoded: false, method: "POST" },
  );
  return { response };
}

describe("status vectors", () => {
  for (const vector of STATUS_VECTORS) {
    it(vector.name, async () => {
      const result = await run(vector);
      if ("refuses" in vector.expect) {
        expect(result.refusedBy).toBe(vector.expect.refuses);
        return;
      }
      expect(result.refusedBy).toBeUndefined();
      const response = result.response as Response;
      const expected = vector.expect.answer;
      expect(response.status).toBe(expected.status);
      for (const [name, value] of expected.headers) {
        expect(response.headers.get(name), name).toBe(value);
      }
      for (const name of vector.expect.absent ?? []) {
        expect(response.headers.get(name), name).toBeNull();
      }
      // No body and an empty one are the same answer on the wire.
      expect(response.body ? await response.text() : "").toBe(expected.body ?? "");
    });
  }

  it("says why each case is in the list, and states what must be refused", () => {
    for (const vector of STATUS_VECTORS) expect(vector.why.length).toBeGreaterThan(20);
    expect(STATUS_VECTORS.some((vector) => "refuses" in vector.expect)).toBe(true);
  });
});

describe("a status answered as another", () => {
  const site = { status: [{ from: 201, to: 204, empty: true, c: "chg_created" }] };

  it("answers a HEAD with the status the old contract promised, and no body's headers", async () => {
    const runtime = createRuntime({
      program: programWith(site),
      identity: [{ kind: "default", label: "old" }],
    });
    const response = await runtime.adaptResponse(
      runtime.siteFor("old", "post", "/v"),
      responseOf(null, 201, new Headers({ "content-type": "application/json" })),
      { contract: "old", operation: "post /v" },
      { encoded: false, method: "HEAD" },
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("content-type")).toBeNull();
  });

  it("leaves a current caller's answer as the provider sent it", async () => {
    const runtime = createRuntime({
      program: programWith(site),
      identity: [{ kind: "default", label: "current" }],
    });
    const response = await runtime.adaptResponse(
      undefined,
      responseOf(
        '{"name":"CI"}',
        201,
        new Headers({ "content-type": "application/json" }),
      ),
      { contract: "current", operation: "post /v" },
      { encoded: false, method: "POST" },
    );
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('{"name":"CI"}');
  });

  it("refuses the call when the Change behind the rule is switched off", () => {
    const runtime = createRuntime({
      program: programWith(site),
      identity: [{ kind: "default", label: "old" }],
      flags: () => ({ disabledChanges: ["chg_created"] }),
    });
    expect(() => runtime.siteFor("old", "post", "/v")).toThrow(/chg_created/);
  });

  it("counts the Change as applied", async () => {
    const seen: UsageEvent[] = [];
    const runtime = createRuntime({
      program: programWith(site),
      identity: [{ kind: "default", label: "old" }],
      onUsage: (event) => seen.push(event),
    });
    await runtime.adaptResponse(
      runtime.siteFor("old", "post", "/v"),
      responseOf(
        '{"name":"CI"}',
        201,
        new Headers({ "content-type": "application/json" }),
      ),
      { contract: "old", operation: "post /v" },
      { encoded: false, method: "POST" },
    );
    expect(seen.map((event) => [...event.changes.keys()])).toEqual([["chg_created"]]);
  });
});
