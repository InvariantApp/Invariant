/**
 * Rig E, what broke in GitHub's REST API between the two releases of an SDK
 * generated from its published description, for judging which contract sites
 * an upgrade forced (`forced.mts`).
 *
 * go-github records the commit of github/rest-api-description it was built
 * from, as `openapi_commit` in its `openapi_operations.yaml`. Octokit's types
 * come from octokit/openapi, whose release `@octokit/openapi-types` records as
 * `octokit["openapi-version"]`, and a consumer's lockfile pins that package on
 * each side of the upgrade. Either way the two specifications are exact, never
 * guessed from a date or a range; where a release says nothing, the case is not
 * judged.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type OpenApiDocument, readDocument } from "@invariant-app/contract";
import { breakingBetween } from "./forced.mts";
import { SPECS } from "./stripe.mts";

/** A specification of GitHub's API, fetched once and kept. */
async function specification(name: string, url: string): Promise<OpenApiDocument> {
  const path = join(SPECS, `github-${name}.json`);
  if (!existsSync(path)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    await mkdir(SPECS, { recursive: true });
    await writeFile(path, await response.text());
  }
  return readDocument(path);
}

/** The broken names between two GitHub specifications, each named and fetched by `source`. */
async function between(
  from: string,
  to: string,
  source: (ref: string) => { name: string; url: string },
): Promise<string[] | undefined> {
  if (from === to) return [];
  const [before, after] = [source(from), source(to)];
  return breakingBetween(
    await specification(before.name, before.url),
    await specification(after.name, after.url),
    join(SPECS, "breaking", `github-${before.name}-${after.name}.json`),
  );
}

/** The rest-api-description commit a go-github module was generated from. */
export function openapiCommitOf(moduleDir: string): string | undefined {
  const path = join(moduleDir, "openapi_operations.yaml");
  if (!existsSync(path)) return undefined;
  return /^openapi_commit:\s*([0-9a-f]{40})\s*$/m.exec(readFileSync(path, "utf8"))?.[1];
}

/** What GitHub's API broke between two go-github modules, where both say what they were built from. */
export async function goGithubBreaking(
  oldModule: string,
  newModule: string,
): Promise<string[] | undefined> {
  const from = openapiCommitOf(oldModule);
  const to = openapiCommitOf(newModule);
  if (!from || !to) return undefined;
  return between(from, to, (commit) => ({
    name: commit.slice(0, 12),
    url: `https://raw.githubusercontent.com/github/rest-api-description/${commit}/descriptions/api.github.com/api.github.com.json`,
  }));
}

/** The octokit/openapi release an `@octokit/openapi-types` version records. */
async function openapiVersion(typesVersion: string): Promise<string | undefined> {
  const response = await fetch(
    `https://registry.npmjs.org/@octokit/openapi-types/${encodeURIComponent(typesVersion)}`,
  );
  if (!response.ok) return undefined;
  const manifest = (await response.json()) as {
    octokit?: { "openapi-version"?: string };
  };
  return manifest.octokit?.["openapi-version"];
}

/** The SDKs whose types are Octokit's, so whose upgrades move `@octokit/openapi-types`. */
export const OCTOKIT_SDKS = new Set(["@octokit/rest", "@actions/github", "octokit"]);

/**
 * What GitHub's API broke between two locked `@octokit/openapi-types`
 * versions, where the registry says which octokit/openapi release each is.
 */
export async function octokitBreaking(
  oldTypes: string,
  newTypes: string,
): Promise<string[] | undefined> {
  const [from, to] = await Promise.all([
    openapiVersion(oldTypes),
    openapiVersion(newTypes),
  ]);
  if (!from || !to) return undefined;
  return between(from, to, (version) => ({
    name: `octokit-${version}`,
    url: `https://raw.githubusercontent.com/octokit/openapi/v${version}/generated/api.github.com.json`,
  }));
}
