import { describe, expect, it } from "vitest";
import { majorOf, pathAtMajor, readGoMod, requirementOf } from "./modules.ts";

const GO_MOD = `module github.com/cbrgm/sync-secrets-action

go 1.25.0

require (
	github.com/google/go-github/v88 v88.0.0 // pinned
	golang.org/x/oauth2 v0.35.0
)

require github.com/google/go-querystring v1.2.0 // indirect

replace example.com/old => ../old
`;

describe("readGoMod", () => {
  it("reads the module, its go directive and every requirement", () => {
    const mod = readGoMod(GO_MOD);
    expect(mod.module).toBe("github.com/cbrgm/sync-secrets-action");
    expect(mod.go).toBe("1.25.0");
    expect(mod.require).toEqual({
      "github.com/google/go-github/v88": "v88.0.0",
      "golang.org/x/oauth2": "v0.35.0",
      "github.com/google/go-querystring": "v1.2.0",
    });
  });
});

describe("major versions", () => {
  it("splits a path from its major version, and puts it back", () => {
    expect(majorOf("github.com/google/go-github/v88")).toEqual({
      base: "github.com/google/go-github",
      major: 88,
    });
    expect(majorOf("github.com/stripe/stripe-go")).toEqual({
      base: "github.com/stripe/stripe-go",
      major: 1,
    });
    expect(pathAtMajor("github.com/google/go-github", 89)).toBe(
      "github.com/google/go-github/v89",
    );
    expect(pathAtMajor("example.com/sdk", 1)).toBe("example.com/sdk");
  });

  it("finds whichever major version a module requires", () => {
    const mod = readGoMod(GO_MOD);
    expect(requirementOf(mod, "github.com/google/go-github")).toEqual({
      path: "github.com/google/go-github/v88",
      version: "v88.0.0",
    });
    expect(requirementOf(mod, "github.com/stripe/stripe-go")).toBeUndefined();
  });
});
