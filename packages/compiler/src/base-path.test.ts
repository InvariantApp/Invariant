import type { OpenApiDocument } from "@invariant-app/contract";
import { describe, expect, it } from "vitest";
import { basePathOf } from "./chain.ts";

const withServers = (...urls: string[]) =>
  ({ servers: urls.map((url) => ({ url })) }) as unknown as OpenApiDocument;

describe("the path an API is served under", () => {
  it("is read from every server's URL when they agree", () => {
    expect(basePathOf(withServers("https://api.example.com/v1"))).toBe("/v1");
    expect(
      basePathOf(
        withServers("https://api.example.com/v1/", "https://sandbox.example.com/v1"),
      ),
    ).toBe("/v1");
    // Swagger 2.0's basePath, as the upgrader writes it.
    expect(basePathOf(withServers("/api/v3"))).toBe("/api/v3");
  });

  it("is nothing at the root, when servers disagree, or when a URL has a variable", () => {
    expect(basePathOf(withServers("https://api.example.com"))).toBeUndefined();
    expect(basePathOf(withServers("https://api.example.com/"))).toBeUndefined();
    expect(
      basePathOf(withServers("https://a.example.com/v1", "https://b.example.com/v2")),
    ).toBeUndefined();
    expect(
      basePathOf(withServers("https://{region}.example.com/{version}")),
    ).toBeUndefined();
    expect(basePathOf({} as OpenApiDocument)).toBeUndefined();
  });
});
