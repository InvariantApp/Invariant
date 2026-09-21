/**
 * The shared view of a schema: what the differ compares is what every other
 * layer reads, or closure judges a different document from the one drafted.
 */
import { describe, expect, it } from "vitest";
import { resolveSchema } from "./resolve.ts";

describe("nullability under allOf", () => {
  const document = {
    openapi: "3.0.3",
    info: { title: "t", version: "1" },
    paths: {},
    components: {
      schemas: {
        Amount: { type: "object", properties: { value: { type: "number" } } },
        MaybeAmount: { type: "object", nullable: true, properties: {} },
      },
    },
  } as never;

  it("allows null only where every part does, as the differ merges it", () => {
    // Plaid writes `nullable: true` beside an allOf of a schema that does not
    // allow null, and the differ reads that as not nullable.
    expect(
      resolveSchema(document, {
        nullable: true,
        allOf: [{ $ref: "#/components/schemas/Amount" }],
      }),
    ).not.toHaveProperty("nullable");
    expect(
      resolveSchema(document, {
        nullable: true,
        allOf: [{ $ref: "#/components/schemas/MaybeAmount" }],
      }),
    ).toHaveProperty("nullable", true);
  });
});
