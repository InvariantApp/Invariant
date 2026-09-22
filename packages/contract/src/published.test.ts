/**
 * What real providers publish, read the way they mean it, each in its
 * smallest form: the corpus lost every pair of a provider to each of these.
 */
import { describe, expect, it } from "vitest";
import { resolveSchema } from "./resolve.ts";
import { normalizeDocument, type OpenApiDocument, resolveRef } from "./spec.ts";

/** What sits at a path of keys, for reading results in assertions. */
function pick(value: unknown, ...keys: string[]): unknown {
  return keys.reduce<unknown>(
    (node, key) => (node as Record<string, unknown> | undefined)?.[key],
    value,
  );
}

const base = (extra: Record<string, unknown>): OpenApiDocument =>
  ({
    openapi: "3.0.3",
    info: { title: "t", version: "1" },
    paths: {},
    ...extra,
  }) as OpenApiDocument;

describe("what providers publish", () => {
  it("reads a schema that lists its properties as the object it is (Adyen)", () => {
    const input = base({
      components: {
        schemas: {
          AccountHolderDetails: {
            properties: { email: { type: "string" } },
            required: ["email"],
          },
          // Built from others, or a choice between them: theirs to say.
          Composed: { allOf: [{ $ref: "#/components/schemas/AccountHolderDetails" }] },
          Map: { additionalProperties: { type: "string" } },
          // An example that happens to hold a `properties` key is data.
          Sample: { type: "object", example: { properties: { a: 1 } } },
          // A field of that name is a field, and the map holding it is not a schema.
          Named: { type: "object", properties: { properties: { type: "string" } } },
        },
      },
    });
    const document = normalizeDocument(input);
    expect(pick(document, "components", "schemas", "AccountHolderDetails")).toEqual({
      properties: { email: { type: "string" } },
      required: ["email"],
      type: "object",
    });
    expect(pick(document, "components", "schemas", "Composed")).toEqual({
      allOf: [{ $ref: "#/components/schemas/AccountHolderDetails" }],
    });
    expect(pick(document, "components", "schemas", "Map")).toEqual({
      additionalProperties: { type: "string" },
      type: "object",
    });
    expect(pick(document, "components", "schemas", "Sample")).toEqual({
      type: "object",
      example: { properties: { a: 1 } },
    });
    expect(pick(document, "components", "schemas", "Named")).toEqual({
      type: "object",
      properties: { properties: { type: "string" } },
    });
  });

  it("reads an empty list of choices as none at all (Discord)", () => {
    const input = base({
      components: {
        schemas: {
          NameplatePalette: { type: "string", oneOf: [] },
          EventTypes: { type: "array", items: { type: "string", enum: [] } },
          // Beside another statement of the values, left as written.
          WebhookTypes: {
            type: "string",
            enum: [],
            allOf: [{ $ref: "#/components/schemas/NameplatePalette" }],
          },
        },
      },
    });
    const document = normalizeDocument(input);
    expect(pick(document, "components", "schemas", "NameplatePalette")).toEqual({
      type: "string",
    });
    expect(pick(document, "components", "schemas", "EventTypes")).toEqual({
      type: "array",
      items: { type: "string" },
    });
    expect(pick(document, "components", "schemas", "WebhookTypes")).toEqual({
      type: "string",
      enum: [],
      allOf: [{ $ref: "#/components/schemas/NameplatePalette" }],
    });
  });

  it("reads a union of constants typed once, on the union, as the enum it is (Discord)", () => {
    const input = base({
      components: {
        schemas: {
          GuildFeatures: {
            type: "string",
            oneOf: [
              {
                title: "ANIMATED_ICON",
                description: "Can set an animated icon",
                const: "ANIMATED_ICON",
              },
              { title: "BANNER", description: "Can set a banner", const: "BANNER" },
            ],
          },
          // A branch of another type means more than a list of values.
          Mixed: {
            type: "string",
            oneOf: [{ const: "a" }, { type: "integer", const: 1 }],
          },
        },
      },
    });
    const document = normalizeDocument(input);
    expect(pick(document, "components", "schemas", "GuildFeatures")).toEqual({
      type: "string",
      enum: ["ANIMATED_ICON", "BANNER"],
    });
    expect(pick(document, "components", "schemas", "Mixed")).toEqual({
      type: "string",
      oneOf: [{ const: "a" }, { type: "integer", const: 1 }],
    });
  });

  it("reads a union of constants as the enum it is (Qdrant)", () => {
    const branch = (value: string) => ({
      description: `The ${value} placement.`,
      type: "string",
      enum: [value],
    });
    const input = base({
      components: {
        schemas: {
          Memory: {
            description: "Memory placement.",
            oneOf: [
              branch("cold"),
              branch("cached"),
              { type: "string", const: "pinned" },
            ],
          },
          // A union that means more than its values is left as it is.
          Mixed: { oneOf: [branch("a"), { type: "integer", enum: [1] }] },
          Shaped: { anyOf: [branch("a"), { type: "string", enum: ["b"], maxLength: 1 }] },
          Discriminated: {
            oneOf: [branch("a"), branch("b")],
            discriminator: { propertyName: "kind" },
          },
        },
      },
    });
    const document = normalizeDocument(input);
    expect(pick(document, "components", "schemas", "Memory")).toEqual({
      description: "Memory placement.",
      type: "string",
      enum: ["cold", "cached", "pinned"],
    });
    for (const name of ["Mixed", "Shaped", "Discriminated"]) {
      expect(pick(document, "components", "schemas", name)).toEqual(
        pick(input, "components", "schemas", name),
      );
    }
    expect(pick(input, "components", "schemas", "Memory", "oneOf")).toHaveLength(3);
  });

  it("follows a reference into a list by position, and a percent-encoded one (PagerDuty)", () => {
    const document = base({
      components: {
        responses: {
          Data: {
            description: "ok",
            content: {
              "application/json": {
                schema: { oneOf: [{ type: "string" }, { type: "integer" }] },
              },
            },
          },
        },
        schemas: { "Odd Name": { type: "boolean" } },
      },
    });
    expect(
      resolveRef(
        document,
        "#/components/responses/Data/content/application~1json/schema/oneOf/1",
      ),
    ).toEqual({ type: "integer" });
    expect(resolveRef(document, "#/components/schemas/Odd%20Name")).toEqual({
      type: "boolean",
    });
    expect(
      resolveRef(
        document,
        "#/components/responses/Data/content/application~1json/schema/oneOf/01",
      ),
    ).toBeUndefined();
  });

  it("reads a response that refers to a request body shaped like one as a response (PagerDuty)", () => {
    const body = {
      description: "the data",
      content: { "application/json": { schema: { type: "object" } } },
    };
    const input = base({
      paths: {
        "/data": {
          put: {
            requestBody: { $ref: "#/components/requestBodies/Data" },
            responses: { "200": { $ref: "#/components/requestBodies/Data" } },
          },
        },
      },
      components: { requestBodies: { Data: body } },
    });
    const document = normalizeDocument(input);
    expect(pick(document, "paths", "/data", "put", "responses", "200")).toEqual({
      $ref: "#/components/responses/Data",
    });
    expect(pick(document, "components", "responses", "Data")).toEqual(body);
    // The request body is still one, and the input is untouched.
    expect(pick(document, "paths", "/data", "put", "requestBody")).toEqual({
      $ref: "#/components/requestBodies/Data",
    });
    expect(pick(input, "components", "responses")).toBeUndefined();
  });

  it("reads allOf lists of values with nothing in common as the first list (PagerDuty, Cloudflare)", () => {
    const document = base({
      components: {
        schemas: {
          LogEntry: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["acknowledge_log_entry", "notify_log_entry"],
              },
            },
          },
          AcknowledgeLogEntry: {
            allOf: [
              { $ref: "#/components/schemas/LogEntry" },
              { properties: { type: { enum: ["acknowledgement_log_entry"] } } },
            ],
          },
        },
      },
    });
    const merged = resolveSchema(document, {
      $ref: "#/components/schemas/AcknowledgeLogEntry",
    });
    expect(pick(merged, "properties", "type", "enum")).toEqual([
      "acknowledge_log_entry",
      "notify_log_entry",
    ]);
  });
});
