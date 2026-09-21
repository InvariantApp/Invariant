/**
 * Changes to fields that sit behind a `$ref` or inside an `allOf`.
 *
 * Real specifications put most enums in their own schema and build most
 * objects from `allOf`. The proposer looked through the first and not the
 * second, and the compiler looked through neither, so across the real corpus
 * the proposer drafted Changes the compiler then said were impossible. These
 * run the closure check on both shapes, and prove that a shared schema is
 * never edited on behalf of a Change that names only one of its users.
 */
import {
  breakingEntries,
  describeEntry,
  diffDocuments,
  oasdiffAvailable,
} from "@invariant/diff";
import type { Change, JsonObject } from "@invariant/ir";
import { describe, expect, it } from "vitest";
import { predictDocument } from "./predict.ts";

const hasOasdiff = await oasdiffAvailable();

function document(schemas: JsonObject): JsonObject {
  const get = (name: string) => ({
    get: {
      operationId: `${name}.get`,
      responses: {
        "200": {
          description: "ok",
          content: {
            "application/json": {
              schema: { $ref: `#/components/schemas/${name}` },
            },
          },
        },
      },
    },
  });
  return {
    openapi: "3.0.3",
    info: { title: "t", version: "1" },
    paths: { "/orders": get("Order"), "/invoices": get("Invoice"), "/pets": get("Pet") },
    components: { schemas },
  };
}

const status = (values: string[]) => ({ type: "string", enum: values });

function shared(values: string[]): JsonObject {
  return document({
    Status: status(values),
    Order: {
      type: "object",
      properties: { status: { $ref: "#/components/schemas/Status" } },
    },
    Invoice: {
      type: "object",
      properties: { status: { $ref: "#/components/schemas/Status" } },
    },
    Pet: { type: "object", properties: { id: { type: "string" } } },
  });
}

const renameStatus = (schema: string): Change => ({
  irVersion: 1,
  id: `chg_${schema.toLowerCase()}_status`,
  summary: "b is called c now",
  scopes: [{ schema: `#/components/schemas/${schema}` }],
  ops: [
    {
      op: "convert",
      path: "/status",
      codec: {
        kind: "enumMap",
        pairs: [
          ["a", "a"],
          ["b", "c"],
        ],
      },
    },
  ],
});

async function residual(
  before: JsonObject,
  after: JsonObject,
  changes: Change[],
): Promise<string[]> {
  const prediction = predictDocument(before, after, changes);
  const entries = await diffDocuments(prediction.document, after);
  return [
    ...prediction.issues.map((issue) => `${issue.changeId}: ${issue.message}`),
    ...breakingEntries(entries).map(describeEntry),
  ];
}

describe.skipIf(!hasOasdiff)("a field behind a $ref", () => {
  it("is changed through the reference, and closes", async () => {
    const left = await residual(shared(["a", "b"]), shared(["a", "c"]), [
      renameStatus("Order"),
      renameStatus("Invoice"),
    ]);
    expect(left).toEqual([]);
  });

  it("does not change the other users of the shared schema", async () => {
    // Only Order is declared. Invoice uses the same Status schema and its
    // callers break too, so the release must still say so.
    const before = shared(["a", "b"]);
    const prediction = predictDocument(before, shared(["a", "c"]), [
      renameStatus("Order"),
    ]);
    expect(prediction.issues).toEqual([]);

    const schemas = (prediction.document["components"] as JsonObject)[
      "schemas"
    ] as JsonObject;
    expect(schemas["Status"]).toEqual(status(["a", "b"]));
    const original = (before["components"] as JsonObject)["schemas"] as JsonObject;
    expect(schemas["Invoice"]).toEqual(original["Invoice"]);

    const left = await residual(before, shared(["a", "c"]), [renameStatus("Order")]);
    expect(left.join("\n")).toContain("/invoices");
    expect(left.join("\n")).not.toContain("/orders");
  });
});

describe.skipIf(!hasOasdiff)("a field inside an allOf", () => {
  const pets = (field: string): JsonObject =>
    document({
      Base: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      Pet: {
        allOf: [
          { $ref: "#/components/schemas/Base" },
          {
            type: "object",
            properties: { [field]: { type: "string" } },
            required: [field],
          },
        ],
      },
      Order: { type: "object" },
      Invoice: { type: "object" },
    });

  it("is renamed where it lives, and closes", async () => {
    const left = await residual(pets("nickname"), pets("nick"), [
      {
        irVersion: 1,
        id: "chg_pet_nick",
        summary: "nickname is called nick now",
        scopes: [{ schema: "#/components/schemas/Pet" }],
        ops: [{ op: "move", from: "/nickname", to: "/nick" }],
      },
    ]);
    expect(left).toEqual([]);
  });
});
