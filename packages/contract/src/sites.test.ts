import { describe, expect, it } from "vitest";
import { findSchemaSites, schemaDirections } from "./sites.ts";
import { loadContract } from "./spec.ts";

const HEAD = new URL("../../../fixtures/provider-acme/openapi/head.json", import.meta.url)
  .pathname;

describe("schema site resolution", () => {
  it("finds every place Payment reaches the wire, including inside a list", async () => {
    const contract = await loadContract(HEAD, "head");
    const { sites, unsupported } = findSchemaSites(
      contract.document,
      "#/components/schemas/Payment",
    );
    expect(unsupported).toEqual([]);
    expect(
      sites.map(
        (s) =>
          `${s.operationId} ${s.direction}${s.status ? ` ${s.status}` : ""} ${s.prefix || "(root)"}`,
      ),
    ).toEqual([
      "payments.list response 200 /data/*",
      "payments.create response 201 (root)",
      "payments.retrieve response 200 (root)",
    ]);
  });

  it("separates request and response uses of the create params schema", async () => {
    const contract = await loadContract(HEAD, "head");
    const { sites } = findSchemaSites(
      contract.document,
      "#/components/schemas/PaymentCreateParams",
    );
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({
      operationId: "payments.create",
      direction: "request",
      prefix: "",
    });
  });

  it("finds the shared error schema across every failure response", async () => {
    const contract = await loadContract(HEAD, "head");
    const { sites } = findSchemaSites(contract.document, "#/components/schemas/Error");
    expect(sites.every((s) => s.direction === "response")).toBe(true);
    expect(new Set(sites.map((s) => s.status))).toEqual(new Set(["400", "401", "404"]));
  });
});

describe("unions on the way to a schema", () => {
  const document = (body: object) => ({
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/things": {
        get: {
          operationId: "things.get",
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: body } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Card: { type: "object", properties: { last4: { type: "string" } } },
        Bank: { type: "object", properties: { iban: { type: "string" } } },
        Thing: { type: "object", properties: { id: { type: "string" } } },
      },
    },
  });
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

  it("refuses a schema reached through a oneOf whose branches nothing tells apart", () => {
    // Which branch a value took is then not something the runtime can tell,
    // so a transform placed there could apply to the wrong kind of value.
    const scan = findSchemaSites(
      document({
        type: "object",
        properties: { method: { oneOf: [ref("Card"), ref("Bank")] } },
      }) as never,
      "#/components/schemas/Card",
    );
    expect(scan.sites).toEqual([]);
    expect(scan.unsupported).toEqual([
      "things.get response 200: /method reaches the schema through oneOf, and nothing tells its branches apart",
    ]);
  });

  it("places a guard where a discriminator names the branch", () => {
    const scan = findSchemaSites(
      document({
        type: "object",
        properties: {
          method: {
            oneOf: [ref("Card"), ref("Bank")],
            discriminator: {
              propertyName: "kind",
              mapping: {
                card: "#/components/schemas/Card",
                debit: "#/components/schemas/Card",
              },
            },
          },
        },
      }) as never,
      "#/components/schemas/Card",
    );
    expect(scan.unsupported).toEqual([]);
    expect(scan.sites[0]).toMatchObject({
      prefix: "/method",
      guards: [{ at: "/method", key: "/kind", values: ["card", "debit"] }],
    });
  });

  it("places a guard where every branch fixes a key to values of its own, as Adyen's do", () => {
    const typed = (name: string, value: string) => ({
      type: "object",
      properties: { type: { type: "string", enum: [value] }, [name]: { type: "string" } },
    });
    const scan = findSchemaSites(
      {
        ...document({
          type: "object",
          properties: {
            data: { type: "array", items: { oneOf: [ref("Card"), ref("Bank")] } },
          },
        }),
        components: {
          schemas: { Card: typed("last4", "scheme"), Bank: typed("iban", "sepa") },
        },
      } as never,
      "#/components/schemas/Card",
    );
    expect(scan.unsupported).toEqual([]);
    expect(scan.sites[0]?.guards).toEqual([
      { at: "/data/*", key: "/type", values: ["scheme"] },
    ]);
  });

  it("places a guard on a field only its branch requires", () => {
    const scan = findSchemaSites(
      {
        ...document({ oneOf: [ref("Card"), ref("Bank")] }),
        components: {
          schemas: {
            Card: {
              type: "object",
              required: ["last4"],
              properties: { last4: { type: "string" } },
            },
            Bank: {
              type: "object",
              required: ["iban"],
              properties: { iban: { type: "string" } },
            },
          },
        },
      } as never,
      "#/components/schemas/Card",
    );
    expect(scan.sites[0]?.guards).toEqual([{ at: "", has: "last4" }]);
  });

  it("places a guard on the kind of value where the other branches are of other kinds", () => {
    // Stripe writes nearly every expandable field this way: an id, or the object.
    const scan = findSchemaSites(
      document({
        type: "object",
        properties: {
          card: { anyOf: [{ type: "string", maxLength: 5000 }, ref("Card")] },
        },
      }) as never,
      "#/components/schemas/Card",
    );
    expect(scan.unsupported).toEqual([]);
    expect(scan.sites[0]).toMatchObject({
      prefix: "/card",
      guards: [{ at: "/card", type: "object" }],
    });
  });

  it("tells two objects beside an id apart by a field only one requires, as Stripe's deleted objects", () => {
    const scan = findSchemaSites(
      {
        ...document({
          type: "object",
          properties: {
            customer: { anyOf: [{ type: "string" }, ref("Card"), ref("Bank")] },
          },
        }),
        components: {
          schemas: {
            Card: {
              type: "object",
              required: ["last4"],
              properties: { last4: { type: "string" } },
            },
            Bank: {
              type: "object",
              required: ["deleted"],
              properties: { deleted: { type: "boolean", enum: [true] } },
            },
          },
        },
      } as never,
      "#/components/schemas/Card",
    );
    expect(scan.unsupported).toEqual([]);
    expect(scan.sites[0]?.guards).toEqual([{ at: "/customer", has: "last4" }]);
  });

  it("tells objects beside an id apart by a key each fixes, as Stripe's payment sources", () => {
    const typed = (value: string) => ({
      type: "object",
      properties: { object: { type: "string", enum: [value] } },
    });
    const scan = findSchemaSites(
      {
        ...document({
          type: "object",
          properties: {
            source: { anyOf: [{ type: "string" }, ref("Card"), ref("Bank")] },
          },
        }),
        components: { schemas: { Card: typed("card"), Bank: typed("bank_account") } },
      } as never,
      "#/components/schemas/Card",
    );
    expect(scan.unsupported).toEqual([]);
    expect(scan.sites[0]?.guards).toEqual([
      { at: "/source", key: "/object", values: ["card"] },
    ]);
  });

  it("knows a live object from its deleted twin by the field it never has", () => {
    // Stripe's `discount` and `deleted_discount` share their `object` and
    // their fields, except that the deleted one requires `deleted`.
    const object = (extra: Record<string, unknown>, required: string[]) => ({
      type: "object",
      required: ["id", "object", ...required],
      properties: {
        id: { type: "string" },
        object: { type: "string", enum: ["discount"] },
        ...extra,
      },
    });
    const scan = findSchemaSites(
      {
        ...document({
          type: "object",
          properties: {
            discount: { anyOf: [{ type: "string" }, ref("Card"), ref("Bank")] },
          },
        }),
        components: {
          schemas: {
            Card: object({}, []),
            Bank: object({ deleted: { type: "boolean", enum: [true] } }, ["deleted"]),
          },
        },
      } as never,
      "#/components/schemas/Card",
    );
    expect(scan.unsupported).toEqual([]);
    expect(scan.sites[0]?.guards).toEqual([{ at: "/discount", lacks: "deleted" }]);
  });

  it("uses a key and a field together where neither alone tells the branch apart", () => {
    // bank_account beside card and deleted_bank_account: the key rules out
    // the card, and a field only the live account requires rules out its twin.
    const schema = (
      object: string,
      required: string[],
      extra: Record<string, unknown>,
    ) => ({
      type: "object",
      required: ["object", ...required],
      properties: { object: { type: "string", enum: [object] }, ...extra },
    });
    const scan = findSchemaSites(
      {
        ...document({
          type: "object",
          properties: {
            destination: {
              anyOf: [{ type: "string" }, ref("Card"), ref("Bank"), ref("Thing")],
            },
          },
        }),
        components: {
          schemas: {
            Card: schema("bank_account", ["routing"], { routing: { type: "string" } }),
            Bank: schema("bank_account", ["deleted"], { deleted: { type: "boolean" } }),
            Thing: schema("card", ["routing"], { routing: { type: "string" } }),
          },
        },
      } as never,
      "#/components/schemas/Card",
    );
    expect(scan.unsupported).toEqual([]);
    expect(scan.sites[0]?.guards).toEqual([
      { at: "/destination", key: "/object", values: ["bank_account"], has: "routing" },
    ]);
  });

  it("says nothing about a oneOf the schema is not part of", () => {
    const scan = findSchemaSites(
      document({
        type: "object",
        properties: {
          thing: ref("Thing"),
          method: { oneOf: [ref("Card"), ref("Bank")] },
        },
      }) as never,
      "#/components/schemas/Thing",
    );
    expect(scan.sites.map((site) => site.prefix)).toEqual(["/thing"]);
    expect(scan.unsupported).toEqual([]);
  });
});

/**
 * Stripe's shape, reduced: every object refers to the next through an
 * expandable field, a union of an id and the object, and each also refers
 * two steps ahead. The number of distinct paths to the last object doubles
 * with every link, which once made a single search run for minutes.
 */
function fanOut(links: number): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  const expandable = (to: number) => ({
    anyOf: [{ type: "string" }, { $ref: `#/components/schemas/n${to}` }],
  });
  for (let index = 0; index < links; index += 1) {
    const properties: Record<string, unknown> = { id: { type: "string" } };
    if (index + 1 < links) properties["next"] = expandable(index + 1);
    if (index + 2 < links) properties["skip"] = expandable(index + 2);
    schemas[`n${index}`] = { type: "object", properties };
  }
  return {
    openapi: "3.1.0",
    info: { title: "fan", version: "1" },
    paths: {
      "/n": {
        get: {
          operationId: "getN",
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/n0" } },
              },
            },
          },
        },
        post: {
          operationId: "createN",
          requestBody: {
            content: {
              "application/json": {
                schema: { type: "object", properties: { name: { type: "string" } } },
              },
            },
          },
          responses: { "204": { description: "done" } },
        },
      },
    },
    components: { schemas },
  };
}

describe("a schema reached along combinatorially many paths", () => {
  it("is refused after a bounded walk rather than walked for minutes", () => {
    // Bounded by the walk's step budget, which is what makes it quick, and
    // asserted as that rather than as a time a shared CI runner may not keep.
    const document = fanOut(40) as unknown as Parameters<typeof findSchemaSites>[0];
    const scan = findSchemaSites(document, "#/components/schemas/n39");
    expect(scan.exhausted).toBe(true);
    expect(scan.unsupported.join()).toMatch(/too many to place a transform on each/);
  });

  it("still says which ways it travels, from the reference graph alone", () => {
    const document = fanOut(40) as unknown as Parameters<typeof findSchemaSites>[0];
    expect(schemaDirections(document, "#/components/schemas/n39")).toEqual({
      request: false,
      response: true,
    });
  });

  it("walks nothing that cannot lead to the schema, so a nearby one is found exactly", () => {
    const document = fanOut(40) as unknown as Parameters<typeof findSchemaSites>[0];
    // n0 is only ever the body itself.
    const scan = findSchemaSites(document, "#/components/schemas/n0");
    expect(scan.sites.map((site) => site.prefix)).toEqual([""]);
  });
});
