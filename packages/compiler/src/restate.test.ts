/**
 * The same values, stated another way.
 *
 * Figma rewrote a node's `Effect` from one object, whose `type` named four
 * kinds, into a choice between a shadow and a blur, each declaring the fields
 * that kind has. Nothing an old caller is sent changed, and nothing should be
 * rewritten; but the claim is only taken where it is proved, since an old
 * caller sent a value its contract ruled out is what the product prevents.
 */
import type { OpenApiDocument } from "@invariant-app/contract";
import { parseChange } from "@invariant-app/ir";
import { describe, expect, it } from "vitest";
import { chainProgram } from "./chain.ts";
import { derive } from "./derive.ts";
import { predictDocument } from "./predict.ts";

type Schemas = Record<string, unknown>;

function contract(schemas: Schemas): OpenApiDocument {
  const body = (name: string) => ({
    content: { "application/json": { schema: { $ref: `#/components/schemas/${name}` } } },
  });
  return {
    openapi: "3.1.0",
    info: { title: "nodes", version: "1" },
    paths: {
      "/nodes/{id}": {
        get: {
          operationId: "getNode",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { "200": { description: "ok", ...body("Node") } },
        },
      },
      "/filters": {
        post: {
          operationId: "createFilter",
          requestBody: body("Filter"),
          responses: { "204": { description: "made" } },
        },
      },
    },
    components: {
      schemas: {
        Node: {
          type: "object",
          properties: {
            id: { type: "string" },
            effects: { type: "array", items: { $ref: "#/components/schemas/Effect" } },
          },
          required: ["id"],
        },
        Filter: { type: "object", properties: { value: { type: "string" } } },
        ...schemas,
      },
    },
  } as unknown as OpenApiDocument;
}

const oneEffect = {
  Effect: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR"] },
      radius: { type: "number" },
      offset: { type: "number" },
    },
    required: ["type", "radius"],
  },
};

const shadow = (kind: string) => ({
  type: "object",
  properties: {
    type: { type: "string", enum: [kind] },
    radius: { type: "number" },
    offset: { type: "number" },
  },
  required: ["type", "radius", "offset"],
});

const effectKinds = (kinds: string[]) => ({
  Effect: {
    oneOf: kinds.map((kind) => ({ $ref: `#/components/schemas/${kind}Effect` })),
    discriminator: { propertyName: "type" },
  },
  ...Object.fromEntries(
    kinds.map((kind) => [
      `${kind}Effect`,
      kind === "LAYER_BLUR"
        ? {
            type: "object",
            properties: {
              type: { type: "string", enum: [kind] },
              radius: { type: "number" },
            },
            required: ["radius"],
          }
        : shadow(kind),
    ]),
  ),
});

const restate = (schema: string, path = "") =>
  parseChange({
    irVersion: 1,
    id: "chg_effect_kinds",
    summary: "An effect is stated as one of its kinds.",
    scopes: [{ schema: `#/components/schemas/${schema}` }],
    ops: [{ op: "restate", path }],
  });

const schemasOf = (document: OpenApiDocument) =>
  (document as unknown as { components: { schemas: Schemas } }).components.schemas;

describe("an object stated as a choice of its kinds", () => {
  const before = contract(oneEffect);
  const after = contract(effectKinds(["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR"]));

  it("is predicted as the new contract states it", () => {
    const prediction = predictDocument(before, after, [restate("Effect")]);
    expect(prediction.issues).toEqual([]);
    const schemas = schemasOf(prediction.document);
    expect(schemas["Effect"]).toEqual(schemasOf(after)["Effect"]);
    // The kinds it now refers to came over with it.
    expect(schemas["LAYER_BLUREffect"]).toEqual(schemasOf(after)["LAYER_BLUREffect"]);
  });

  it("is stated as written where nothing on the wire reaches it", () => {
    // Found by its name in the new contract, whose entry is the schema
    // itself, never a reference back to the name being restated.
    const unused = (schemas: Schemas) => ({
      ...schemas,
      Spare: (schemas as Record<string, unknown>)["Effect"],
    });
    const prediction = predictDocument(
      contract(unused(oneEffect)),
      contract(unused(effectKinds(["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR"]))),
      [restate("Spare")],
    );
    expect(prediction.issues).toEqual([]);
    expect(schemasOf(prediction.document)["Spare"]).toEqual(schemasOf(after)["Effect"]);
  });

  it("is stated by its own name where the wire reaches it only through a choice", () => {
    // Figma reaches a text node only through a choice of every kind of node:
    // the place on the wire names the choice, and the text node is one branch.
    const throughChoice = (schemas: Schemas): Schemas => ({
      ...schemas,
      Paint: {
        type: "object",
        properties: { color: { type: "string" } },
        required: ["color"],
      },
      Node: {
        type: "object",
        properties: {
          effects: {
            type: "array",
            items: {
              oneOf: [
                { $ref: "#/components/schemas/Effect" },
                { $ref: "#/components/schemas/Paint" },
              ],
            },
          },
        },
      },
    });
    const prediction = predictDocument(
      contract(throughChoice(oneEffect)),
      contract(throughChoice(effectKinds(["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR"]))),
      [restate("Effect")],
    );
    expect(prediction.issues).toEqual([]);
    expect(schemasOf(prediction.document)["Effect"]).toEqual(schemasOf(after)["Effect"]);
  });

  it("passes values through untouched, and loses nothing", () => {
    const change = restate("Effect");
    const { program, issues } = chainProgram("nodes", "v2", "sha256:2", [
      { label: "v2", parent: "v1", from: before, to: after, changes: [change] },
    ]);
    expect(issues).toEqual([]);
    expect(program.contracts["v1"]?.sites).toEqual({});
    expect(derive(change).runtime).toBe("exact");
  });

  it("is refused where a kind old callers were never promised is sent", () => {
    const prediction = predictDocument(
      before,
      contract(effectKinds(["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR", "GLOW"])),
      [restate("Effect")],
    );
    expect(prediction.issues.map((issue) => issue.message).join()).toContain(
      "old callers could be sent one their contract ruled out",
    );
  });

  it("is refused where a field old callers were always given may be missing", () => {
    const loose: Schemas = effectKinds(["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR"]);
    (loose["DROP_SHADOWEffect"] as { required: string[] }).required = ["type"];
    const prediction = predictDocument(before, contract(loose), [restate("Effect")]);
    expect(prediction.issues.map((issue) => issue.message).join()).toContain(
      "is not the same values restated",
    );
  });
});

describe("a request body stated another way", () => {
  const plain = {
    Filter: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["tag", "owner"] },
        value: { type: "string" },
      },
      required: ["kind", "value"],
    },
  };
  const byKind = (kinds: string[]) => ({
    Filter: {
      oneOf: kinds.map((kind) => ({
        type: "object",
        properties: { kind: { type: "string", const: kind }, value: { type: "string" } },
        required: ["kind", "value"],
      })),
    },
  });

  it("is taken where everything old callers send is still accepted", () => {
    const prediction = predictDocument(
      contract(plain),
      contract(byKind(["tag", "owner", "team"])),
      [restate("Filter")],
    );
    expect(prediction.issues).toEqual([]);
  });

  it("is refused where something old callers send would be turned away", () => {
    const prediction = predictDocument(contract(plain), contract(byKind(["tag"])), [
      restate("Filter"),
    ]);
    expect(prediction.issues.map((issue) => issue.message).join()).toContain(
      "the new contract could refuse one old callers send",
    );
  });
});

describe("a field renamed", () => {
  it("is not a restatement, even where every value is still allowed (PayPal)", () => {
    const issues = (name: string) => ({
      Problem: {
        type: "object",
        properties: { [name]: { type: "array", items: { type: "string" } } },
      },
      Node: {
        type: "object",
        properties: { problem: { $ref: "#/components/schemas/Problem" } },
      },
    });
    const prediction = predictDocument(
      contract(issues("issues")),
      contract(issues("details")),
      [restate("Problem")],
    );
    expect(prediction.issues.map((issue) => issue.message).join()).toContain(
      "/issues the new schema no longer names it",
    );
  });
});

describe("a restatement that refers to a schema the old contract states differently", () => {
  it("is refused, since written in it would mean the old schema (Plaid)", () => {
    // The identity wrote its balance out in place, nullable; the new identity
    // is built from a base whose balance refers to a named balance that
    // became nullable, and the old named balance, used elsewhere, still says
    // it never is.
    const balance = (nullable: boolean) => ({
      type: "object",
      properties: {
        available: { type: "number", ...(nullable ? { nullable: true } : {}) },
      },
    });
    const schemas = (identity: unknown, named: unknown): Schemas => ({
      Identity: identity,
      Balance: named,
      Base: {
        type: "object",
        properties: { balances: { $ref: "#/components/schemas/Balance" } },
      },
      Node: {
        type: "object",
        properties: {
          identity: { $ref: "#/components/schemas/Identity" },
          balance: { $ref: "#/components/schemas/Balance" },
        },
      },
    });
    const before = contract(
      schemas(
        { type: "object", properties: { balances: balance(true) } },
        balance(false),
      ),
    );
    const after = contract(
      schemas({ allOf: [{ $ref: "#/components/schemas/Base" }] }, balance(true)),
    );
    // Written into the old contract, the new identity's base would find the
    // old balance, which is not what was proved: refused, naming it.
    const prediction = predictDocument(before, after, [restate("Identity")]);
    expect(prediction.issues.map((issue) => issue.message).join()).toContain(
      "it refers to #/components/schemas/Balance, and the old contract states it differently",
    );
  });
});
