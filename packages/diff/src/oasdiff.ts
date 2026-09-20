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

/**
 * How long one diff may run before it is abandoned.
 *
 * Diff cost tracks the size of the difference rather than the size of the
 * documents. Two 13 MB GitHub specifications a day apart diff in three
 * seconds; two 7.6 MB Stripe specifications a month apart ran for nearly six
 * minutes of CPU and were still going. Without a bound the gate does not fail,
 * it hangs, and the provider most worth having is the one it hangs on.
 */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * What the Go runtime is told to stay under.
 *
 * A soft limit: Go collects harder as it approaches rather than refusing to
 * allocate. That is the behaviour wanted here, because finishing slowly beats
 * being killed. The same Stripe pair reached 3.1 GB resident with no limit set
 * and took the whole machine down with it.
 */
const DEFAULT_MEMORY_LIMIT = "2GiB";

export interface DiffOptions {
  /** Merge allOf subschemas before diffing, so composition noise does not appear as change. */
  flattenAllOf?: boolean;
  /** Abandon the diff after this long. Defaults to two minutes. */
  timeoutMs?: number;
  /** Passed to the differ as `GOMEMLIMIT`. Defaults to 2 GiB. */
  memoryLimit?: string;
}

/** What `execFile` attaches to a failure, none of which is declared on `Error`. */
interface SpawnFailure {
  code?: string | number;
  signal?: string | null;
  killed?: boolean;
  stderr?: string;
}

/**
 * Says what actually went wrong.
 *
 * Every failure here used to read "Could not run oasdiff. Install it with...",
 * including the ones where it was installed, ran, and was killed for using
 * three gigabytes. A report full of that sentence sends the reader to their
 * PATH instead of to the real cause, which is what happened the first time
 * these specifications were run.
 */
function describeFailure(error: unknown, binary: string, timeoutMs: number): string {
  const failure = (error ?? {}) as SpawnFailure;
  const detail = error instanceof Error ? error.message : String(error);
  const stderr = failure.stderr?.trim();
  const tail = stderr ? `\n${stderr.slice(0, 2000)}` : "";

  if (failure.code === "ENOENT") {
    return (
      `Could not find ${binary}. Install it with ` +
      `"go install github.com/oasdiff/oasdiff@latest" or set OASDIFF_BIN.`
    );
  }
  if (failure.killed === true || failure.signal === "SIGTERM") {
    return (
      `${binary} did not finish within ${timeoutMs} ms and was stopped. ` +
      "Diff cost grows with the size of the difference, so this usually means " +
      `the two documents are far apart rather than large.${tail}`
    );
  }
  if (failure.signal === "SIGKILL") {
    return (
      `${binary} was killed by the system, which on this path means it ran out ` +
      "of memory. Lower `memoryLimit` or diff a smaller step." +
      tail
    );
  }
  return `${binary} exited with ${String(failure.code ?? "an error")}.${tail || `\n${detail}`}`;
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

  const timeoutMs =
    options.timeoutMs ?? Number(process.env["OASDIFF_TIMEOUT_MS"] ?? DEFAULT_TIMEOUT_MS);
  const memoryLimit =
    options.memoryLimit ?? process.env["OASDIFF_MEMORY_LIMIT"] ?? DEFAULT_MEMORY_LIMIT;

  let stdout: string;
  try {
    ({ stdout } = await run(oasdiffBinary(), args, {
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
      // SIGTERM lets the differ unwind; the caller is told which signal ended
      // it, which is how a timeout is told apart from an out-of-memory kill.
      killSignal: "SIGTERM",
      env: { ...process.env, GOMEMLIMIT: memoryLimit },
    }));
  } catch (error) {
    throw new OasdiffError(describeFailure(error, oasdiffBinary(), timeoutMs));
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
