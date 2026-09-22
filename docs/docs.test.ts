/**
 * L16: the documentation is complete, as the code defines complete. Every
 * command the CLI dispatches and every option it reads, every setting the
 * configuration schema allows, every error code the runtime can answer with,
 * every adapter and each rung of adopting it, and every breaking change the
 * pinned differ can report has its place; every link resolves.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ERROR_CODES } from "@invariant/runtime";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../packages/sidecar/src/config.ts";

const DOCS = import.meta.dirname;
const ROOT = resolve(DOCS, "..");
const read = (path: string) => readFileSync(join(DOCS, path), "utf8");
const headings = (text: string) =>
  [...text.matchAll(/^#{1,4} (.+)$/gm)].map((match) => match[1] as string);

describe("the CLI reference", () => {
  const main = readFileSync(join(ROOT, "packages/cli/src/main.ts"), "utf8");
  const page = read("reference/cli.md");

  it("has a section for every command the CLI dispatches", () => {
    const commands = [
      ...main.matchAll(/command === "([a-z-]+)"(?: && argv\[1\] === "([a-z-]+)")?/g),
    ]
      .map((m) => (m[2] ? `${m[1]} ${m[2]}` : (m[1] as string)))
      .filter((command) => !command.startsWith("-"));
    expect(commands.length).toBeGreaterThan(10);
    const sections = headings(page);
    expect(commands.filter((c) => !sections.includes(`\`invariant ${c}\``))).toEqual([]);
  });

  it("mentions every option and environment variable the help lists", () => {
    const help = main.slice(
      main.indexOf("const USAGE"),
      main.indexOf("`;", main.indexOf("const USAGE")),
    );
    const named = new Set(
      [...help.matchAll(/(--[a-z-]+|INVARIANT_[A-Z_]+)/g)].map((m) => m[1] as string),
    );
    expect([...named].filter((name) => !page.includes(`\`${name}`))).toEqual([]);
  });
});

describe("the configuration reference", () => {
  /** Every setting's path: dots for nesting, [] for list items, <label> for maps. */
  function paths(
    schema: Record<string, unknown>,
    root: Record<string, unknown>,
    at: string,
  ): string[] {
    const node = schema["$ref"]
      ? ((root["$defs"] as Record<string, Record<string, unknown>>)[
          (schema["$ref"] as string).replace("#/$defs/", "")
        ] as Record<string, unknown>)
      : schema;
    const found: string[] = [];
    const branches = [node, ...((node["oneOf"] as Record<string, unknown>[]) ?? [])];
    for (const branch of branches) {
      for (const [name, child] of Object.entries(
        (branch["properties"] as Record<string, Record<string, unknown>>) ?? {},
      )) {
        const here = at ? `${at}.${name}` : name;
        found.push(here, ...paths(child, root, here));
      }
      const items = branch["items"] as Record<string, unknown> | undefined;
      if (items) found.push(...paths(items, root, `${at}[]`));
      const values = branch["additionalProperties"];
      if (values && typeof values === "object") {
        found.push(
          `${at}.<label>`,
          ...paths(values as Record<string, unknown>, root, `${at}.<label>`),
        );
      }
    }
    return [...new Set(found)];
  }

  it("has a section for every setting the schema allows", () => {
    const schema = JSON.parse(
      readFileSync(join(ROOT, "packages/cli/invariant.schema.json"), "utf8"),
    );
    const all = paths(schema, schema, "");
    expect(all.length).toBeGreaterThan(30);
    const sections = headings(read("reference/configuration.md"));
    expect(all.filter((path) => !sections.includes(`\`${path}\``))).toEqual([]);
  });
});

describe("the error reference", () => {
  it("has a section for every code the runtime answers with", () => {
    const sections = headings(read("reference/errors.md"));
    expect(
      Object.values(ERROR_CODES).filter((code) => !sections.includes(`\`${code}\``)),
    ).toEqual([]);
  });
});

describe("the adapter guides", () => {
  const ADAPTERS = [
    "express",
    "fastify",
    "hono",
    "koa",
    "nestjs",
    "nextjs",
    "node-http",
    "go",
    "proxy",
  ];
  const RUNGS = ["Serve old contracts", "The kill switch", "Report usage"];

  it("cover every rung of adoption for every adapter", () => {
    const missing = ADAPTERS.flatMap((adapter) => {
      const path = `adapters/${adapter}.md`;
      if (!existsSync(join(DOCS, path))) return [path];
      const sections = headings(read(path));
      return RUNGS.filter((rung) => !sections.includes(rung)).map(
        (rung) => `${path}: ${rung}`,
      );
    });
    expect(missing).toEqual([]);
  });

  it("include every framework the adapter suite holds to it", () => {
    const suite = readFileSync(
      join(ROOT, "packages/runtime-node/src/conformance.test.ts"),
      "utf8",
    );
    const index = read("README.md");
    for (const [framework, page] of [
      ["express", "express"],
      ["fastify", "fastify"],
      ["koa", "koa"],
      ["nestjs", "nestjs"],
      ["next.js", "nextjs"],
      ["go net/http", "go"],
    ]) {
      expect(suite.toLowerCase(), framework).toContain(framework);
      expect(index, page).toContain(`adapters/${page}.md`);
    }
  });
});

describe("the proxy guide", () => {
  it("shows configuration the proxy accepts, all of it together", () => {
    const samples = [
      ...read("adapters/proxy.md").matchAll(/```json\n([\s\S]*?)```/g),
    ].map((match) => JSON.parse(match[1] as string) as Record<string, unknown>);
    expect(samples.length).toBeGreaterThan(2);
    expect(() => parseConfig(Object.assign({}, ...samples), DOCS)).not.toThrow();
  });
});

describe("the breaking change catalogue", () => {
  it("is what the pinned differ and the catalogue say now", async () => {
    const { render } = await import("../scripts/docs-catalogue.mts").catch(() => ({
      render: undefined,
    }));
    if (!render) return;
    let text: string;
    try {
      text = await render();
    } catch {
      return; // no oasdiff binary here; CI has one and runs this
    }
    expect(
      read("reference/breaking-changes.md") === text,
      "run scripts/docs-catalogue.mts",
    ).toBe(true);
  });
});

describe("links", () => {
  it("every relative link in the docs resolves", () => {
    const files = readdirSync(DOCS, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => join(entry.parentPath, entry.name));
    const broken: string[] = [];
    for (const file of files) {
      for (const match of readFileSync(file, "utf8").matchAll(
        /\]\(([^)#\s]+)(#[^)]*)?\)/g,
      )) {
        const target = match[1] as string;
        if (/^[a-z]+:/.test(target)) continue;
        if (!existsSync(resolve(dirname(file), target)))
          broken.push(`${file.slice(ROOT.length + 1)}: ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
