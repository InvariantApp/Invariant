import { afterEach, describe, expect, it } from "vitest";
import { goEnvironment } from "./helper.ts";

describe("the go command's environment", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("keeps the way out through a proxy, and nothing else of the caller's", () => {
    process.env["HTTPS_PROXY"] = "http://egress-proxy:3128";
    process.env["GOFLAGS"] = "-mod=mod";
    process.env["GOPRIVATE"] = "example.com";
    const env = goEnvironment();
    expect(env["HTTPS_PROXY"]).toBe("http://egress-proxy:3128");
    expect(env["GOFLAGS"]).toMatch(/^-mod=readonly /);
    expect(env["GOPRIVATE"]).toBe("");
    expect(env["GOVCS"]).toBe("*:off");
  });
});
