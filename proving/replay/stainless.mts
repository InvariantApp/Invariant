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
 * What the SDK calls each schema is the symbol map `@invariant-app/symbols`
 * makes from the old release (`releaseSymbols`): Stainless names a response
 * model after its schema (`BetaMessage`) and a request type with `Param`
 * after it (`ToolParam`), and what neither name finds is found by its
 * fields. A class is named by the shortest path a consumer imports it by
 * (`anthropic.types.beta.BetaMessage`).
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type OpenApiDocument, readDocument } from "@invariant-app/contract";
import { breakingBetween } from "./forced.mts";
import {
  type ContractPlan,
  draftChanges,
  releaseSymbols,
  SPECS,
  wireOf,
} from "./stripe.mts";

/** The PyPI packages Stainless generates, and the repositories their tags are in. */
export const STAINLESS: Record<string, string> = {
  anthropic: "anthropics/anthropic-sdk-python",
  openai: "openai/openai-python",
};

const URLS = join(SPECS, "stainless-specs.json");

/** The specification a release was built from, as its `.stats.yml` names it. */
async function specUrl(pkg: string, version: string): Promise<string> {
  const known: Record<string, string> = existsSync(URLS)
    ? (JSON.parse(readFileSync(URLS, "utf8")) as Record<string, string>)
    : {};
  const key = `${pkg}@${version}`;
  const cached = known[key];
  if (cached) return cached;
  const response = await fetch(
    `https://raw.githubusercontent.com/${STAINLESS[pkg]}/v${version}/.stats.yml`,
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

/** The specification a Stainless release was built from. */
export async function stainlessSpecification(
  pkg: string,
  version: string,
): Promise<OpenApiDocument> {
  return (await specification(await specUrl(pkg, version))).document;
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
  const { types, operations } = await releaseSymbols(
    site,
    "python",
    before.document,
    pkg,
  );
  return {
    ...drafted,
    types,
    wire: wireOf(before.document),
    // How a Stainless API tags its objects is not read yet; the engine finds
    // them through the SDK's types instead.
    tags: { property: "type", schemas: {} },
    operations,
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
