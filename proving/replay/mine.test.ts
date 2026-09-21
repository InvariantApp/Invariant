import { describe, expect, it } from "vitest";
import { classify, isMajor, parseBump } from "./mine.mts";

describe("reading a bump's title", () => {
  it("reads Dependabot's and Renovate's forms", () => {
    expect(
      parseBump("Bump stripe from 12.18.0 to 14.1.0", { package: "stripe" }),
    ).toEqual({
      from: "12.18.0",
      to: "14.1.0",
    });
    expect(
      parseBump("build(deps): bump stripe from 7.1.0 to 8.0.0 in /api", {
        package: "stripe",
      }),
    ).toEqual({ from: "7.1.0", to: "8.0.0" });
    expect(
      parseBump("Bump github.com/google/go-github/v60 from 60.0.0 to 61.0.0", {
        package: "github.com/google/go-github",
      }),
    ).toEqual({ from: "60.0.0", to: "61.0.0" });
    expect(
      parseBump("fix(deps): update dependency stripe to v14", { package: "stripe" }),
    ).toEqual({ from: "", to: "14" });
  });

  it("does not take one package's bump for another's", () => {
    expect(
      parseBump("Bump stripe-mock from 1.0.0 to 2.0.0", { package: "stripe" }),
    ).toBeUndefined();
  });
});

describe("a major bump", () => {
  it("crosses the first version number, or the minor one before 1.0", () => {
    expect(isMajor("12.18.0", "14.1.0")).toBe(true);
    expect(isMajor("14.0.0", "14.9.0")).toBe(false);
    expect(isMajor("0.3.1", "0.4.0")).toBe(true);
    expect(isMajor("", "14")).toBe(true);
    expect(isMajor("", "14.2.1")).toBe(false);
  });
});

describe("classifying a pull request's files", () => {
  it("names the ecosystem by its manifest and keeps its source files", () => {
    expect(
      classify(
        ["package.json", "package-lock.json", "src/pay.ts", "README.md"],
        ["npm", "pypi"],
      ),
    ).toEqual({ ecosystem: "npm", sources: ["src/pay.ts"] });
    expect(classify(["requirements.txt", "app/billing.py"], ["npm", "pypi"])).toEqual({
      ecosystem: "pypi",
      sources: ["app/billing.py"],
    });
    // A Ruby gem of the same name is not a case for these engines.
    expect(
      classify(["Gemfile", "Gemfile.lock", "app/pay.rb"], ["npm", "pypi"]),
    ).toBeUndefined();
  });
});
