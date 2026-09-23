import { describe, expect, it } from "vitest";
import { bumpInPatches, classify, isMajor, parseBump } from "./mine.mts";

describe("what a person's pull request upgraded", () => {
  it("reads the versions from the manifests' diff", () => {
    expect(
      bumpInPatches(
        [
          { filename: "app/billing.py", patch: "-stripe.api_version = 'x'\n+y" },
          {
            filename: "requirements.txt",
            patch:
              "@@ -1,3 +1,3 @@\n Django==5.0\n-stripe==11.4.0\n+stripe==12.0.0\n stripe-mock==2",
          },
        ],
        "stripe",
      ),
    ).toEqual({ from: "11.4.0", to: "12.0.0" });
    expect(
      bumpInPatches(
        [
          {
            filename: "poetry.lock",
            patch:
              '@@ -10,7 +10,7 @@\n [[package]]\n name = "stripe"\n-version = "11.6.0"\n+version = "12.2.0"\n description = "Python bindings"',
          },
        ],
        "stripe",
      ),
    ).toEqual({ from: "11.6.0", to: "12.2.0" });
  });

  it("finds nothing where only the code changed, or the version stayed", () => {
    expect(
      bumpInPatches(
        [{ filename: "pyproject.toml", patch: '-  "stripe>=12"\n+  "stripe>=12"' }],
        "stripe",
      ),
    ).toBeUndefined();
    expect(
      bumpInPatches([{ filename: "app.py", patch: "-a\n+b" }], "stripe"),
    ).toBeUndefined();
  });
});

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
