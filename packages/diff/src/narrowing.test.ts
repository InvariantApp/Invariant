import type { OpenApiDocument } from "@invariant-app/contract";
import { describe, expect, it } from "vitest";
import { diffDocuments } from "./oasdiff.ts";

/** An error response whose `details[].location` is written as given. */
const withLocation = (location: object, union = false) =>
  ({
    openapi: "3.0.3",
    info: { title: "t", version: "1" },
    paths: {
      "/x": {
        get: {
          operationId: "getX",
          responses: {
            "400": {
              description: "bad",
              content: {
                "application/json": {
                  schema: union
                    ? {
                        oneOf: [
                          { $ref: "#/components/schemas/Error" },
                          { type: "object", title: "Other", properties: {} },
                        ],
                      }
                    : { $ref: "#/components/schemas/Error" },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Error: {
          type: "object",
          title: "Bad Request Error",
          properties: {
            details: {
              type: "array",
              items: {
                type: "object",
                properties: { location: { type: "string", ...location } },
              },
            },
          },
        },
      },
    },
  }) as unknown as OpenApiDocument;

const added = async (before: object, after: object, union = false) =>
  (await diffDocuments(withLocation(before, union), withLocation(after, union)))
    .filter((entry) => entry.id === "response-property-enum-value-added")
    .map((entry) => entry.text);

describe("a response field that took a list of values", () => {
  // PayPal's error `location`: any string, then one of body, path or query.
  it("is not reported where it allowed any value before", async () => {
    expect(await added({}, { enum: ["body", "path", "query"] })).toEqual([]);
  });

  it("is not reported through a union's branch either", async () => {
    expect(await added({}, { enum: ["body", "path"] }, true)).toEqual([]);
    expect(await added({ enum: ["body"] }, { enum: ["body", "path"] }, true)).toEqual([
      "added the new `path` enum value to the `oneOf[subschema #1: Bad Request Error]/details/items/location` response property for the response status `400`",
    ]);
  });

  it("is still reported where it grew a list it already had", async () => {
    expect(await added({ enum: ["body"] }, { enum: ["body", "path"] })).toEqual([
      "added the new `path` enum value to the `details/items/location` response property for the response status `400`",
    ]);
  });

  it("is still reported where the old value was a constant", async () => {
    expect(await added({ const: "body" }, { enum: ["body", "path"] })).toHaveLength(1);
  });
});

describe("a request field whose list of values went", () => {
  // Mistral's fine-tuning `model`: one of nine names, then any string.
  const withModel = (model: object) =>
    ({
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      paths: {
        "/jobs": {
          post: {
            operationId: "createJob",
            parameters: [
              { name: "kind", in: "query", schema: { type: "string", ...model } },
            ],
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { model: { type: "string", ...model } },
                  },
                },
              },
            },
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { model: { type: "string", ...model } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }) as unknown as OpenApiDocument;
  const removed = async (before: object, after: object) =>
    (await diffDocuments(withModel(before), withModel(after)))
      .filter((entry) => entry.id.endsWith("enum-value-removed"))
      .map((entry) => entry.id);

  it("is not reported for requests, which still accept every value old callers send", async () => {
    expect(await removed({ enum: ["a", "b"] }, {})).toEqual([
      "response-property-enum-value-removed",
      "response-property-enum-value-removed",
    ]);
  });

  it("is still reported where the list only shrank", async () => {
    expect(await removed({ enum: ["a", "b"] }, { enum: ["a"] })).toEqual([
      "request-parameter-enum-value-removed",
      "request-property-enum-value-removed",
      "response-property-enum-value-removed",
    ]);
  });
});
