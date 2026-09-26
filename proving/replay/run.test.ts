import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ClassRecord, type Site, siteKey } from "./classify.mts";
import { importers, importing, lineOf, lockedVersion, pathsOf, scopeOf } from "./run.mts";

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

describe("the files that hand the SDK's users a stand-in", () => {
  it("are those that import one of them by path and write a field the upgrade took away", () => {
    const repo = mkdtempSync(join(tmpdir(), "importers-"));
    mkdirSync(join(repo, "src/utils"), { recursive: true });
    const files: Record<string, string> = {
      "src/utils/payment.ts": "import type Stripe from 'stripe';",
      "src/utils/payment.test.ts":
        "import { handle } from './payment';\nconst s = { current_period_end: 1 };",
      "src/utils/other.test.ts":
        "import { handle } from './payment';\nconst s = { id: 1 };",
      "src/elsewhere.test.ts":
        "import { x } from './lib';\nconst s = { current_period_end: 1 };",
      "src/index.test.ts":
        "import { handle } from './utils/payment.js';\n// current_period_end",
    };
    for (const [name, text] of Object.entries(files))
      writeFileSync(join(repo, name), text);
    const sources = importing(repo, Object.keys(files), "stripe");
    expect(
      importers(repo, Object.keys(files), sources, ["current_period_end"]).map((path) =>
        path.slice(repo.length + 1),
      ),
    ).toEqual(["src/utils/payment.test.ts", "src/index.test.ts"]);
    expect(importers(repo, Object.keys(files), sources, [])).toEqual([]);
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

describe("scopeOf", () => {
  const base = [
    "charge = stripe.Charge.retrieve(id)",
    "refunded = charge.amount_refunded",
    "x = 1",
  ];
  const site = (oldStart: number, lines: string[]): Site => ({
    caseId: "c#1",
    package: "stripe",
    from: "1",
    to: "2",
    file: "a.py",
    base,
    region: { oldStart, oldEnd: oldStart + 1, lines },
  });
  const forced = site(1, ["refunded = charge.refunds.total"]);
  const chosen = site(2, ["x = client.new_feature()"]);
  // What makes a site forced is `forced.mts`'s to say; here it is given.
  const contract: ClassRecord = { class: "contract", confidence: 0.9, model: "test" };
  const classes = { [siteKey(forced)]: contract, [siteKey(chosen)]: contract };
  const scored = [
    { site: forced, outcome: "flagged" as const, forced: true },
    { site: chosen, outcome: "missed" as const, forced: false },
  ];

  it("counts the contract sites the replay judged forced", () => {
    const scope = scopeOf(scored, classes, true);
    expect(scope.sites).toBe(2);
    expect(scope.forced).toEqual({
      sites: 1,
      identical: 0,
      differs: 0,
      flagged: 1,
      missed: 0,
    });
  });

  it("does not judge a case whose contracts are not both known", () => {
    expect(scopeOf(scored, classes).forced).toBeUndefined();
  });
});
