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
import { createHash, randomUUID } from "node:crypto";
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

/** Retries after a server error or a dropped connection. */
const BACKOFF_MS = [1_000, 3_000, 9_000];

async function fetchBytes(url: string): Promise<Buffer> {
  const token = process.env["GITHUB_TOKEN"];
  const headers = {
    "user-agent": "invariant-proving",
    ...(token && url.startsWith("https://raw.githubusercontent.com/")
      ? { authorization: `Bearer ${token}` }
      : {}),
  };
  let failure = "";
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt += 1) {
    if (attempt > 0) {
      await new Promise((done) => setTimeout(done, BACKOFF_MS[attempt - 1]));
    }
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      failure = String(response.status);
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`${failure} fetching ${url}`);
}

async function download(file: ManifestFile, path: string): Promise<string> {
  if (existsSync(path) && sha256(await readFile(path)) === file.sha256) return path;
  await mkdir(CACHE, { recursive: true });
  const bytes = await fetchBytes(file.url);
  const actual = sha256(bytes);
  if (actual !== file.sha256) {
    throw new Error(
      `${file.url} is not the file this corpus pinned: it hashes to ${actual}, not ${file.sha256}`,
    );
  }
  // Written aside and renamed, so an interrupted download never leaves a
  // truncated file under a name that claims to be verified. The aside name is
  // this writer's own: another process fetching the same file renames its own
  // copy of the same bytes, and whichever lands last changes nothing.
  const partial = `${path}.${process.pid}.${randomUUID()}.partial`;
  await writeFile(partial, bytes);
  await rename(partial, path);
  return path;
}

// Consecutive pairs share a specification, the newer half of one being the
// older half of the next, so concurrent pairs ask for the same file. It is
// fetched once per process.
const inFlight = new Map<string, Promise<string>>();

/**
 * The file on disk, downloaded if it is not there, and refused if its bytes
 * are not the ones the manifest names.
 */
export function materialize(file: ManifestFile): Promise<string> {
  const path = cachePath(file);
  let pending = inFlight.get(path);
  if (!pending) {
    pending = download(file, path).finally(() => inFlight.delete(path));
    inFlight.set(path, pending);
  }
  return pending;
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
