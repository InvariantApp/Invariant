/**
 * The Swagger 2.0 upgrade, where a second converter found it wrong.
 *
 * Each case is the smallest form of a disagreement found by converting the
 * corpus's real 2.0 documents two ways (`proving/swagger/oracle.mts`) and
 * settled by reading the 2.0 source. They hold whether the correction comes
 * from here or, one day, from the upgrader itself.
 */
import { describe, expect, it } from "vitest";
import { normalizeDocument, type OpenApiDocument, upgradeSwagger } from "./spec.ts";

type Json = Record<string, unknown>;

function swagger(paths: Json, extra: Json = {}): OpenApiDocument {
  return {
    swagger: "2.0",
    info: { title: "t", version: "1" },
    produces: ["application/json"],
    consumes: ["application/json"],
    paths,
    ...extra,
  } as OpenApiDocument;
}

const at = (document: OpenApiDocument, ...keys: string[]): unknown =>
  keys.reduce<unknown>((node, key) => (node as Json | undefined)?.[key], document);

describe("the Swagger 2.0 upgrade", () => {
  it("serves an operation's own media types, not the document's (Gitea's raw file download)", () => {
    const converted = upgradeSwagger(
      swagger({
        "/files/{path}": {
          get: {
            produces: ["application/octet-stream"],
            parameters: [{ name: "path", in: "path", required: true, type: "string" }],
            responses: { "200": { description: "the bytes", schema: { type: "file" } } },
          },
        },
      }),
    );
    expect(
      Object.keys(
        at(
          converted,
          "paths",
          "/files/{path}",
          "get",
          "responses",
          "200",
          "content",
        ) as Json,
      ),
    ).toEqual(["application/octet-stream"]);
  });

  it("keeps an example with the media type it was given for, and adds none it was not", () => {
    // Docker's archive endpoint produces a tar and illustrates its error as JSON.
    const converted = upgradeSwagger(
      swagger(
        {
          "/archive": {
            get: {
              produces: ["application/x-tar"],
              responses: {
                "404": {
                  description: "missing",
                  schema: { $ref: "#/definitions/Error" },
                  examples: { "application/json": { message: "no such container" } },
                },
              },
            },
          },
        },
        {
          definitions: {
            Error: { type: "object", properties: { message: { type: "string" } } },
          },
        },
      ),
    );
    expect(
      at(converted, "paths", "/archive", "get", "responses", "404", "content"),
    ).toEqual({
      "application/x-tar": { schema: { $ref: "#/components/schemas/Error" } },
    });
  });

  it("requires a form body that has a required field (Gitea's attachment upload)", () => {
    const converted = upgradeSwagger(
      swagger({
        "/assets": {
          post: {
            consumes: ["multipart/form-data"],
            parameters: [
              { name: "attachment", in: "formData", required: true, type: "file" },
              { name: "name", in: "formData", type: "string" },
            ],
            responses: { "201": { description: "made" } },
          },
        },
      }),
    );
    expect(at(converted, "paths", "/assets", "post", "requestBody", "required")).toBe(
      true,
    );
  });

  it("reads x-nullable as nullable, on a property and on a parameter (Docker)", () => {
    const converted = upgradeSwagger(
      swagger(
        {
          "/containers": {
            get: {
              parameters: [
                { name: "since", in: "query", type: "string", "x-nullable": true },
              ],
              responses: {
                "200": { description: "ok", schema: { $ref: "#/definitions/Container" } },
              },
            },
          },
        },
        {
          definitions: {
            Container: {
              type: "object",
              properties: { Annotations: { type: "object", "x-nullable": true } },
            },
          },
        },
      ),
    );
    expect(
      at(converted, "components", "schemas", "Container", "properties", "Annotations"),
    ).toEqual({ type: "object", nullable: true });
    const [parameter] = at(
      converted,
      "paths",
      "/containers",
      "get",
      "parameters",
    ) as Json[];
    expect(parameter?.["schema"]).toEqual({ type: "string", nullable: true });
    expect(JSON.stringify(converted)).not.toContain("x-nullable");
  });

  it("refuses a list where one schema belongs, and says where (Slack)", () => {
    const document = swagger(
      {
        "/channels": {
          get: {
            responses: {
              "200": { description: "ok", schema: { $ref: "#/definitions/Channel" } },
            },
          },
        },
      },
      {
        definitions: {
          Channel: {
            type: "object",
            properties: {
              latest: { items: [{ $ref: "#/definitions/Message" }, { type: "null" }] },
            },
          },
          Message: { type: "object" },
        },
      },
    );
    expect(() => normalizeDocument(document)).toThrow(
      "#/components/schemas/Channel/properties/latest/items is a list of schemas",
    );
  });

  it("leaves a list in an example alone, since an example is not a schema", () => {
    const document = swagger({
      "/pins": {
        get: {
          responses: {
            "200": {
              description: "ok",
              schema: { type: "object" },
              examples: { "application/json": { items: [{ type: "message" }] } },
            },
          },
        },
      },
    });
    expect(() => normalizeDocument(document)).not.toThrow();
  });
});
