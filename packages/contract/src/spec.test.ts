/**
 * What the loader refuses, and whether it says why.
 *
 * Running 686 real version pairs turned up 14 documents rejected with
 * "Document has no paths object". They were not malformed: they were Adyen's
 * notification contracts, valid OpenAPI 3.1 describing webhooks instead of
 * paths. A message that reads like the document is broken sends the reader to
 * the document, and the document is fine.
 */
import { describe, expect, it } from "vitest";
import { ContractError, normalizeDocument, type OpenApiDocument } from "./spec.ts";

const base = { openapi: "3.1.0", info: { title: "t", version: "1" } };

describe("what the loader will not take", () => {
  it("names webhooks as the reason, rather than blaming the document", () => {
    const document = {
      ...base,
      webhooks: { "/AUTHORISATION": { post: { responses: {} } } },
    } as unknown as OpenApiDocument;

    expect(() => normalizeDocument(document)).toThrow(ContractError);
    expect(() => normalizeDocument(document)).toThrow(/webhooks rather than paths/);
    // The old wording would have been actively misleading here.
    expect(() => normalizeDocument(document)).not.toThrow(/no paths object/);
  });

  it("still says so plainly when there is genuinely nothing to serve", () => {
    expect(() => normalizeDocument({ ...base } as unknown as OpenApiDocument)).toThrow(
      /no paths object/,
    );
  });

  it("accepts an ordinary document", () => {
    const document = {
      ...base,
      paths: { "/things": { get: { responses: {} } } },
    } as unknown as OpenApiDocument;
    expect(normalizeDocument(document)).toBe(document);
  });
});
