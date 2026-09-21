/**
 * A Change to a response body written in place, compiled and run.
 *
 * PayPal writes its error responses into each operation as an `allOf` of two
 * schemas rather than naming one, and a field changed in such a body had no
 * schema to scope a Change to. A response scope names the operation and the
 * status instead.
 */
import type { OpenApiDocument } from "@invariant/contract";
import { parseChange } from "@invariant/ir";
import { createRuntime } from "@invariant/runtime";
import { describe, expect, it } from "vitest";
import { chainProgram } from "./chain.ts";
import { predictDocument } from "./predict.ts";

/** What sits at a path of keys, for reading results in assertions. */
function pick(value: unknown, ...keys: string[]): unknown {
  return keys.reduce<unknown>(
    (node, key) => (node as Record<string, unknown> | undefined)?.[key],
    value,
  );
}

const JSON_BODY = ["content", "application/json", "schema"];

function orders(field: string, shared = false): OpenApiDocument {
  const body = {
    type: "object",
    properties: { [field]: { type: "string" }, count: { type: "integer" } },
  };
  const response = {
    description: "a summary",
    content: { "application/json": { schema: body } },
  };
  return {
    openapi: "3.0.3",
    info: { title: "orders", version: "1" },
    paths: {
      "/orders/{id}/summary": {
        get: {
          operationId: "getSummary",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": shared ? { $ref: "#/components/responses/Summary" } : response,
          },
        },
      },
      "/orders/{id}/audit": {
        get: {
          operationId: "getAudit",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": shared ? { $ref: "#/components/responses/Summary" } : response,
          },
        },
      },
    },
    ...(shared ? { components: { responses: { Summary: response } } } : {}),
  } as unknown as OpenApiDocument;
}

const RENAME = parseChange({
  irVersion: 1,
  id: "chg_summary_note",
  summary: "The summary's note is its memo.",
  scopes: [{ operation: "getSummary", response: "200" }],
  ops: [{ op: "move", from: "/note", to: "/memo" }],
});

describe("a Change to a response body written in place", () => {
  it("is predicted into that operation's response alone", () => {
    const prediction = predictDocument(orders("note"), orders("memo"), [RENAME]);
    expect(prediction.issues).toEqual([]);
    const propertiesOf = (path: string) =>
      Object.keys(
        pick(
          prediction.document,
          "paths",
          path,
          "get",
          "responses",
          "200",
          ...JSON_BODY,
          "properties",
        ) as object,
      );
    expect(propertiesOf("/orders/{id}/summary")).toEqual(["count", "memo"]);
    // The other operation's body was its own, and is untouched.
    expect(propertiesOf("/orders/{id}/audit")).toEqual(["note", "count"]);
  });

  it("takes its own copy of a response shared from components", () => {
    const prediction = predictDocument(orders("note", true), orders("memo", true), [
      RENAME,
    ]);
    expect(prediction.issues).toEqual([]);
    const response = (path: string) =>
      pick(prediction.document, "paths", path, "get", "responses", "200");
    expect(pick(response("/orders/{id}/summary"), "$ref")).toBeUndefined();
    expect(response("/orders/{id}/audit")).toEqual({
      $ref: "#/components/responses/Summary",
    });
  });

  it("shows an old caller the field under the name they know", () => {
    const { program, issues } = chainProgram("orders", "v2", "sha256:2", [
      {
        label: "v2",
        parent: "v1",
        from: orders("note"),
        to: predictDocument(orders("note"), orders("memo"), [RENAME]).document,
        changes: [RENAME],
      },
    ]);
    expect(issues).toEqual([]);
    const runtime = createRuntime({
      program,
      identity: [{ kind: "default", label: "v1" }],
    });
    const site = runtime.siteFor("v1", "get", "/orders/o_1/summary");
    if (!site) throw new Error("no site");
    const answer = JSON.stringify({ memo: "gift", count: 2 });
    expect(
      JSON.parse(
        runtime.transformResponse(site, 200, answer, {
          contract: "v1",
          operation: "getSummary",
        }),
      ),
    ).toEqual({ count: 2, note: "gift" });
    // Another status of the same operation is left alone.
    expect(
      runtime.transformResponse(site, 404, answer, {
        contract: "v1",
        operation: "getSummary",
      }),
    ).toBe(answer);
  });

  it("is refused where the body is a named schema, which a schema scope reaches", () => {
    // The same API with the summary's body named rather than written in place.
    const named = orders("note");
    const summary = pick(
      named,
      "paths",
      "/orders/{id}/summary",
      "get",
      "responses",
      "200",
      "content",
      "application/json",
    ) as Record<string, unknown>;
    named["components"] = { schemas: { Summary: summary["schema"] } } as never;
    summary["schema"] = { $ref: "#/components/schemas/Summary" };
    const prediction = predictDocument(named, orders("memo"), [RENAME]);
    expect(prediction.issues.map((issue) => issue.message).join()).toContain(
      "a Change to it is scoped to that schema",
    );
  });
});
