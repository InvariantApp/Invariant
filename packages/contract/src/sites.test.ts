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
