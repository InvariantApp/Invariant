import { describe, expect, it } from "vitest";
import { differs, excess, place, programSites, templateMatcher } from "./summary.ts";

describe("templateMatcher", () => {
  const match = templateMatcher([
    "/v1/customers/{customer}",
    "/v1/customers/search",
    "/v1/customers",
    "/v1/files/{file}/contents",
  ]);

  it("prefers the template with more literal segments", () => {
    // A customer called "search" is not how Stripe reads that path.
    expect(match("GET", "/v1/customers/search")).toBe("/v1/customers/search");
    expect(match("GET", "/v1/customers/cus_123")).toBe("/v1/customers/{customer}");
  });

  it("matches whole segments only, and nothing it does not know", () => {
    expect(match("GET", "/v1/customers")).toBe("/v1/customers");
    expect(match("GET", "/v1/files/file_1/contents")).toBe("/v1/files/{file}/contents");
    expect(match("GET", "/v1/customers/a/b")).toBeUndefined();
    expect(match("GET", "/v2/core/events")).toBeUndefined();
  });
});

describe("place", () => {
  it("folds array indexes, so a violation in every item of a list is one place", () => {
    expect(place("/data/0/status")).toBe("/data/*/status");
    expect(place("/data/12/items/3")).toBe("/data/*/items/*");
    expect(place("")).toBe("/");
    expect(place("/card/last4")).toBe("/card/last4");
  });
});

describe("excess", () => {
  it("counts only what goes past the baseline", () => {
    expect(excess({ a: 3, b: 1, c: 2 }, { a: 1, b: 4 })).toEqual({ a: 2, c: 2 });
  });
});

describe("differs", () => {
  const exchange = { seq: 1, method: "GET", path: "/v1/charges/ch_1", status: 200 };

  it("sees a changed status or body, and nothing else", () => {
    expect(
      differs({ ...exchange, body: { a: 1 } }, { ...exchange, body: { a: 1 } }),
    ).toBe(false);
    expect(
      differs({ ...exchange, body: { a: 1 } }, { ...exchange, body: { a: 2 } }),
    ).toBe(true);
    expect(differs(exchange, { ...exchange, status: 404 })).toBe(true);
  });
});

describe("programSites", () => {
  it("names the sites a contract changes, and not the ones it passes through", () => {
    const program = {
      contracts: {
        old: {
          routes: [
            { from: { method: "get", path: "/a" }, to: { method: "get", path: "/b" } },
          ],
          sites: {
            "get /v1/charges/{charge}": { request: [], response: { "200": [{ op: 1 }] } },
            "post /v1/tokens": { request: [], response: { "200": [] } },
          },
        },
      },
    };
    expect(programSites(program, "old")).toEqual(["GET /b", "GET /v1/charges/{charge}"]);
    expect(programSites(program, "missing")).toEqual([]);
  });
});
