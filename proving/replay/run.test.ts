import { describe, expect, it } from "vitest";
import { lockedVersion } from "./run.mts";

describe("the version a commit installed", () => {
  it("is read from npm's, pnpm's and yarn's lockfiles", () => {
    expect(
      lockedVersion(
        [
          {
            path: "package-lock.json",
            text: JSON.stringify({
              packages: { "node_modules/stripe": { version: "20.0.0" } },
            }),
          },
        ],
        "stripe",
      ),
    ).toBe("20.0.0");
    expect(
      lockedVersion(
        [
          {
            path: "pnpm-lock.yaml",
            text: "packages:\n\n  stripe@20.0.0:\n    resolution: {}\n",
          },
        ],
        "stripe",
      ),
    ).toBe("20.0.0");
    expect(
      lockedVersion(
        [
          {
            path: "pnpm-lock.yaml",
            text: "packages:\n  /stripe@14.25.0:\n    resolution: {}\n",
          },
        ],
        "stripe",
      ),
    ).toBe("14.25.0");
    expect(
      lockedVersion(
        [{ path: "yarn.lock", text: '\n"stripe@^20.0.0":\n  version "20.0.0"\n' }],
        "stripe",
      ),
    ).toBe("20.0.0");
  });

  it("is the one of the major asked for where several are installed", () => {
    const text = "packages:\n  stripe@14.25.0:\n    x: 1\n  stripe@20.0.0:\n    x: 1\n";
    expect(lockedVersion([{ path: "pnpm-lock.yaml", text }], "stripe", "v20")).toBe(
      "20.0.0",
    );
  });

  it("does not take another package's entry for this one's", () => {
    const text =
      "packages:\n  stripe-mock@2.0.0:\n    x: 1\n  @stripe/stripe-js@3.0.0:\n    x: 1\n";
    expect(lockedVersion([{ path: "pnpm-lock.yaml", text }], "stripe")).toBeUndefined();
  });
});
