/**
 * A vocabulary that is a schema of its own, drafted, compiled and run.
 *
 * Twilio names its enums (`configuration_address_enum_method` and hundreds
 * more) and refers to them from every field that holds one. A release that
 * rewrites such a vocabulary rewrites it once, under its own name, so the
 * Change is scoped to that schema and addresses its root: the value itself,
 * wherever a field holds it.
 */
import type { OpenApiDocument } from "@invariant-app/contract";
import type { Change } from "@invariant-app/ir";
import { propose, RulesJudge } from "@invariant-app/proposer";
import { createRuntime } from "@invariant-app/runtime";
import { describe, expect, it } from "vitest";
import { chainProgram } from "./chain.ts";
import { predictDocument } from "./predict.ts";

function addresses(methods: string[]): OpenApiDocument {
  const address = { $ref: "#/components/schemas/Address" };
  return {
    openapi: "3.1.0",
    info: { title: "addresses", version: "1" },
    paths: {
      "/addresses/{id}": {
        get: {
          operationId: "getAddress",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: address } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Address: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
            method: { $ref: "#/components/schemas/Method" },
            // The same vocabulary, held where null is allowed too.
            fallback_method: {
              anyOf: [{ $ref: "#/components/schemas/Method" }, { type: "null" }],
            },
          },
        },
        Method: { type: "string", enum: methods },
      },
    },
  } as unknown as OpenApiDocument;
}

describe("a named vocabulary", () => {
  it("rewritten in another case is converted once, at its own root, for every field holding it", async () => {
    const before = addresses(["get", "post"]);
    const after = addresses(["GET", "POST"]);
    const outcome = await propose(before, after, { judge: new RulesJudge() });
    expect(outcome.unresolved).toEqual([]);
    const changes = outcome.proposals.map((proposal) => proposal.change);
    expect(changes.flatMap((change) => change.ops)).toEqual([
      {
        op: "convert",
        path: "",
        codec: { kind: "stringCase", from: "snake", to: "screaming" },
      },
    ]);

    const prediction = predictDocument(before, after, changes);
    expect(prediction.issues).toEqual([]);
    const { program, issues } = chainProgram("addresses", "new", "sha256:new", [
      { label: "new", parent: "old", from: before, to: prediction.document, changes },
    ]);
    expect(issues).toEqual([]);
    const runtime = createRuntime({
      program,
      identity: [{ kind: "default", label: "new" }],
    });
    const site = runtime.siteFor("old", "get", "/addresses/ad_1");
    if (!site) throw new Error("no site for the old contract");
    const sent = runtime.transformResponse(
      site,
      200,
      JSON.stringify({ id: "ad_1", method: "POST", fallback_method: "GET" }),
      { contract: "old", operation: "getAddress" },
    );
    expect(JSON.parse(sent)).toEqual({
      id: "ad_1",
      method: "post",
      fallback_method: "get",
    });
    // Beside null the place carries no guard, and a null passes as it came.
    const unset = runtime.transformResponse(
      site,
      200,
      JSON.stringify({ id: "ad_1", method: "POST", fallback_method: null }),
      { contract: "old", operation: "getAddress" },
    );
    expect(JSON.parse(unset)).toEqual({
      id: "ad_1",
      method: "post",
      fallback_method: null,
    });
  });

  it("that only lost values is relaxed at its root, and a field holding it is not read as any text", async () => {
    const outcome = await propose(
      addresses(["get", "post", "put"]),
      addresses(["get", "post"]),
      {
        judge: new RulesJudge(),
      },
    );
    expect(outcome.unresolved).toEqual([]);
    const ops = outcome.proposals.flatMap((proposal) => proposal.change.ops);
    expect(ops).toEqual([{ op: "relax", path: "", set: { enum: ["get", "post"] } }]);
  });
});

describe("a named vocabulary that is a whole body by itself", () => {
  it("is refused where it is the body, since the runtime has nowhere to write it back", () => {
    const before = addresses(["get", "post"]);
    const after = addresses(["GET", "POST"]);
    for (const document of [before, after]) {
      const paths = document["paths"] as Record<string, unknown>;
      paths["/methods/default"] = {
        get: {
          operationId: "getDefaultMethod",
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Method" } },
              },
            },
          },
        },
      };
    }
    const changes: Change[] = [
      {
        irVersion: 1,
        id: "chg_method_case",
        summary: "Methods are written in capitals.",
        scopes: [{ schema: "#/components/schemas/Method" }],
        ops: [
          {
            op: "convert",
            path: "",
            codec: { kind: "stringCase", from: "snake", to: "screaming" },
          },
        ],
      },
    ];
    const { issues } = chainProgram("addresses", "new", "sha256:new", [
      { label: "new", parent: "old", from: before, to: after, changes },
    ]);
    expect(issues.map((issue) => issue.message)).toContain(
      "getDefaultMethod response 200: the value is the whole body there, which the runtime cannot replace",
    );
  });

  // CloudSearch 2013 restates each request body whole, and a restatement
  // writes nothing, so there is nothing to write back and nothing to refuse.
  it("is served where the Change writes nothing into it", () => {
    const before = addresses(["get", "post"]);
    const after = addresses(["get", "post"]);
    for (const document of [before, after]) {
      (document["paths"] as Record<string, unknown>)["/methods/default"] = {
        get: {
          operationId: "getDefaultMethod",
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Method" } },
              },
            },
          },
        },
      };
    }
    const changes: Change[] = [
      {
        irVersion: 1,
        id: "chg_method_restated",
        summary: "Methods are stated another way.",
        scopes: [{ schema: "#/components/schemas/Method" }],
        ops: [{ op: "restate", path: "" }],
      },
    ];
    const { issues } = chainProgram("addresses", "new", "sha256:new", [
      { label: "new", parent: "old", from: before, to: after, changes },
    ]);
    expect(issues.map((issue) => issue.message).join()).not.toContain("whole body");
  });
});
