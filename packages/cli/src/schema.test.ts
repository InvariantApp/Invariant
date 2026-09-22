/**
 * The published schema of invariant.yaml is the one the command reads: every
 * configuration in this repository and every one `init` writes is valid
 * under it, and what the loader refuses, it refuses.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { init } from "./init.ts";

const ROOT = join(import.meta.dirname, "../../..");
const schema = JSON.parse(
  await readFile(join(import.meta.dirname, "../invariant.schema.json"), "utf8"),
);
const validate = new Ajv2020({
  allErrors: true,
  strict: true,
  // A strategy's required field is named in its `then`; the property itself
  // is declared once, beside the others.
  strictRequired: false,
  allowUnionTypes: true,
}).compile(schema);
const problems = (config: unknown) =>
  validate(config)
    ? []
    : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);

describe("the invariant.yaml schema", () => {
  it("accepts every configuration in this repository", async () => {
    const files = execFileSync("git", ["ls-files", "*invariant.yaml"], { cwd: ROOT })
      .toString()
      .split("\n")
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      expect(problems(parse(await readFile(join(ROOT, file), "utf8"))), file).toEqual([]);
    }
  });

  it("accepts what init writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "invariant-schema-"));
    await mkdir(join(root, "api"));
    await writeFile(
      join(root, "api/openapi.json"),
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Acme Payments", version: "1" },
        paths: {},
      }),
    );
    const result = await init({ root, ci: "none", today: "2026-09-22" });
    expect(problems(parse(await readFile(result.configPath, "utf8")))).toEqual([]);
  });

  it("refuses what the loader refuses", () => {
    const base = { api: "acme", spec: { current: "openapi.json" } };
    for (const [why, config] of [
      ["no spec", { api: "acme" }],
      ["a key that is not a setting", { ...base, gates: {} }],
      ["a gate level that is not one", { ...base, gate: { declaredLossy: "maybe" } }],
      [
        "a command with nowhere it writes",
        { api: "acme", spec: { current: { command: "make spec" } } },
      ],
      ["a header strategy with no header", { ...base, identity: [{ kind: "header" }] }],
      ["an identity kind that is not one", { ...base, identity: [{ kind: "cookie" }] }],
      [
        "a build source naming two kinds",
        {
          ...base,
          build: {
            head: { command: "x" },
            contracts: { "2026-01-01": { url: "https://a", image: "b" } },
          },
        },
      ],
      [
        "a scenario setting that is not one",
        { ...base, scenarios: { generate: "missing", count: 3 } },
      ],
    ] as const) {
      expect(problems(config), why).not.toEqual([]);
    }
  });
});
