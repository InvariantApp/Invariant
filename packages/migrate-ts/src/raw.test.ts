import { describe, expect, it } from "vitest";
import { matchesTemplate } from "./raw.ts";

describe("tying a raw call's path to an operation", () => {
  it("matches a custom method whose parameter shares its segment", () => {
    expect(matchesTemplate("/v1/{name}:cancel", ["", "v1", "op-7:cancel"])).toBe(true);
    expect(matchesTemplate("/v1/{name}:cancel", ["", "v1", "op-7:get"])).toBe(false);
    // A segment built from a variable might be the custom method.
    expect(matchesTemplate("/v1/{name}:cancel", ["", "v1", undefined])).toBe(true);
  });

  it("keeps a fixed segment from matching a different fixed segment", () => {
    expect(matchesTemplate("/v1/things/{id}", ["", "v1", "things", "a"])).toBe(true);
    expect(matchesTemplate("/v1/things/{id}", ["", "v1", "other", "a"])).toBe(false);
    expect(matchesTemplate("/v1/things", ["", "v1", undefined])).toBe(false);
  });
});
