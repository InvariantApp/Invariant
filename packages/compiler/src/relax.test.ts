/**
 * A bound on a value that moved.
 *
 * Twilio raised hundreds of response maximums in one release, each one a value
 * an old caller's contract ruled out and may now be sent. Nothing should be
 * rewritten, and the gate should say so and ask for the loss to be
 * acknowledged. A bound that narrowed on something old callers send is
 * different: they would be refused for what their contract allowed, and no
 * Change may pretend otherwise.
 */
import type { OpenApiDocument } from "@invariant-app/contract";
import { narrows, parseChange } from "@invariant-app/ir";
import { describe, expect, it } from "vitest";
import { chainProgram } from "./chain.ts";
import { derive } from "./derive.ts";
import { predictDocument } from "./predict.ts";

function messages(maxLength: number | undefined): OpenApiDocument {
  const body = (name: string) => ({
    content: { "application/json": { schema: { $ref: `#/components/schemas/${name}` } } },
  });
  const text = { type: "string", ...(maxLength === undefined ? {} : { maxLength }) };
  return {
    openapi: "3.1.0",
    info: { title: "messages", version: "1" },
    paths: {
      "/messages": {
        post: {
          operationId: "createMessage",
          requestBody: body("MessageCreate"),
          responses: { "201": { description: "made", ...body("Message") } },
        },
      },
    },
    components: {
      schemas: {
        Message: { type: "object", properties: { body: text } },
        MessageCreate: { type: "object", properties: { body: text } },
      },
    },
  } as unknown as OpenApiDocument;
}

const relax = (schema: string, maxLength: number | null) =>
  parseChange({
    irVersion: 1,
    id: "chg_body_length",
    summary: "A message body is bounded differently.",
    scopes: [{ schema: `#/components/schemas/${schema}` }],
    ops: [{ op: "relax", path: "/body", set: { maxLength } }],
  });

describe("a response bound that widened", () => {
  const change = relax("Message", 1600);

  it("is predicted as the new contract has it", () => {
    const prediction = predictDocument(messages(160), messages(1600), [change]);
    expect(prediction.issues).toEqual([]);
    const predicted = prediction.document as unknown as {
      components: { schemas: { Message: { properties: { body: unknown } } } };
    };
    expect(predicted.components.schemas.Message.properties.body).toEqual({
      type: "string",
      maxLength: 1600,
    });
  });

  it("passes values through untouched, as a declared loss", () => {
    const { program, issues } = chainProgram("messages", "v2", "sha256:2", [
      {
        label: "v2",
        parent: "v1",
        from: messages(160),
        to: messages(1600),
        changes: [change],
      },
    ]);
    expect(issues).toEqual([]);
    expect(program.contracts["v1"]?.sites).toEqual({});
    expect(derive(change).runtime).toBe("declared-lossy");
  });

  it("can be removed altogether", () => {
    expect(
      predictDocument(messages(160), messages(undefined), [relax("Message", null)])
        .issues,
    ).toEqual([]);
  });
});

describe("a request bound that narrowed", () => {
  it("is refused, because old callers would be turned away", () => {
    const prediction = predictDocument(messages(1600), messages(160), [
      relax("MessageCreate", 160),
    ]);
    expect(prediction.issues.map((issue) => issue.message).join()).toMatch(
      /would be refused for what their contract allowed/,
    );
  });

  it("is allowed where it only widened", () => {
    expect(
      predictDocument(messages(160), messages(1600), [relax("MessageCreate", 1600)])
        .issues,
    ).toEqual([]);
  });
});

describe("which way a bound moves", () => {
  it("knows upper and lower bounds, patterns and multiples", () => {
    expect(narrows("maxLength", 10, 5)).toBe(true);
    expect(narrows("maxLength", 10, 20)).toBe(false);
    expect(narrows("maxLength", 10, null)).toBe(false);
    expect(narrows("maxLength", undefined, 10)).toBe(true);
    expect(narrows("minimum", 0, 1)).toBe(true);
    expect(narrows("minimum", 1, 0)).toBe(false);
    expect(narrows("pattern", "^a", "^a$")).toBe(true);
    expect(narrows("multipleOf", 0.01, 0.1)).toBe(true);
    expect(narrows("multipleOf", 0.1, 0.05)).toBe(false);
    expect(narrows("uniqueItems", false, true)).toBe(true);
    expect(narrows("uniqueItems", true, false)).toBe(false);
  });

  it("knows the types a value may be", () => {
    expect(narrows("type", "string", ["string", "integer"])).toBe(false);
    expect(narrows("type", "integer", ["string", "number"])).toBe(false);
    expect(narrows("type", "string", ["integer", "boolean"])).toBe(true);
    expect(narrows("type", ["string", "boolean"], ["string", "integer"])).toBe(true);
    // A value that stated no type could be anything, and now cannot.
    expect(narrows("type", undefined, ["string", "integer"])).toBe(true);
    expect(narrows("type", "string", null)).toBe(false);
  });
});

describe("a value that may now be one of several types (Okta)", () => {
  // Okta's user schema attributes listed an enum's values as text, and a
  // later release as text or whole numbers, in what old callers send and are
  // sent alike.
  function attributes(items: Record<string, unknown>): OpenApiDocument {
    const body = {
      content: {
        "application/json": { schema: { $ref: "#/components/schemas/Attribute" } },
      },
    };
    return {
      openapi: "3.0.3",
      info: { title: "attributes", version: "1" },
      paths: {
        "/attributes": {
          post: {
            operationId: "updateAttribute",
            requestBody: body,
            responses: { "200": { description: "updated", ...body } },
          },
        },
      },
      components: {
        schemas: {
          Attribute: {
            type: "object",
            properties: { enum: { type: "array", items } },
          },
        },
      },
    } as unknown as OpenApiDocument;
  }
  const before = attributes({ type: "string" });
  const after = attributes({ anyOf: [{ type: "string" }, { type: "integer" }] });
  const change = (ops: unknown[]) =>
    parseChange({
      irVersion: 1,
      id: "chg_attribute_enum_items",
      summary: "An attribute's listed values may now be whole numbers.",
      scopes: [{ schema: "#/components/schemas/Attribute" }],
      ops,
    });
  const relaxed = { op: "relax", path: "/enum/*", set: { type: ["string", "integer"] } };

  it("is predicted as a choice of those types, restated as the new contract writes it", () => {
    const prediction = predictDocument(before, after, [
      change([relaxed, { op: "restate", path: "/enum/*" }]),
    ]);
    expect(prediction.issues).toEqual([]);
    const schemas = (
      prediction.document as unknown as {
        components: { schemas: Record<string, unknown> };
      }
    ).components.schemas;
    expect(schemas["Attribute"]).toEqual(
      (after as unknown as { components: { schemas: Record<string, unknown> } })
        .components.schemas["Attribute"],
    );
  });

  it("reads a choice of nothing but types as those types", () => {
    // Mistral wrote an agent's version as `anyOf: [integer, null]`, and then
    // as text, a whole number or null.
    const nullable = (types: string[]) =>
      attributes({ anyOf: types.map((type) => ({ type })) });
    const prediction = predictDocument(
      nullable(["integer", "null"]),
      nullable(["string", "integer", "null"]),
      [change([relaxed, { op: "restate", path: "/enum/*" }])],
    );
    expect(prediction.issues).toEqual([]);
    const schemas = (
      prediction.document as unknown as {
        components: { schemas: Record<string, { properties: { enum: unknown } }> };
      }
    ).components.schemas;
    expect(schemas["Attribute"]?.properties.enum).toEqual({
      type: "array",
      items: { anyOf: [{ type: "string" }, { type: "integer" }, { type: "null" }] },
    });
  });

  it("is a declared loss with nothing to run", () => {
    const relax = change([relaxed]);
    expect(derive(relax).runtime).toBe("declared-lossy");
    expect(derive(relax).reasons.join()).toContain("may now be string or integer");
  });

  it("refuses types that leave out one the value was, which is a convert", () => {
    const prediction = predictDocument(before, after, [
      change([{ op: "relax", path: "/enum/*", set: { type: ["integer", "boolean"] } }]),
    ]);
    expect(prediction.issues.map((issue) => issue.message).join()).toMatch(
      /a type that went is a convert/,
    );
  });
});

describe("a response vocabulary that lost values", () => {
  const states = (values: string[]): OpenApiDocument =>
    ({
      openapi: "3.1.0",
      info: { title: "artifacts", version: "1" },
      paths: {
        "/artifacts/{id}": {
          get: {
            operationId: "getArtifact",
            responses: {
              "200": {
                description: "one",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Artifact" },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Artifact: {
            type: "object",
            properties: { state: { type: "string", enum: values } },
          },
        },
      },
    }) as unknown as OpenApiDocument;
  const narrowed = (values: string[]) =>
    parseChange({
      irVersion: 1,
      id: "chg_state_values",
      summary: "An artifact is never deleted any more.",
      scopes: [{ schema: "#/components/schemas/Artifact" }],
      ops: [{ op: "relax", path: "/state", set: { enum: values } }],
    });

  it("is predicted as the new contract has it, and is a declared loss with nothing to run", () => {
    const change = narrowed(["ENABLED", "DISABLED"]);
    const prediction = predictDocument(
      states(["ENABLED", "DISABLED", "DELETED"]),
      states(["ENABLED", "DISABLED"]),
      [change],
    );
    expect(prediction.issues).toEqual([]);
    expect(derive(change).runtime).toBe("declared-lossy");
    expect(derive(change).reasons.join()).toMatch(/will never see it/);
  });

  it("refuses one that grew, which is a fold for a person to decide", () => {
    const prediction = predictDocument(
      states(["ENABLED", "DISABLED"]),
      states(["ENABLED", "DISABLED", "ARCHIVED"]),
      [narrowed(["ENABLED", "DISABLED", "ARCHIVED"])],
    );
    expect(prediction.issues.map((issue) => issue.message).join()).toMatch(
      /never heard of, which a fold decides/,
    );
  });

  it("narrows by the values that went, whatever order the rest are in", () => {
    expect(narrows("enum", ["a", "b", "c"], ["c", "a"])).toBe(true);
    expect(narrows("enum", ["a", "b"], ["b", "a"])).toBe(false);
  });
});
