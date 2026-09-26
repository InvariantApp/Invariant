/**
 * Whether the symbol maps the replay gets from `@invariant-app/symbols` are
 * the same as, or better than, the ones it made itself before the package
 * existed (`symbols-legacy.mts`), for every SDK release the replay has
 * cached: stripe-node, stripe-python and the Stainless Python SDKs, and
 * stripe-go modules named on the command line.
 *
 * Every schema whose type differs is listed once per SDK, with the releases
 * it differs in and the package's evidence for its answer, so each change
 * can be read and explained. Operations are compared the same way for
 * stripe-node, the one SDK the replay read them for.
 *
 * Usage:
 *   node --import tsx proving/replay/symbols.mts [--json report.json]
 *     [--go <unpacked stripe-go module>]... [--only stripe-node|stripe-python|stainless|stripe-go]
 *
 * Nothing is fetched that the replay has not already cached, except a
 * specification a release names and the cache lacks.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OpenApiDocument } from "@invariant-app/contract";
import type { SurfaceObject } from "@invariant-app/migrate-go";
import {
  type GeneratedSymbols,
  generateSymbols,
  type Language,
  readGo,
  symbolMapOf,
} from "@invariant-app/symbols";
import { ROOT } from "../corpus/manifest.mts";
import { STAINLESS, stainlessSpecification } from "./stainless.mts";
import { specification, stripeGoSymbols, stripeSpecification } from "./stripe.mts";
import {
  legacyStainlessTypes,
  legacyStripeGoTypes,
  legacyStripeNodeOperations,
  legacyStripeNodeTypes,
  legacyStripePythonTypes,
} from "./symbols-legacy.mts";

const CACHE = join(ROOT, ".cache/replay");

interface Difference {
  schema: string;
  legacy?: string;
  now?: string;
  /** The package's evidence for what it says now, or why it says nothing. */
  evidence: string;
  releases: string[];
}

interface Comparison {
  sdk: string;
  releases: {
    version: string;
    legacy: number;
    now: number;
    same: number;
    changed: number;
    added: number;
    removed: number;
  }[];
  /** Each distinct difference, once, with every release it is in. */
  differences: Difference[];
  operations?: Comparison["releases"];
  operationDifferences?: Difference[];
}

function compare(
  version: string,
  legacy: Record<string, string>,
  now: Record<string, string>,
  why: (schema: string) => string,
  into: Map<string, Difference>,
): Comparison["releases"][number] {
  let same = 0;
  let changed = 0;
  let added = 0;
  let removed = 0;
  for (const schema of new Set([...Object.keys(legacy), ...Object.keys(now)])) {
    const [before, after] = [legacy[schema], now[schema]];
    if (before === after) {
      same += 1;
      continue;
    }
    if (before === undefined) added += 1;
    else if (after === undefined) removed += 1;
    else changed += 1;
    const key = `${schema}\u0000${before ?? ""}\u0000${after ?? ""}`;
    const known = into.get(key);
    if (known) known.releases.push(version);
    else {
      into.set(key, {
        schema,
        ...(before !== undefined ? { legacy: before } : {}),
        ...(after !== undefined ? { now: after } : {}),
        evidence: why(schema),
        releases: [version],
      });
    }
  }
  return {
    version,
    legacy: Object.keys(legacy).length,
    now: Object.keys(now).length,
    same,
    changed,
    added,
    removed,
  };
}

const evidenceOf =
  (generated: GeneratedSymbols) =>
  (schema: string): string =>
    generated.types[schema]
      ? `${generated.types[schema].via}: ${generated.types[schema].evidence}`
      : (generated.unmatched[schema] ?? "not in the contract");

const operationEvidenceOf =
  (generated: GeneratedSymbols) =>
  (key: string): string =>
    generated.operations[key]
      ? `${generated.operations[key].via}: ${generated.operations[key].evidence}`
      : "no method found";

const operationNames = (operations: Record<string, { type: string; method: string }>) =>
  Object.fromEntries(
    Object.entries(operations).map(([key, value]) => [
      key,
      `${value.type}.${value.method}`,
    ]),
  );

async function current(
  sdk: string,
  language: Language,
  document: OpenApiDocument,
  module?: string,
): Promise<GeneratedSymbols> {
  return generateSymbols({
    sdk,
    language,
    contract: document,
    ...(module ? { module } : {}),
  });
}

const versionOrder = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true });

async function stripeNode(): Promise<Comparison> {
  const types = new Map<string, Difference>();
  const operations = new Map<string, Difference>();
  const releases: Comparison["releases"] = [];
  const operationReleases: Comparison["releases"] = [];
  const dirs = existsSync(join(CACHE, "npm")) ? readdirSync(join(CACHE, "npm")) : [];
  const versions = dirs
    .filter((dir) => /^stripe@\d+\.\d+\.\d+$/.test(dir))
    .map((dir) => dir.slice("stripe@".length))
    .sort(versionOrder);
  for (const version of versions) {
    const sdk = join(CACHE, "npm", `stripe@${version}`, "node_modules", "stripe");
    if (!existsSync(join(sdk, "package.json"))) continue;
    const document = await stripeSpecification(version, "stripe-node").catch(
      () => undefined,
    );
    if (!document) {
      process.stderr.write(`stripe-node ${version}: no specification recorded\n`);
      continue;
    }
    // As the replay's stamp reads it: up to 21 the types are inside
    // `namespace Stripe`.
    const lib = join(sdk, "types/lib.d.ts");
    const namespaced =
      existsSync(lib) && /interface StripeConfig/.test(readFileSync(lib, "utf8"));
    const generated = await current(sdk, "typescript", document);
    const now = symbolMapOf(generated);
    releases.push(
      compare(
        version,
        legacyStripeNodeTypes(document, sdk, namespaced),
        now.types,
        evidenceOf(generated),
        types,
      ),
    );
    operationReleases.push(
      compare(
        version,
        operationNames(legacyStripeNodeOperations(sdk, namespaced)),
        operationNames(now.operations),
        operationEvidenceOf(generated),
        operations,
      ),
    );
  }
  return {
    sdk: "stripe-node",
    releases,
    differences: [...types.values()],
    operations: operationReleases,
    operationDifferences: [...operations.values()],
  };
}

async function stripePython(): Promise<Comparison> {
  const types = new Map<string, Difference>();
  const releases: Comparison["releases"] = [];
  const dirs = existsSync(join(CACHE, "pypi")) ? readdirSync(join(CACHE, "pypi")) : [];
  for (const dir of dirs.filter((each) => /^stripe-\d/.test(each)).sort(versionOrder)) {
    const version = dir.slice("stripe-".length);
    const site = join(CACHE, "pypi", dir, "site-packages");
    const document = await stripeSpecification(version, "stripe-python").catch(
      () => undefined,
    );
    if (!document) continue;
    const generated = await current(site, "python", document, "stripe");
    releases.push(
      compare(
        version,
        legacyStripePythonTypes(document, site),
        symbolMapOf(generated).types,
        evidenceOf(generated),
        types,
      ),
    );
  }
  return { sdk: "stripe-python", releases, differences: [...types.values()] };
}

async function stainless(): Promise<Comparison[]> {
  const out: Comparison[] = [];
  const dirs = existsSync(join(CACHE, "pypi")) ? readdirSync(join(CACHE, "pypi")) : [];
  for (const pkg of Object.keys(STAINLESS)) {
    const types = new Map<string, Difference>();
    const releases: Comparison["releases"] = [];
    const prefix = `${pkg}-`;
    for (const dir of dirs.filter((each) => each.startsWith(prefix)).sort(versionOrder)) {
      const version = dir.slice(prefix.length);
      if (!/^\d/.test(version)) continue;
      const site = join(CACHE, "pypi", dir, "site-packages");
      const document = await stainlessSpecification(pkg, version).catch(() => undefined);
      if (!document) {
        process.stderr.write(`${pkg} ${version}: no specification recorded\n`);
        continue;
      }
      const generated = await current(site, "python", document, pkg);
      releases.push(
        compare(
          version,
          legacyStainlessTypes(document, site, pkg),
          symbolMapOf(generated).types,
          evidenceOf(generated),
          types,
        ),
      );
    }
    out.push({
      sdk: `${pkg} (Stainless Python)`,
      releases,
      differences: [...types.values()],
    });
  }
  return out;
}

/**
 * stripe-go modules, each read into the fields the Go helper's surface
 * would give (a root-package struct's `json` tags), so the legacy rule and
 * the package match the same facts.
 */
async function stripeGo(modules: readonly string[]): Promise<Comparison> {
  const types = new Map<string, Difference>();
  const releases: Comparison["releases"] = [];
  for (const dir of modules) {
    const release = readFileSync(join(dir, "OPENAPI_VERSION"), "utf8").trim();
    const document = await specification(release);
    const { declarations } = readGo(dir);
    const surface: SurfaceObject[] = [];
    const fields = new Map<string, Set<string>>();
    for (const declaration of declarations) {
      if (declaration.package !== "" || declaration.kind !== "object") continue;
      for (const field of declaration.fields ?? []) {
        surface.push({
          package: "",
          key: `${declaration.name}.${field}`,
          kind: "field",
          type: "",
          json: field,
        });
        fields.set(
          declaration.name,
          (fields.get(declaration.name) ?? new Set()).add(field),
        );
      }
    }
    const now = await stripeGoSymbols(document, surface);
    const generated = await current(dir, "go", document);
    const version = /@(v[^/]+)$/.exec(dir)?.[1] ?? dir;
    releases.push(
      compare(
        version,
        legacyStripeGoTypes(document, fields),
        Object.fromEntries(
          Object.entries(now).map(([schema, symbol]) => [schema, symbol.key]),
        ),
        evidenceOf(generated),
        types,
      ),
    );
  }
  return { sdk: "stripe-go", releases, differences: [...types.values()] };
}

const args = process.argv.slice(2);
const option = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const only = option("--only");
const goModules = args.flatMap((arg, index) => (args[index - 1] === "--go" ? [arg] : []));
const comparisons: Comparison[] = [];
if (!only || only === "stripe-node") comparisons.push(await stripeNode());
if (!only || only === "stripe-python") comparisons.push(await stripePython());
if (!only || only === "stainless") comparisons.push(...(await stainless()));
if (goModules.length > 0 && (!only || only === "stripe-go")) {
  comparisons.push(await stripeGo(goModules));
}

const total = (rows: Comparison["releases"], key: keyof Comparison["releases"][number]) =>
  rows.reduce((sum, row) => sum + (row[key] as number), 0);
for (const comparison of comparisons) {
  const rows = comparison.releases;
  process.stdout.write(
    `\n## ${comparison.sdk}: ${rows.length} releases, types ${total(rows, "legacy")} before, ${total(rows, "now")} now; ${total(rows, "same")} same, ${total(rows, "changed")} changed, ${total(rows, "added")} added, ${total(rows, "removed")} removed\n`,
  );
  for (const difference of comparison.differences) {
    process.stdout.write(
      `- ${difference.schema}: ${difference.legacy ?? "(none)"} -> ${difference.now ?? "(none)"} [${difference.releases.length} releases] ${difference.evidence}\n`,
    );
  }
  if (comparison.operations) {
    const ops = comparison.operations;
    process.stdout.write(
      `\n### operations: ${total(ops, "legacy")} before, ${total(ops, "now")} now; ${total(ops, "same")} same, ${total(ops, "changed")} changed, ${total(ops, "added")} added, ${total(ops, "removed")} removed\n`,
    );
    for (const difference of comparison.operationDifferences ?? []) {
      process.stdout.write(
        `- ${difference.schema}: ${difference.legacy ?? "(none)"} -> ${difference.now ?? "(none)"} [${difference.releases.length} releases] ${difference.evidence}\n`,
      );
    }
  }
}
const out = option("--json");
if (out) await writeFile(out, `${JSON.stringify(comparisons, null, 2)}\n`);
