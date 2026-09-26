/**
 * Rig E, what the engine is told on an upgrade of an SDK Stainless generates:
 * the Changes a provider would publish between the two API specifications
 * the releases were built from, and what the SDK calls each schema.
 *
 * Each release records its specification in `.stats.yml` at its tag
 * (`openapi_spec_url`, content-addressed, so it never changes). The Changes
 * are drafted as for Stripe, with the rules judge alone, so nothing here
 * depends on a model. A release that records no specification is replayed
 * with none, and the case says so through its engine.
 *
 * Stainless names a response model after its schema (`BetaMessage`) and a
 * request type with `Param` after it (`ToolParam`). What neither name finds
 * is found by its fields, as stripe-go's types are: the one class whose
 * fields are the schema's properties. A class its package re-exports is named
 * through the package (`anthropic.types.beta.BetaMessage`), any other through
 * its own module.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { type OpenApiDocument, readDocument } from "@invariant-app/contract";
import { breakingBetween } from "./forced.mts";
import { type ContractPlan, draftChanges, SPECS, schemasOf, wireOf } from "./stripe.mts";

/** The PyPI packages Stainless generates, and the repositories their tags are in. */
export const STAINLESS: Record<string, string> = {
  anthropic: "anthropics/anthropic-sdk-python",
  openai: "openai/openai-python",
};

/**
 * The npm packages Stainless generates, their repositories, and how each tags
 * a release: openai-node as `v4.80.0`, the Anthropic SDK as `sdk-v0.40.0`.
 */
export const STAINLESS_NPM: Record<string, { repo: string; tag: string }> = {
  openai: { repo: "openai/openai-node", tag: "v" },
  "@anthropic-ai/sdk": { repo: "anthropics/anthropic-sdk-typescript", tag: "sdk-v" },
};

const URLS = join(SPECS, "stainless-specs.json");

/** The specification a release was built from, as its `.stats.yml` names it. */
async function specUrl(
  pkg: string,
  version: string,
  release: { repo: string; tag: string } = { repo: STAINLESS[pkg] as string, tag: "v" },
): Promise<string> {
  const known: Record<string, string> = existsSync(URLS)
    ? (JSON.parse(readFileSync(URLS, "utf8")) as Record<string, string>)
    : {};
  const key = `${release.repo}@${version}`;
  const cached = known[key];
  if (cached) return cached;
  const response = await fetch(
    `https://raw.githubusercontent.com/${release.repo}/${release.tag}${version}/.stats.yml`,
  );
  const url = response.ok
    ? /^openapi_spec_url:\s*(\S+)/m.exec(await response.text())?.[1]
    : undefined;
  if (!url) throw new Error(`${pkg} ${version} records no specification`);
  known[key] = url;
  await mkdir(SPECS, { recursive: true });
  await writeFile(URLS, `${JSON.stringify(known, null, 2)}\n`);
  return url;
}

async function specification(
  url: string,
): Promise<{ name: string; document: OpenApiDocument }> {
  const name = decodeURIComponent(url.split("/").at(-1) ?? "").replace(/[^\w.-]/g, "_");
  const path = join(SPECS, `stainless-${name}`);
  if (!existsSync(path)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    await mkdir(SPECS, { recursive: true });
    await writeFile(path, await response.text());
  }
  return { name, document: await readDocument(path) };
}

interface PythonClass {
  name: string;
  /** Dotted path the class is reached by. */
  qualified: string;
  fields: Set<string>;
}

/** Every top-level class under the package's `types`, with its annotated fields. */
export function stainlessClasses(site: string, pkg: string): PythonClass[] {
  const found: PythonClass[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    const exported = existsSync(join(dir, "__init__.py"))
      ? readFileSync(join(dir, "__init__.py"), "utf8")
      : "";
    const packagePath = relative(site, dir).split("/").join(".");
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith(".py")) continue;
      const text = readFileSync(path, "utf8");
      const module =
        entry.name === "__init__.py"
          ? packagePath
          : `${packagePath}.${entry.name.slice(0, -3)}`;
      // Each class runs to the next line that starts at the margin.
      for (const match of text.matchAll(
        /^class (\w+)\b[^\n]*:\n((?:[ \t]+[^\n]*\n|\n)*)/gm,
      )) {
        const name = match[1] as string;
        const fields = new Set(
          [...(match[2] ?? "").matchAll(/^ {4}(\w+)\s*:/gm)].map(
            (field) => field[1] as string,
          ),
        );
        const reexported = new RegExp(`\\b${name}\\b`).test(exported);
        found.push({
          name,
          qualified: `${reexported ? packagePath : module}.${name}`,
          fields,
        });
      }
    }
  };
  walk(join(site, pkg, "types"));
  return found;
}

/**
 * Schema name to the SDK's class for it: by the name Stainless gives a model,
 * then a request type, then, for a schema with at least two properties, the
 * one class sharing at least 80% of its fields with it.
 */
export function stainlessTypes(
  document: OpenApiDocument,
  classes: readonly PythonClass[],
): Record<string, string> {
  const byName = new Map<string, PythonClass>();
  for (const each of classes) if (!byName.has(each.name)) byName.set(each.name, each);
  const loose = (name: string) => name.replace(/_/g, "").toLowerCase();
  const byLoose = new Map<string, PythonClass[]>();
  for (const each of classes) {
    byLoose.set(loose(each.name), [...(byLoose.get(loose(each.name)) ?? []), each]);
  }
  const types: Record<string, string> = {};
  for (const [schema, definition] of Object.entries(schemasOf(document))) {
    const named =
      byName.get(schema) ??
      byName.get(`${schema}Param`) ??
      (byLoose.get(loose(schema))?.length === 1
        ? byLoose.get(loose(schema))?.[0]
        : undefined);
    if (named) {
      types[schema] = named.qualified;
      continue;
    }
    const properties = Object.keys(definition.properties ?? {});
    if (properties.length < 2) continue;
    let best: { share: number; classes: PythonClass[] } = { share: 0, classes: [] };
    for (const each of classes) {
      const shared = properties.filter((property) => each.fields.has(property)).length;
      const share = shared / new Set([...properties, ...each.fields]).size;
      if (share > best.share) best = { share, classes: [each] };
      else if (share === best.share) best.classes.push(each);
    }
    if (best.share >= 0.8 && best.classes.length === 1) {
      types[schema] = (best.classes[0] as PythonClass).qualified;
    }
  }
  return types;
}

/**
 * The Changes and types for an upgrade of a Stainless SDK from `from` to
 * `to`, whose old release is unpacked at `site` (its `site-packages`).
 */
export async function stainlessPlan(
  pkg: string,
  from: string,
  to: string,
  site: string,
): Promise<ContractPlan> {
  const oldUrl = await specUrl(pkg, from);
  const newUrl = await specUrl(pkg, to);
  const [before, after] = await Promise.all([
    specification(oldUrl),
    specification(newUrl),
  ]);
  const drafted = await draftChanges(before.document, after.document);
  const types = stainlessTypes(before.document, stainlessClasses(site, pkg));
  return {
    ...drafted,
    types,
    wire: wireOf(before.document),
    // How a Stainless API tags its objects is not read yet; the engine finds
    // them through the SDK's types instead.
    tags: { property: "type", schemas: {} },
    operations: {},
    breaking:
      oldUrl === newUrl
        ? []
        : await breakingBetween(
            before.document,
            after.document,
            join(SPECS, "breaking", `${before.name}-${after.name}.json`),
          ),
  };
}

/**
 * What the API broke between two releases of a Stainless npm SDK, for judging
 * which sites an upgrade forced; the TypeScript engine is not told Changes
 * from it.
 */
export async function stainlessNpmBreaking(
  pkg: string,
  from: string,
  to: string,
): Promise<string[] | undefined> {
  const release = STAINLESS_NPM[pkg];
  if (!release) return undefined;
  const [oldUrl, newUrl] = [
    await specUrl(pkg, from, release),
    await specUrl(pkg, to, release),
  ];
  if (oldUrl === newUrl) return [];
  const [before, after] = await Promise.all([
    specification(oldUrl),
    specification(newUrl),
  ]);
  return breakingBetween(
    before.document,
    after.document,
    join(SPECS, "breaking", `${before.name}-${after.name}.json`),
  );
}
