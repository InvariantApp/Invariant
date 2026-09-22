/**
 * Two spellings of the same schema are not a change, and a change is still
 * one. Reproduced from Mistral's 2026-03-04 release, which rewrote single
 * values as `const` and moved an inline list of values into a named schema,
 * and was blocked on 347 breaking changes nobody could see.
 */
import type { OpenApiDocument } from "@invariant-app/contract";
import type { JsonObject } from "@invariant-app/ir";
import { describe, expect, it } from "vitest";
import { equivalentForms } from "./equivalent-forms.ts";
import { diffDocuments } from "./oasdiff.ts";
import { breakingEntries } from "./policy.ts";

function api(message: JsonObject, schemas: JsonObject = {}): OpenApiDocument {
  return {
    openapi: "3.1.0",
    info: { title: "chat", version: "1" },
    paths: {
      "/chat": {
        post: {
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Message" } },
            },
          },
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Message" } },
              },
            },
          },
        },
      },
    },
    components: { schemas: { Message: message, ...schemas } },
  } as unknown as OpenApiDocument;
}

const before = api({
  type: "object",
  required: ["role"],
  properties: {
    role: { type: "string", enum: ["assistant"] },
    detail: {
      anyOf: [{ type: "string", enum: ["low", "high", "auto"] }, { type: "null" }],
    },
  },
});

const after = api(
  {
    type: "object",
    required: ["role"],
    properties: {
      role: { type: "string", const: "assistant" },
      detail: { anyOf: [{ $ref: "#/components/schemas/ImageDetail" }, { type: "null" }] },
    },
  },
  {
    ImageDetail: { title: "ImageDetail", type: "string", enum: ["low", "high", "auto"] },
  },
);

describe("two ways of writing one schema", () => {
  it("are one form once prepared, and nothing else is touched", () => {
    const prepared = equivalentForms(after) as unknown as {
      components: { schemas: { Message: { properties: Record<string, JsonObject> } } };
    };
    expect(prepared.components.schemas.Message.properties["role"]).toEqual({
      type: "string",
      enum: ["assistant"],
    });
    expect(prepared.components.schemas.Message.properties["detail"]).toEqual({
      anyOf: [{ type: "string", enum: ["low", "high", "auto"] }, { type: "null" }],
    });
    // The document passed in is left as it was.
    expect(JSON.stringify(after)).toContain('"const":"assistant"');
  });

  it("leaves a property named const, an example and a reference to an object alone", () => {
    const document = api(
      {
        type: "object",
        properties: {
          const: { type: "string" },
          owner: { $ref: "#/components/schemas/Owner" },
        },
        example: { const: "x" },
      },
      { Owner: { type: "object", properties: { id: { type: "string" } } } },
    );
    const prepared = equivalentForms(document) as unknown as {
      components: { schemas: { Message: JsonObject } };
    };
    expect(prepared.components.schemas.Message).toEqual(
      (document as unknown as { components: { schemas: { Message: JsonObject } } })
        .components.schemas.Message,
    );
  });

  it("are not a breaking change", async () => {
    expect(breakingEntries(await diffDocuments(before, after))).toEqual([]);
  });

  it("do not hide a real change made in the same release", async () => {
    const narrowed = structuredClone(after) as unknown as {
      components: { schemas: { ImageDetail: { enum: string[] } } };
    };
    narrowed.components.schemas.ImageDetail.enum = ["low", "high"];
    const entries = breakingEntries(
      await diffDocuments(before, narrowed as unknown as OpenApiDocument),
    );
    expect(entries.map((entry) => entry.id)).toContain(
      "request-property-enum-value-removed",
    );
  });
});

describe("a way to authenticate naming a scheme the document never declares", () => {
  const secured = (security: JsonObject[], declared: string[] = ["bearer"]) =>
    ({
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      paths: {
        "/x": {
          delete: {
            operationId: "deleteX",
            security,
            responses: { "204": { description: "gone" } },
          },
        },
      },
      components: {
        securitySchemes: Object.fromEntries(
          declared.map((name) => [name, { type: "http", scheme: "bearer" }]),
        ),
      },
    }) as unknown as OpenApiDocument;
  const securityBreaks = async (before: OpenApiDocument, after: OpenApiDocument) =>
    breakingEntries(await diffDocuments(before, after)).filter((entry) =>
      entry.id.includes("security"),
    );

  // Supabase listed `fga_permissions` beside `bearer` and never declared it.
  it("is not reported when it is removed", async () => {
    expect(
      await securityBreaks(
        secured([{ bearer: [] }, { fga_permissions: ["branch_delete"] }]),
        secured([{ bearer: [] }]),
      ),
    ).toEqual([]);
  });

  it("leaves a declared scheme's removal reported", async () => {
    expect(
      await securityBreaks(
        secured([{ bearer: [] }, { key: [] }], ["bearer", "key"]),
        secured([{ bearer: [] }], ["bearer", "key"]),
      ),
    ).not.toEqual([]);
  });

  it("is kept where every way listed names one, rather than listing none", () => {
    const form = equivalentForms(
      secured([{ fga_permissions: [] }]),
    ) as unknown as JsonObject;
    expect(JSON.stringify(form)).toContain("fga_permissions");
  });
});
