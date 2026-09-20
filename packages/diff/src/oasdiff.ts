import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { OpenApiDocument } from "@invariant/contract";

const run = promisify(execFile);

export interface DiffEntry {
  id: string;
  text: string;
  comment?: string;
  /** 3 is ERR, 2 is WARN, 1 is INFO, as oasdiff reports them. */
  level: number;
  operation: string;
  operationId: string;
  path: string;
  section: string;
  fingerprint: string;
}

export class OasdiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OasdiffError";
  }
}

export function oasdiffBinary(): string {
  return process.env["OASDIFF_BIN"] ?? "oasdiff";
}

export async function oasdiffAvailable(): Promise<boolean> {
  try {
    await run(oasdiffBinary(), ["--version"]);
    return true;
  } catch {
    return false;
  }
}

export interface DiffOptions {
  /** Merge allOf subschemas before diffing, so composition noise does not appear as change. */
  flattenAllOf?: boolean;
}

async function changelogFiles(
  baseFile: string,
  revisionFile: string,
  options: DiffOptions,
): Promise<DiffEntry[]> {
  const args = [
    "changelog",
    baseFile,
    revisionFile,
    "--format",
    "json",
    // Specs are untrusted input, so never let the differ fetch a remote ref.
    "--allow-external-refs=false",
  ];
  if (options.flattenAllOf !== false) args.push("--flatten-allof");

  let stdout: string;
  try {
    ({ stdout } = await run(oasdiffBinary(), args, { maxBuffer: 64 * 1024 * 1024 }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new OasdiffError(
      `Could not run ${oasdiffBinary()}. Install it with ` +
        `"go install github.com/oasdiff/oasdiff@latest" or set OASDIFF_BIN.\n${detail}`,
    );
  }

  const trimmed = stdout.trim();
  if (trimmed === "" || trimmed === "null") return [];

  const parsed: unknown = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new OasdiffError("oasdiff returned something other than a changelog array");
  }
  return parsed as DiffEntry[];
}

/** Structural changelog between two in-memory documents. */
export async function diffDocuments(
  base: OpenApiDocument,
  revision: OpenApiDocument,
  options: DiffOptions = {},
): Promise<DiffEntry[]> {
  const dir = await mkdtemp(join(tmpdir(), "invariant-diff-"));
  try {
    const baseFile = join(dir, "base.json");
    const revisionFile = join(dir, "revision.json");
    await Promise.all([
      writeFile(baseFile, JSON.stringify(base)),
      writeFile(revisionFile, JSON.stringify(revision)),
    ]);
    return await changelogFiles(baseFile, revisionFile, options);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
