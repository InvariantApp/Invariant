/**
 * The independent oracle, held to what the contract actually says.
 *
 * Everything rig C concludes rests on this agreeing with JSON Schema, so it
 * is tested against cases where getting it wrong would flip a verdict: a
 * missing required field, a value outside an enum, a reference to another
 * schema, and the OpenAPI 3.0 spelling of nullability.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Oracle } from "./oracle.mts";

const SPEC = new URL(
  "../../fixtures/provider-acme/openapi/2026-03-01.json",
  import.meta.url,
);
const create = { method: "post", path: "/v1/payments" };

describe("the oracle on an OpenAPI 3.1 contract", async () => {
  const oracle = new Oracle(JSON.parse(await readFile(SPEC, "utf8")));

  it("accepts a request the contract allows", () => {
    expect(
      oracle.request(create, {
        amount: 12.5,
        currency: "usd",
        payment_method: { token: "tok_visa" },
        description: null,
      }),
    ).toEqual([]);
  });

  it("refuses a request missing a required field, and says where", () => {
    const violations = oracle.request(create, { amount: 12.5, currency: "usd" });
    expect(violations?.some((v) => v.message.includes("payment_method"))).toBe(true);
  });

  it("refuses a value outside an enum", () => {
    const violations = oracle.request(create, {
      amount: 1,
      currency: "jpy",
      payment_method: { token: "t" },
    });
    expect(violations?.[0]?.pointer).toBe("/currency");
  });

  it("follows references into other schemas", () => {
    const violations = oracle.request(create, {
      amount: 1,
      currency: "usd",
      payment_method: {},
    });
    expect(violations?.some((v) => v.pointer.startsWith("/payment_method"))).toBe(true);
  });

  it("says it cannot judge an operation that has no body schema", () => {
    expect(oracle.request({ method: "get", path: "/v1/payments" }, {})).toBeUndefined();
  });
});

describe("the oracle on an OpenAPI 3.0 contract", () => {
  const oracle = new Oracle({
    openapi: "3.0.3",
    info: { title: "t", version: "1" },
    paths: {
      "/things": {
        post: {
          requestBody: {
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Thing" } },
            },
          },
          responses: { "200": { description: "ok" } },
        },
      },
    },
    components: {
      schemas: {
        Thing: {
          type: "object",
          properties: {
            note: { type: "string", nullable: true },
            size: { type: "integer", minimum: 0, exclusiveMinimum: true },
          },
        },
      },
    },
  });
  const things = { method: "post", path: "/things" };

  it("reads nullable: true as allowing null", () => {
    expect(oracle.request(things, { note: null })).toEqual([]);
  });

  it("reads a boolean exclusiveMinimum as the bound it names", () => {
    expect(oracle.request(things, { size: 0 })?.length).toBeGreaterThan(0);
    expect(oracle.request(things, { size: 1 })).toEqual([]);
  });
});
