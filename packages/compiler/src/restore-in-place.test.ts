/**
 * A value put back into the object a Change is scoped to goes only where
 * that object is.
 *
 * Qdrant's telemetry sends `features` only when asked for detail, and 1.15
 * dropped `web_feature` from it. The Change puts `true` back for old callers,
 * which is what 1.14 sent, but the write used to create every object on its
 * way that was missing: asked for no detail, an old caller was sent a
 * `features` holding only `web_feature`, where the old server sent no
 * `features` at all. Rig D's false-closure check found it.
 */
import type { OpenApiDocument } from "@invariant-app/contract";
import { parseChange } from "@invariant-app/ir";
import { createRuntime } from "@invariant-app/runtime";
import { describe, expect, it } from "vitest";
import { chainProgram } from "./chain.ts";

function telemetry(features: Record<string, unknown>): OpenApiDocument {
  return {
    openapi: "3.1.0",
    info: { title: "telemetry", version: "1" },
    paths: {
      "/telemetry": {
        get: {
          operationId: "telemetry",
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["name"],
                    properties: {
                      name: { type: "string" },
                      features: { $ref: "#/components/schemas/Features" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: { schemas: { Features: features } },
  } as unknown as OpenApiDocument;
}

const before = telemetry({
  type: "object",
  required: ["debug", "web_feature"],
  properties: { debug: { type: "boolean" }, web_feature: { type: "boolean" } },
});
const after = telemetry({
  type: "object",
  required: ["debug"],
  properties: { debug: { type: "boolean" } },
});
const change = parseChange({
  irVersion: 1,
  id: "chg_features_web_feature_removed",
  summary: "`web_feature` was removed from Features.",
  scopes: [{ schema: "#/components/schemas/Features" }],
  ops: [{ op: "remove", path: "/web_feature", restore: true }],
  assertions: { loss_acknowledged: true, side_effects_unchanged: true },
});

function answered(body: unknown): unknown {
  const { program, issues } = chainProgram("telemetry", "v2", "sha256:2", [
    { label: "v2", parent: "v1", from: before, to: after, changes: [change] },
  ]);
  expect(issues).toEqual([]);
  const runtime = createRuntime({
    program,
    identity: [{ kind: "default", label: "v1" }],
  });
  const site = runtime.siteFor("v1", "get", "/telemetry");
  if (!site) throw new Error("no site");
  return JSON.parse(
    runtime.transformResponse(site, 200, JSON.stringify(body), {
      contract: "v1",
      operation: "telemetry",
    }),
  );
}

describe("a value put back into an object that may be absent", () => {
  it("is put back where the object is", () => {
    expect(answered({ name: "q", features: { debug: false } })).toEqual({
      name: "q",
      features: { debug: false, web_feature: true },
    });
  });

  it("creates no object where the answer has none", () => {
    expect(answered({ name: "q" })).toEqual({ name: "q" });
  });

  it("writes nothing into an object that is null", () => {
    expect(answered({ name: "q", features: null })).toEqual({
      name: "q",
      features: null,
    });
  });
});
