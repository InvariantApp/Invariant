/**
 * The header rules every binding shares for caches and conditional requests.
 */
import { describe, expect, it } from "vitest";
import { appendVary, markEtag, unmarkConditionals } from "./http.ts";

const OLD = "2026-01-15";

describe("an entity tag for an adapted body", () => {
  it("is the handler's, marked with the contract, strong or weak", () => {
    expect(markEtag('"v7"', OLD)).toBe(`"v7~${OLD}"`);
    expect(markEtag('W/"v7"', OLD)).toBe(`W/"v7~${OLD}"`);
  });

  it("is nothing when the handler's cannot be read, rather than a guess", () => {
    expect(markEtag("v7", OLD)).toBeUndefined();
  });
});

describe("a conditional request from a caller on an old contract", () => {
  const headers = (entries: Record<string, string>) => new Headers(entries);

  it("reaches the handler with its own tags", () => {
    const out = unmarkConditionals(
      headers({ "if-none-match": `"a~${OLD}", W/"b~${OLD}"` }),
      OLD,
    );
    expect(out.get("if-none-match")).toBe('"a", W/"b"');
  });

  it("asks for the whole answer when it only holds another contract's copy", () => {
    const out = unmarkConditionals(
      headers({ "if-none-match": '"a", "b~2026-03-01"' }),
      OLD,
    );
    expect(out.has("if-none-match")).toBe(false);
  });

  it("cannot write against another contract's copy", () => {
    // Dropping the tag would drop the precondition, and the write would go
    // ahead against a copy the caller never saw.
    const out = unmarkConditionals(headers({ "if-match": '"a"' }), OLD);
    expect(out.get("if-match")).toBe('"~"');
    expect(
      unmarkConditionals(headers({ "if-match": `"a~${OLD}"` }), OLD).get("if-match"),
    ).toBe('"a"');
  });

  it("keeps a wildcard, and is left alone when there is nothing to change", () => {
    const wildcard = headers({ "if-none-match": "*" });
    expect(unmarkConditionals(wildcard, OLD)).toBe(wildcard);
    const plain = headers({ accept: "application/json" });
    expect(unmarkConditionals(plain, OLD)).toBe(plain);
  });
});

describe("Vary", () => {
  it("gains each name once, beside what the handler said", () => {
    const out = new Headers({ vary: "Accept-Encoding" });
    appendVary(out, ["acme-version"]);
    appendVary(out, ["Acme-Version"]);
    expect(out.get("vary")).toBe("Accept-Encoding, acme-version");
  });

  it("is left as it is when it already varies on everything", () => {
    const out = new Headers({ vary: "*" });
    appendVary(out, ["acme-version"]);
    expect(out.get("vary")).toBe("*");
  });
});
