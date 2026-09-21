/**
 * Documents real providers publish that the differ would not read, each in
 * its smallest form, compared through the differ the way the gate does.
 */
import type { OpenApiDocument } from "@invariant/contract";
import { describe, expect, it } from "vitest";
import { agreeingAllOf } from "./allof.ts";
import { wholeSchemaRefs } from "./deep-refs.ts";
import { diffDocuments, oasdiffAvailable } from "./oasdiff.ts";

const hasOasdiff = await oasdiffAvailable();

/** What sits at a path of keys, for reading results in assertions. */
function pick(value: unknown, ...keys: (string | number)[]): unknown {
  return keys.reduce<unknown>(
    (node, key) => (node as Record<string | number, unknown> | undefined)?.[key],
    value,
  );
}

function api(schemas: Record<string, unknown>, paths: Record<string, unknown> = {}) {
  return {
    openapi: "3.0.3",
    info: { title: "t", version: "1" },
    paths: {
      "/things": {
        get: {
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Thing" } },
              },
            },
          },
        },
      },
      ...paths,
    },
    components: { schemas },
  } as unknown as OpenApiDocument;
}

/** Okta's shape: an extension restating its base's default for its own case. */
const restatedDefault = (countRequired = false) =>
  api({
    Base: {
      type: "object",
      properties: {
        mode: { type: "string", default: "basic" },
        ...(countRequired ? { count: { type: "integer" } } : {}),
      },
      ...(countRequired ? { required: ["count"] } : {}),
    },
    Thing: {
      allOf: [
        { $ref: "#/components/schemas/Base" },
        { type: "object", properties: { mode: { type: "string", default: "advanced" } } },
      ],
    },
    Other: { allOf: [{ $ref: "#/components/schemas/Base" }] },
  });
const RESTATED_DEFAULT = restatedDefault();

/** PagerDuty's shape: a union branch named by where it sits in another schema. */
const deepReference = (withId = true) => {
  const document = api(
    {
      Tag: {
        allOf: [
          { type: "object", properties: withId ? { id: { type: "string" } } : {} },
          { type: "object", properties: { label: { type: "string" } } },
        ],
      },
      Thing: {
        type: "object",
        properties: {
          tag: { $ref: "#/components/schemas/Tag/allOf/0" },
          kind: {
            discriminator: {
              propertyName: "type",
              mapping: {
                text: "#/paths/~1notes/get/responses/200/content/application~1json/schema/oneOf/0",
              },
            },
            oneOf: [{ $ref: "#/components/schemas/Tag" }],
          },
        },
      },
    },
    {
      "/notes": {
        get: {
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Note" } },
              },
            },
          },
        },
      },
    },
  );
  (document["components"] as { schemas: Record<string, unknown> }).schemas["Note"] = {
    oneOf: [{ type: "object", properties: { type: { type: "string" } } }],
  };
  return document;
};
const DEEP_REFERENCE = deepReference();

describe("documents the differ would not read", () => {
  it("keeps the first default where allOf branches restate it, as the resolver does", () => {
    const agreed = agreeingAllOf(RESTATED_DEFAULT);
    const schemas = pick(agreed, "components", "schemas");
    expect(pick(schemas, "Thing", "allOf", 1, "properties", "mode")).toEqual({
      type: "string",
    });
    // The base keeps its default, for its other uses too.
    expect(pick(schemas, "Base", "properties", "mode", "default")).toBe("basic");
    // Nothing is copied when there is nothing to reconcile.
    const plain = api({ Thing: { type: "object" } });
    expect(agreeingAllOf(plain)).toBe(plain);
  });

  it("gives a reference into a schema's middle a schema of its own", () => {
    const whole = wholeSchemaRefs(DEEP_REFERENCE);
    const thing = pick(whole, "components", "schemas", "Thing");
    expect(pick(thing, "properties", "tag", "$ref")).toBe(
      "#/components/schemas/schemas__Tag__allOf__0",
    );
    expect(pick(whole, "components", "schemas", "schemas__Tag__allOf__0")).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
    });
    // A mapping that points through a $ref on its way is followed through it.
    expect(pick(thing, "properties", "kind", "discriminator", "mapping", "text")).toMatch(
      /^#\/components\/schemas\//,
    );
    expect(JSON.stringify(whole)).not.toContain("#/paths/");
  });

  it.skipIf(!hasOasdiff)(
    "lets the differ compare both, and find a real change in each",
    async () => {
      const first = await diffDocuments(RESTATED_DEFAULT, restatedDefault(true), {
        mode: "breaking",
      });
      expect(first.map((entry) => entry.id)).toContain(
        "response-required-property-added",
      );

      const second = await diffDocuments(DEEP_REFERENCE, deepReference(false), {
        mode: "changelog",
      });
      // At the field that uses the branch, as the provider wrote it. `kind` is
      // a union over the whole of Tag, so it loses `id` too, separately.
      const removed = second
        .filter((entry) => entry.id === "response-optional-property-removed")
        .map((entry) => entry.text);
      expect(removed.some((text) => text.includes("`tag/id`"))).toBe(true);
    },
  );
});
