/**
 * The pinned corpus: which real specifications, byte for byte.
 *
 * The corpus used to be whatever the fetchers found when they last ran, so a
 * run on another day, or on a CI runner, measured different documents and a
 * change in a headline number could not be told apart from a change in the
 * denominator. The manifest names every file by a URL at an exact commit and
 * its sha256, and nothing is measured that does not match.
 *
 * Specifications are never committed. They belong to the providers who wrote
 * them and are megabytes each. They are downloaded into `.cache/corpus/`, named
 * by their hash, and checked on the way in.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const MANIFEST = join(ROOT, "proving/corpus/manifest.json");
export const CACHE = join(ROOT, ".cache/corpus");

export interface ManifestFile {
  /** The provider's own name for this state: a version, or a date and commit. */
  label: string;
  /** Where the exact bytes are, at a commit that cannot move. */
  url: string;
  sha256: string;
  format: "json" | "yaml" | "yml";
}

export interface ManifestPair {
  api: string;
  title: string;
  provider: string;
  source: "git" | "apis.guru";
  from: ManifestFile;
  to: ManifestFile;
}

export interface Manifest {
  about: string;
  pairs: ManifestPair[];
}

/** A pair with both specifications on disk and verified. */
export interface LocalPair extends ManifestPair {
  fromPath: string;
  toPath: string;
}

export async function readManifest(): Promise<Manifest> {
  return JSON.parse(await readFile(MANIFEST, "utf8")) as Manifest;
}

const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

export function cachePath(file: ManifestFile): string {
  return join(CACHE, `${file.sha256}.${file.format === "json" ? "json" : "yaml"}`);
}

/**
 * The file on disk, downloaded if it is not there, and refused if its bytes
 * are not the ones the manifest names.
 */
export async function materialize(file: ManifestFile): Promise<string> {
  const path = cachePath(file);
  if (existsSync(path)) {
    if (sha256(await readFile(path)) === file.sha256) return path;
  }

  await mkdir(CACHE, { recursive: true });
  const token = process.env["GITHUB_TOKEN"];
  const response = await fetch(file.url, {
    headers: {
      "user-agent": "invariant-proving",
      ...(token && file.url.startsWith("https://raw.githubusercontent.com/")
        ? { authorization: `Bearer ${token}` }
        : {}),
    },
  });
  if (!response.ok) throw new Error(`${response.status} fetching ${file.url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== file.sha256) {
    throw new Error(
      `${file.url} is not the file this corpus pinned: it hashes to ${actual}, not ${file.sha256}`,
    );
  }
  // Written aside and renamed, so an interrupted download never leaves a
  // truncated file under a name that claims to be verified.
  const partial = `${path}.partial`;
  await writeFile(partial, bytes);
  await rename(partial, path);
  return path;
}

export async function materializePair(pair: ManifestPair): Promise<LocalPair> {
  return {
    ...pair,
    fromPath: await materialize(pair.from),
    toPath: await materialize(pair.to),
  };
}

/**
 * The slice of the corpus one CI job runs.
 *
 * Sharded by provider, so one job's report is about whole providers and a
 * provider whose specifications are large does not share a runner's memory
 * with another's. Pairs with no shard run everything.
 */
export function shardOf(
  pairs: readonly ManifestPair[],
  shard: { index: number; count: number } | undefined,
): ManifestPair[] {
  if (!shard) return [...pairs];
  const providers = [...new Set(pairs.map((pair) => pair.provider))].sort();
  const mine = new Set(
    providers.filter((_, index) => index % shard.count === shard.index),
  );
  return pairs.filter((pair) => mine.has(pair.provider));
}
