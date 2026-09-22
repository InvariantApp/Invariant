/**
 * A field dropped with nothing to put back. Old callers' requests leave it
 * out; their responses are left without it, which is only right where they
 * were never promised it. Where they were, the release is refused until a
 * value is given.
 */
import type { OpenApiDocument } from "@invariant-app/contract";
import type { Change } from "@invariant-app/ir";
import { describe, expect, it } from "vitest";
import { chainProgram } from "./chain.ts";
import { predictDocument } from "./predict.ts";

function contract(profile: Record<string, unknown>): OpenApiDocument {
  const body = {
    content: { "application/json": { schema: { $ref: "#/components/schemas/Profile" } } },
  };
  return {
    openapi: "3.1.0",
    info: { title: "profiles", version: "1" },
    paths: {
      "/profiles": {
        post: {
          operationId: "createProfile",
          requestBody: { required: true, ...body },
          responses: { "201": { description: "made", ...body } },
        },
      },
    },
    components: { schemas: { Profile: profile } },
  } as unknown as OpenApiDocument;
}

const dropped = (required: string[]) => ({
  old: contract({
    type: "object",
    required,
    properties: { name: { type: "string" }, nickname: { type: "string" } },
  }),
  new: contract({
    type: "object",
    required: required.filter((field) => field !== "nickname"),
    properties: { name: { type: "string" } },
  }),
});

const change: Change = {
  irVersion: 1,
  id: "chg_nickname_dropped",
  summary: "`nickname` was dropped.",
  scopes: [{ schema: "#/components/schemas/Profile" }],
  ops: [{ op: "remove", path: "/nickname" }],
};

describe("a field dropped with nothing to put back", () => {
  it("is taken out of old callers' requests and left out of their responses", () => {
    const pair = dropped(["name"]);
    const prediction = predictDocument(pair.old, pair.new, [change]);
    expect(prediction.issues).toEqual([]);
    const chained = chainProgram("profiles", "new", "sha256:remove", [
      {
        label: "new",
        parent: "old",
        from: pair.old,
        to: prediction.document,
        changes: [change],
      },
    ]);
    expect(chained.issues).toEqual([]);
    const site = (chained.program.contracts["old"]?.sites ?? {}) as Record<
      string,
      { request: unknown[]; response: Record<string, unknown[]> }
    >;
    const create = site["post /profiles"];
    expect(JSON.stringify(create?.request)).toContain('"k":"del"');
    // Nothing is put back on the way out.
    expect(JSON.stringify(create?.response ?? {})).not.toContain("chg_nickname_dropped");
  });

  it("is refused where old callers' responses always carried it", () => {
    const pair = dropped(["name", "nickname"]);
    const prediction = predictDocument(pair.old, pair.new, [change]);
    expect(prediction.issues.map((issue) => issue.message)).toEqual([
      expect.stringMatching(/no restore, but old callers' responses always carried it/),
    ]);
  });
});
