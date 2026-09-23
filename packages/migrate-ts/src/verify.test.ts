/**
 * Checking the result against the release it moves to.
 *
 * Two releases of a small SDK, installed the way a package manager lays them
 * out, and a consumer written against the first in TypeScript and in
 * JavaScript. The second release drops a field its API version no longer
 * sends and stops taking a parameter; no Change says so, and the consumer's
 * reads of both are shown to a person anyway, because the checker sees them.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildPlan } from "@invariant-app/migrate-core";
import { ts } from "ts-morph";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "./index.ts";
import { newErrors, statementAround } from "./verify.ts";

const V1 = `export interface Charge {
  id: string;
  amount: number;
  source: string;
}
export declare class PaySdk {
  constructor(key: string);
  retrieve(id: string, options?: { expand?: string[] }): Promise<Charge>;
}
export default PaySdk;
`;

const V2 = `export interface Charge {
  id: string;
  amount: number;
}
export declare class PaySdk {
  constructor(key: string);
  retrieve(id: string): Promise<Charge>;
}
export default PaySdk;
`;

const BILLING = `import PaySdk from "paysdk";

const client = new PaySdk("key");

export async function sourceOf(id: string): Promise<string> {
  const charge = await client.retrieve(id, { expand: ["source"] });
  if (charge.amount > 0) {
    return charge.source;
  }
  return charge.id;
}

export const untouched: number = "not a number";
`;

const LEGACY = `const PaySdk = require("paysdk").default;

const client = new PaySdk("key");

async function sourceOf(id) {
  const charge = await client.retrieve(id);
  return charge.source;
}

module.exports = { sourceOf };
`;

let dir: string;

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "invariant-verify-"));
  for (const [release, types] of [
    ["v1", V1],
    ["v2", V2],
  ] as const) {
    const sdk = join(dir, "releases", release, "node_modules", "paysdk");
    await write(
      join(sdk, "package.json"),
      JSON.stringify({ name: "paysdk", types: "index.d.ts" }),
    );
    await write(join(sdk, "index.d.ts"), types);
  }
  await write(join(dir, "repo", "src", "billing.ts"), BILLING);
  await write(join(dir, "repo", "src", "legacy.js"), LEGACY);
  await mkdir(join(dir, "repo", "node_modules"), { recursive: true });
  await symlink(
    join(dir, "releases", "v1", "node_modules", "paysdk"),
    join(dir, "repo", "node_modules", "paysdk"),
    "dir",
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const plan = () =>
  buildPlan([], {
    package: "paysdk",
    upgradeTo: { package: "paysdk", version: "2.0.0" },
    types: {},
    accessors: [],
  });

describe("the check against the upgraded release", () => {
  it("shows each place the upgrade breaks, in TypeScript and JavaScript", async () => {
    const repo = join(dir, "repo");
    const result = await migrate({
      repoDir: `${repo}/`,
      generated: [join(dir, "releases", "v1", "node_modules", "paysdk")],
      sources: [join(repo, "src", "billing.ts"), join(repo, "src", "legacy.js")],
      plan: plan(),
      current: { package: "paysdk", from: join(dir, "releases", "v1") },
      upgraded: { package: "paysdk", from: join(dir, "releases", "v2") },
    });
    expect(result.edits).toEqual([]);
    const shown = result.manual
      .map((site) => `${site.file.slice(repo.length + 1)}:${site.line} ${site.snippet}`)
      .sort();
    expect(shown).toEqual([
      'src/billing.ts:6 const charge = await client.retrieve(id, { expand: ["source"] });',
      "src/billing.ts:8 return charge.source;",
      "src/legacy.js:7 return charge.source;",
    ]);
    expect(result.manual[0]?.reason).toMatch(
      /^this no longer type-checks against the upgraded SDK: /,
    );
  });

  it("reports nothing where the release changed nothing the consumer uses", async () => {
    const repo = join(dir, "repo");
    const result = await migrate({
      repoDir: `${repo}/`,
      generated: [join(dir, "releases", "v1", "node_modules", "paysdk")],
      sources: [join(repo, "src", "billing.ts")],
      plan: plan(),
      current: { package: "paysdk", from: join(dir, "releases", "v1") },
      upgraded: { package: "paysdk", from: join(dir, "releases", "v1") },
    });
    // `untouched` was wrong before the upgrade and is no business of it.
    expect(result.manual).toEqual([]);
  });
});

describe("new errors", () => {
  const error = (start: number, message = "Property 'source' does not exist.") => ({
    code: 2339,
    message,
    start,
    end: start + 6,
  });

  it("are the errors the upgrade brought, however far an edit above them moved them", () => {
    const original = "a.source;\nb.source;\n";
    const now = "// moved\na.source;\nb.source;\n";
    expect(
      newErrors([error(2)], [error(11), error(21)], original, now).map(
        (found) => found.start,
      ),
    ).toEqual([21]);
  });
});

describe("what a reviewer is shown", () => {
  const extentOf = (text: string, at: string) => {
    const tree = ts.createSourceFile("a.ts", text, ts.ScriptTarget.Latest, true);
    const start = text.indexOf(at);
    const extent = statementAround(tree, start, start + at.length);
    return text.slice(extent.start, extent.end);
  };

  it("is the whole statement, across the lines it spans", () => {
    const text = "const x = call({\n  a: 1,\n  b: charge.source,\n});\n";
    expect(extentOf(text, "source")).toBe(
      "const x = call({\n  a: 1,\n  b: charge.source,\n});",
    );
  });

  it("is the error alone where the statement holds a block", () => {
    const text = "if (charge.source) {\n  run();\n  more();\n}\n";
    expect(extentOf(text, "source")).toBe("source");
  });

  it("keeps an arrow's single expression with its statement", () => {
    const text = "const ids = charges.map((charge) => charge.source);\n";
    expect(extentOf(text, "source")).toBe(text.trim());
  });
});
