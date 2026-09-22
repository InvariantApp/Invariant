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
