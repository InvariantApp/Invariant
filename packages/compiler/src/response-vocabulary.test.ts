/**
 * Response vocabularies that grew from nothing or opened, served end to end.
 *
 * Discord's applications listed `event_webhooks_types` as a list of no values
 * at all, and a later release as twelve kinds of event: the list an old caller
 * is sent leaves them out. Mistral made a tool's `name` one of its built-in
 * connectors or any other name: the name passes through, a declared loss, and
 * the prediction writes the choice as the new contract does. And one list
 * used both ways, which lost a value and gained another, leaves each out on
 * its way to the side that does not name it.
 */
import type { OpenApiDocument } from "@invariant-app/contract";
import { type Change, parseChange } from "@invariant-app/ir";
import { createRuntime } from "@invariant-app/runtime";
import { describe, expect, it } from "vitest";
import { chainProgram } from "./chain.ts";
import { derive } from "./derive.ts";
import { predictDocument } from "./predict.ts";

type Schema = Record<string, unknown>;

/** One operation that takes `Input` and answers with `Output`. */
const doc = (schemas: Record<string, Schema>): OpenApiDocument =>
  ({
    openapi: "3.1.0",
    info: { title: "apps", version: "1" },
    paths: {
      "/apps": {
        post: {
          operationId: "createApp",
          requestBody: {
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Input" } },
            },
          },
          responses: {
            "200": {
              description: "made",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Output" } },
              },
            },
          },
        },
      },
    },
    components: { schemas: { Input: { type: "object" }, ...schemas } },
  }) as unknown as OpenApiDocument;

const serve = (before: OpenApiDocument, after: OpenApiDocument, changes: Change[]) => {
  const { program, issues } = chainProgram("apps", "v2", "sha256:2", [
    { label: "v2", parent: "v1", from: before, to: after, changes },
  ]);
  expect(issues).toEqual([]);
  const runtime = createRuntime({
    program,
    identity: [{ kind: "default", label: "v1" }],
  });
  const site = runtime.siteFor("v1", "post", "/apps");
  expect(site).toBeDefined();
  const context = { contract: "v1", operation: "createApp" };
  return {
    request: (body: unknown) =>
      JSON.parse(runtime.transformRequest(site as never, JSON.stringify(body), context)),
    response: (body: unknown) =>
      JSON.parse(
        runtime.transformResponse(site as never, 200, JSON.stringify(body), context),
      ),
  };
};

const schemaIn = (document: OpenApiDocument, name: string) =>
  (document as unknown as { components: { schemas: Record<string, Schema> } }).components
    .schemas[name] as Schema;

describe("a response list whose items named no values and now name some (Discord)", () => {
  const actionTypes = {
    type: "string",
    oneOf: [
      { const: "ENTITLEMENT_CREATE" },
      { const: "LOBBY_MESSAGE_CREATE" },
      { const: "TYPING_START" },
    ],
  };
  const output = (values: string[]) =>
    doc({
      ActionTypes: actionTypes,
      Output: {
        type: "object",
        properties: {
          event_webhooks_types: {
            type: "array",
            uniqueItems: true,
            items: {
              type: "string",
              enum: values,
              allOf: [{ $ref: "#/components/schemas/ActionTypes" }],
            },
          },
        },
      },
    });
  const before = output([]);
  const after = output(["ENTITLEMENT_CREATE", "LOBBY_MESSAGE_CREATE"]);
  // As the proposer drafts it: its own tests say so.
  const change = parseChange({
    irVersion: 1,
    id: "chg_output_event_webhooks_types",
    summary: "The list names two kinds of event.",
    scopes: [{ schema: "#/components/schemas/Output" }],
    ops: [
      {
        op: "convert",
        path: "/event_webhooks_types",
        codec: {
          kind: "dropValues",
          values: ["ENTITLEMENT_CREATE", "LOBBY_MESSAGE_CREATE"],
        },
      },
    ],
  });

  it("predicts the new list where the items write it, and is a declared loss", () => {
    const prediction = predictDocument(before, after, [change]);
    expect(prediction.issues).toEqual([]);
    const items = (
      (schemaIn(prediction.document, "Output")["properties"] as Schema)[
        "event_webhooks_types"
      ] as Schema
    )["items"];
    expect(items).toEqual({
      type: "string",
      enum: ["ENTITLEMENT_CREATE", "LOBBY_MESSAGE_CREATE"],
      allOf: [{ $ref: "#/components/schemas/ActionTypes" }],
    });
    expect(derive(change).runtime).toBe("declared-lossy");
  });

  it("sends an old caller the list without the values it never heard of", () => {
    const served = serve(before, after, [change]);
    expect(
      served.response({
        event_webhooks_types: ["ENTITLEMENT_CREATE", "LOBBY_MESSAGE_CREATE"],
      }),
    ).toEqual({ event_webhooks_types: [] });
  });
});

describe("one list used both ways that lost a value and gained another", () => {
  const flags = (values: string[]) => ({
    type: "object",
    properties: { flags: { type: "array", items: { type: "string", enum: values } } },
  });
  const before = doc({ Input: flags(["gift", "rush"]), Output: flags(["gift", "rush"]) });
  const after = doc({
    Input: flags(["gift", "express"]),
    Output: flags(["gift", "express"]),
  });
  const change = parseChange({
    irVersion: 1,
    id: "chg_flags",
    summary: "`rush` went and `express` arrived.",
    scopes: [
      { schema: "#/components/schemas/Input" },
      { schema: "#/components/schemas/Output" },
    ],
    ops: [
      {
        op: "convert",
        path: "/flags",
        codec: { kind: "dropValues", values: ["rush", "express"] },
      },
    ],
  });

  it("predicts the new list: the one it held taken out, the one it did not added", () => {
    const prediction = predictDocument(before, after, [change]);
    expect(prediction.issues).toEqual([]);
    for (const name of ["Input", "Output"]) {
      const list = (schemaIn(prediction.document, name)["properties"] as Schema)[
        "flags"
      ] as Schema;
      expect(list["items"]).toEqual({ type: "string", enum: ["gift", "express"] });
    }
  });

  it("leaves each value out on its way to the side that does not name it", () => {
    const served = serve(before, after, [change]);
    expect(served.request({ flags: ["gift", "rush"] })).toEqual({ flags: ["gift"] });
    expect(served.response({ flags: ["express", "gift"] })).toEqual({ flags: ["gift"] });
  });
});

describe("a name that became one of the names it listed or any other (Mistral)", () => {
  const connectors = { type: "string", enum: ["web_search", "code_interpreter"] };
  const output = (name: Schema) =>
    doc({
      BuiltInConnectors: connectors,
      Output: { type: "object", properties: { name }, required: ["name"] },
    });
  const before = output({ $ref: "#/components/schemas/BuiltInConnectors" });
  const after = output({
    anyOf: [{ $ref: "#/components/schemas/BuiltInConnectors" }, { type: "string" }],
  });
  // As the proposer drafts it: its own tests say so.
  const change = parseChange({
    irVersion: 1,
    id: "chg_output_name",
    summary: "`name` may be any name.",
    scopes: [{ schema: "#/components/schemas/Output" }],
    ops: [
      { op: "relax", path: "/name", set: { enum: null } },
      { op: "restate", path: "/name" },
    ],
  });

  it("predicts the choice as the new contract writes it, leaving the named vocabulary alone", () => {
    const prediction = predictDocument(before, after, [change]);
    expect(prediction.issues).toEqual([]);
    expect(
      (schemaIn(prediction.document, "Output")["properties"] as Schema)["name"],
    ).toEqual({
      anyOf: [{ $ref: "#/components/schemas/BuiltInConnectors" }, { type: "string" }],
    });
    expect(schemaIn(prediction.document, "BuiltInConnectors")).toEqual(connectors);
    expect(derive(change).runtime).toBe("declared-lossy");
  });

  it("is refused where the choice allows more than any text", () => {
    const wider = output({
      anyOf: [{ $ref: "#/components/schemas/BuiltInConnectors" }, { type: "integer" }],
    });
    expect(predictDocument(before, wider, [change]).issues).not.toEqual([]);
  });

  it("passes a name old callers never heard of through as the API sent it", () => {
    // Nothing runs, so the call is not even routed through a transform.
    const { program, issues } = chainProgram("apps", "v2", "sha256:2", [
      { label: "v2", parent: "v1", from: before, to: after, changes: [change] },
    ]);
    expect(issues).toEqual([]);
    const runtime = createRuntime({
      program,
      identity: [{ kind: "default", label: "v1" }],
    });
    expect(runtime.siteFor("v1", "post", "/apps")).toBeUndefined();
  });
});

describe("a value written as a constant that came to refer to a vocabulary (Langfuse)", () => {
  const output = (role: Schema) =>
    doc({
      Role: { type: "string", enum: ["user", "assistant", "system"] },
      Output: { type: "object", properties: { role } },
    });
  const before = output({ type: "string", const: "user" });
  const after = output({ $ref: "#/components/schemas/Role" });
  // A fold decision, answered.
  const change = parseChange({
    irVersion: 1,
    id: "chg_output_role_vocabulary",
    summary: "`role` can answer with values old callers never saw.",
    scopes: [{ schema: "#/components/schemas/Output" }],
    ops: [
      {
        op: "convert",
        path: "/role",
        codec: {
          kind: "enumMap",
          pairs: [["user", "user"]],
          fold: [
            ["assistant", "user"],
            ["system", "user"],
          ],
        },
      },
    ],
  });

  it("reads the constant as the one value it lists, and folds onto it", () => {
    const prediction = predictDocument(before, after, [change]);
    expect(prediction.issues).toEqual([]);
    expect(
      (schemaIn(prediction.document, "Output")["properties"] as Schema)["role"],
    ).toEqual({ type: "string", enum: ["user", "assistant", "system"] });
    expect(serve(before, after, [change]).response({ role: "system" })).toEqual({
      role: "user",
    });
  });
});
