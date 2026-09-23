/**
 * A Change to a response body written in place, compiled and run.
 *
 * PayPal writes its error responses into each operation as an `allOf` of two
 * schemas rather than naming one, and a field changed in such a body had no
 * schema to scope a Change to. A response scope names the operation and the
 * status instead.
 */
import type { OpenApiDocument } from "@invariant-app/contract";
import { parseChange } from "@invariant-app/ir";
import { createRuntime } from "@invariant-app/runtime";
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

  it("changes this operation's response alone where the body is a named schema", () => {
    // Plaid pointed three consent operations at another error schema and left
    // the rest of the API on the one they had shared.
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
    expect(prediction.issues).toEqual([]);
    // The shared schema itself is left as it was, for everything else using it.
    expect(
      Object.keys(
        pick(
          prediction.document,
          "components",
          "schemas",
          "Summary",
          "properties",
        ) as object,
      ),
    ).toContain("note");
    expect(
      Object.keys(
        pick(
          prediction.document,
          "paths",
          "/orders/{id}/summary",
          "get",
          "responses",
          "200",
          "content",
          "application/json",
          "schema",
          "properties",
        ) as object,
      ),
    ).toContain("memo");
  });
});

describe("a Change to what a response's list holds", () => {
  // Twilio's compliance list and Asana's portfolio items both changed what
  // each item of a list is. The prediction looked the shape up in the new
  // contract by walking properties alone, so `/items/*` found nothing and
  // every such Change was refused as unservable, although the pointer layer
  // that serves it has always walked a list.
  const listing = (item: Record<string, unknown>): OpenApiDocument =>
    ({
      openapi: "3.0.3",
      info: { title: "portfolios", version: "1" },
      paths: {
        "/portfolios/{id}/items": {
          get: {
            operationId: "listItems",
            parameters: [
              { name: "id", in: "path", required: true, schema: { type: "string" } },
            ],
            responses: {
              "200": {
                description: "the items",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { data: { type: "array", items: item } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }) as unknown as OpenApiDocument;

  const ADD_KIND = parseChange({
    irVersion: 1,
    id: "chg_items_kind",
    summary: "Each item says what kind it is.",
    scopes: [{ operation: "listItems", response: "200" }],
    ops: [{ op: "add", path: "/data/*/kind", value: null }],
  });

  it("is predicted by walking into the list, as the pointer layer does", () => {
    const before = listing({ type: "object", properties: { gid: { type: "string" } } });
    const after = listing({
      type: "object",
      properties: { gid: { type: "string" }, kind: { type: "string" } },
      required: ["kind"],
    });
    const prediction = predictDocument(before, after, [ADD_KIND]);
    expect(prediction.issues).toEqual([]);
    const item = pick(
      prediction.document,
      "paths",
      "/portfolios/{id}/items",
      "get",
      "responses",
      "200",
      ...JSON_BODY,
      "properties",
      "data",
      "items",
    );
    expect(Object.keys(pick(item, "properties") as object)).toEqual(["gid", "kind"]);
    expect(pick(item, "required")).toEqual(["kind"]);
  });

  it("is refused where the whole item is what would be added", () => {
    // What this compiled to, before it was refused, was `del /data/*` on the
    // way back to an old caller: their list arrived empty, and closure called
    // it explained because the predicted document matched the new contract.
    const before = listing({ type: "object", properties: { gid: { type: "string" } } });
    const after = listing({
      oneOf: [
        { type: "object", properties: { gid: { type: "string" } } },
        { type: "object", properties: { kind: { type: "string" } } },
      ],
    });
    const prediction = predictDocument(before, after, [
      parseChange({
        irVersion: 1,
        id: "chg_items_themselves",
        summary: "Each item may now be one of two things.",
        scopes: [{ operation: "listItems", response: "200" }],
        ops: [{ op: "add", path: "/data/*", value: null }],
      }),
    ]);
    expect(prediction.issues.map((issue) => issue.message)).toEqual([
      "add on listItems's 200 response: A list's items and a map's values are not a field to add: say what each item may be instead",
    ]);
  });

  it("is refused where the new contract's list holds nothing of that name", () => {
    const before = listing({ type: "object", properties: { gid: { type: "string" } } });
    const prediction = predictDocument(before, before, [ADD_KIND]);
    expect(prediction.issues.map((issue) => issue.message)).toEqual([
      "add on listItems's 200 response: the new contract's 200 response has no /data/*/kind",
    ]);
  });
});
