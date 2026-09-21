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
