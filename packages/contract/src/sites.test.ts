import { describe, expect, it } from "vitest";
import { findSchemaSites } from "./sites.ts";
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

  it("refuses a schema that is reached only through a oneOf", () => {
    // Which branch a value took is not something the runtime can tell, so a
    // transform placed there could apply to the wrong kind of value.
    const scan = findSchemaSites(
      document({
        type: "object",
        properties: { method: { oneOf: [ref("Card"), ref("Bank")] } },
      }) as never,
      "#/components/schemas/Card",
    );
    expect(scan.sites).toEqual([]);
    expect(scan.unsupported).toEqual([
      "things.get response 200: /method reaches the schema through oneOf",
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
