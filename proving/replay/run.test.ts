import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importing, lineOf, lockedVersion, pathsOf } from "./run.mts";

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
    expect(
      lockedVersion(
        [
          {
            path: "bun.lock",
            text: '{\n  "packages": {\n    "stripe": ["stripe@20.0.0", "", { "dependencies": {} }, "sha512-x"],\n  }\n}',
          },
        ],
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

describe("the files the engine reads", () => {
  it("are the ones that import the SDK, by name or a path inside it", () => {
    const repo = mkdtempSync(join(tmpdir(), "importing-"));
    const files: Record<string, string> = {
      "a.ts": "import Stripe from 'stripe';",
      "b.js": 'const Stripe = require("stripe");',
      "c.ts": 'import type { Charge } from "stripe/types";',
      "d.ts": "import mock from 'stripe-mock';",
      "e.ts": "const text = 'uses stripe for payments';",
    };
    for (const [name, text] of Object.entries(files))
      writeFileSync(join(repo, name), text);
    expect(
      importing(repo, Object.keys(files), "stripe").map((path) =>
        path.slice(repo.length + 1),
      ),
    ).toEqual(["a.ts", "b.js", "c.ts"]);
  });
});

describe("how a monorepo's own imports resolve", () => {
  it("is read from its root tsconfig at the commit, comments and all", async () => {
    const repo = mkdtempSync(join(tmpdir(), "paths-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" })
        .toString()
        .trim();
    git("init", "-q");
    writeFileSync(
      join(repo, "tsconfig.json"),
      [
        "{",
        "  // nx writes comments here",
        '  "compilerOptions": {',
        '    "baseUrl": ".",',
        '    "paths": { "@acme/config": ["libs/config/src/index.ts"] },',
        "  },",
        "}",
      ].join("\n"),
    );
    git("add", ".");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base");
    expect(await pathsOf(repo, git("rev-parse", "HEAD"))).toEqual({
      baseUrl: repo,
      paths: { "@acme/config": ["libs/config/src/index.ts"] },
    });
  });
});

describe("the line a flagged place is on", () => {
  it("is found from each line's start, at a line's first character and its last", () => {
    const text = "a\nbc\n\nd";
    const starts = [0, 2, 5, 6];
    expect([0, 1, 2, 4, 5, 6, 7].map((offset) => lineOf(starts, offset))).toEqual([
      0, 0, 1, 1, 2, 3, 3,
    ]);
    expect(text.slice(starts[3])).toBe("d");
  });
});
