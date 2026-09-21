import { execFile } from "node:child_process";
import { chmodSync, existsSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ambiguousPaths, type OpenApiDocument } from "@invariant/contract";
import { binaryFor } from "./binaries.ts";
import { BREAKING_INFO_IDS } from "./policy.ts";
import { OASDIFF_INSTALL, unusableVersion } from "./version.ts";

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

/**
 * Which oasdiff to run.
 *
 * An explicit OASDIFF_BIN wins, so a provider can always choose. Then the
 * binary published for this platform alongside the packages, so the gate needs
 * no Go toolchain. Then whatever is on PATH.
 */
export function oasdiffBinary(): string {
  const configured = process.env["OASDIFF_BIN"];
  if (configured) return configured;
  return bundledBinary() ?? "oasdiff";
}

function bundledBinary(): string | undefined {
  const binary = binaryFor();
  if (!binary) return undefined;
  try {
    const manifest = createRequire(import.meta.url).resolve(
      `${binary.package}/package.json`,
    );
    const path = join(dirname(manifest), "bin", binary.executable);
    if (!existsSync(path)) return undefined;
    // Declared as a bin so the package manager marks it executable, but a
    // copy made some other way can arrive without the bit. Put it back once
    // rather than report a binary that is present as missing.
    if (process.platform !== "win32" && (statSync(path).mode & 0o111) === 0) {
      try {
        chmodSync(path, 0o755);
      } catch {
        // A read-only install. The version check says so precisely.
      }
    }
    return path;
  } catch {
    // Not installed, which is normal on an unsupported platform or when
    // optional dependencies were skipped.
    return undefined;
  }
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
 * Throws unless the installed oasdiff is one the gate can rely on.
 *
 * Missing and too old are different failures with different fixes, and both
 * name the exact release to install.
 */
export async function assertUsableOasdiff(): Promise<void> {
  const binary = oasdiffBinary();
  let output: string;
  try {
    output = (await run(binary, ["--version"])).stdout;
  } catch (error) {
    if ((error as { code?: string }).code === "EACCES") {
      // Present but not executable, which a missing-binary message would send
      // someone looking for in entirely the wrong place.
      throw new OasdiffError(
        `${binary} exists but cannot be executed. Make it executable, or set ` +
          "OASDIFF_BIN to one that can be.",
      );
    }
    throw new OasdiffError(
      `oasdiff is required and was not found. Install it with "${OASDIFF_INSTALL}", ` +
        "or set OASDIFF_BIN to its path.",
    );
  }
  const problem = unusableVersion(output);
  if (problem) throw new OasdiffError(problem);
}

/**
 * How long one diff may run before it is abandoned.
 *
 * Five minutes rather than two, because two was not enough for a real
 * provider and a gate that gives up on the largest one is not a gate. A full
 * Stripe step takes about a minute for the first comparison and longer for the
 * closure check that follows it.
 *
 * An earlier version of this comment claimed the cost tracks the size of the
 * difference. That turned out to be wrong and is recorded here because it sent
 * the investigation in the wrong direction for some time: Stripe's month-apart
 * step changes two paths and 55 schemas, which is tiny. What actually drives
 * the cost is composition and whether `allOf` merging is switched on, and a
 * bound is still needed because without one the gate hangs rather than fails.
 */
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * No memory limit by default, which is the opposite of what was tried first.
 *
 * `GOMEMLIMIT` was set to 2 GiB on the reasoning that a soft limit makes Go
 * collect harder rather than be killed. That reasoning is wrong when the limit
 * is below the live heap: there is nothing to collect, so Go collects
 * continuously and makes no progress. Setting it to 1200 MiB on a pair whose
 * live heap is about 2.4 GB turned a twenty second diff into one still running
 * eight minutes later, and it did not reduce the peak at all.
 *
 * Memory is therefore bounded from outside, by whoever runs this, and the
 * timeout is what protects the caller. A limit is still accepted for a caller
 * who knows their documents fit under it.
 */
const DEFAULT_MEMORY_LIMIT: string | undefined = undefined;

export interface DiffOptions {
  /**
   * Merge allOf subschemas before diffing, so composition noise does not appear
   * as change. On by default; pass false to compare without merging.
   */
  flattenAllOf?: boolean;
  /** Resolved from `flattenAllOf` and the documents. Internal. */
  flatten?: boolean;
  /** Abandon the diff after this long. Defaults to two minutes. */
  timeoutMs?: number;
  /** Passed to the differ as `GOMEMLIMIT`. Unset by default: see above. */
  memoryLimit?: string;
  /** Which subcommand to run. Internal: the fallback sets it. */
  mode?: DiffMode;
  /** Extra arguments. Internal: the fallback sets it. */
  extraArgs?: string[];
  /**
   * Whether to retry with the reduced breaking-only path when the full
   * changelog cannot be computed. On by default, because a provider large
   * enough to exhaust the differ still has to be able to release.
   */
  fallback?: boolean;
  /**
   * Repeat the comparison and refuse the result if it does not come back the
   * same. Off by default because it doubles the work; on wherever a number is
   * about to be trusted.
   */
  confirm?: boolean;
}

/** Raised when the differ gives two different answers for the same input. */
export class UnstableDiffError extends Error {
  /**
   * Declared rather than written as constructor parameter properties, which
   * the runtime's type stripping does not accept. The tests transpile and
   * passed; the command line strips types and did not.
   */
  readonly first: number;
  readonly second: number;

  constructor(first: number, second: number) {
    super(
      `The differ returned ${first} entries and then ${second} for the same two ` +
        "documents, so its answer here is not reproducible and no count from it " +
        "means anything. This is a defect in oasdiff 1.32.1 rather than in the " +
        "documents: three runs of one Stripe comparison returned 18,990, 38,442 " +
        "and 23,838 entries, and no run's findings were a subset of another's.",
    );
    this.first = first;
    this.second = second;
    this.name = "UnstableDiffError";
  }
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
      `"${OASDIFF_INSTALL}" or set OASDIFF_BIN.`
    );
  }
  if (failure.killed === true || failure.signal === "SIGTERM") {
    return (
      `${binary} did not finish within ${timeoutMs} ms and was stopped. ` +
      "Comparison cost is driven by how the documents compose their schemas " +
      `rather than by how far apart the two versions are.${tail}`
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

/**
 * How the entries were obtained.
 *
 * `changelog` is every delta, breaking and additive. `breaking` is the reduced
 * path taken when the full changelog cannot be computed: it answers the only
 * question the gate must answer, and gives up the additive counts to do it.
 */
/**
 * Which rung of the ladder produced the entries.
 *
 * Each step down buys affordability with fidelity, and every step is forced by
 * a measurement rather than chosen:
 *
 * - `changelog` is every delta, breaking and additive. It cannot be computed
 *   for two consecutive Stripe documents at any memory this project has tried.
 * - `breaking` drops the additive half. Verified against the full changelog on
 *   58 real pairs to report exactly the same breaking entries.
 * - `breaking-unflattened` also stops merging `allOf` before comparing, which
 *   is the single thing that made Stripe unaffordable: with the merge it
 *   exhausted 3.4 GB in eight seconds, and without it the same pair finished in
 *   thirty. The cost is that composition noise is no longer collapsed, so this
 *   rung reports a superset. It fails closed, which is the right direction for
 *   a gate, but a count from it is an upper bound rather than a measurement.
 */
export type DiffMode = "changelog" | "breaking" | "breaking-unflattened";

export interface DiffOutcome {
  entries: DiffEntry[];
  mode: DiffMode;
}

function exhausted(error: unknown): boolean {
  if (error instanceof OasdiffError) {
    return /did not finish within|ran out of|killed by the system/.test(error.message);
  }
  const failure = (error ?? {}) as SpawnFailure;
  return (
    failure.killed === true ||
    failure.signal === "SIGTERM" ||
    failure.signal === "SIGKILL"
  );
}

/**
 * Promotes the checks this policy calls breaking but oasdiff rates INFO.
 *
 * `oasdiff breaking` reports WARN and ERR only, so without this the reduced
 * path would silently lose two checks the policy depends on: a required
 * response property appearing, and a response enum value going away. Written
 * from `BREAKING_INFO_IDS` rather than typed out, so it cannot drift from the
 * policy it exists to preserve.
 */
async function severityFile(dir: string): Promise<string> {
  const path = join(dir, "severity.txt");
  await writeFile(
    path,
    `${[...BREAKING_INFO_IDS].map((id) => `${id} warn`).join("\n")}\n`,
  );
  return path;
}

async function changelogFiles(
  baseFile: string,
  revisionFile: string,
  options: DiffOptions,
): Promise<DiffEntry[]> {
  const subcommand =
    options.mode === "breaking-unflattened" ? "breaking" : (options.mode ?? "changelog");
  const args = [
    subcommand,
    baseFile,
    revisionFile,
    "--format",
    "json",
    // Specs are untrusted input, so never let the differ fetch a remote ref.
    "--allow-external-refs=false",
    // Where a parameter is declared, once for a whole path or on each
    // operation, is not something a caller can see. Without this, moving a
    // shared parameter onto the operations that use it reads as removing it,
    // and a prediction that copies one into a single operation fails closure
    // over a difference no request would ever show.
    "--flatten-params",
    ...(options.extraArgs ?? []),
  ];
  if (options.flatten === true) args.push("--flatten-allof");

  const timeoutMs =
    options.timeoutMs ?? Number(process.env["OASDIFF_TIMEOUT_MS"] ?? DEFAULT_TIMEOUT_MS);
  const memoryLimit =
    options.memoryLimit ?? process.env["OASDIFF_MEMORY_LIMIT"] ?? DEFAULT_MEMORY_LIMIT;

  if (process.env["OASDIFF_DEBUG"]) {
    process.stderr.write(`[oasdiff] ${args.join(" ")}\n`);
  }

  let stdout: string;
  try {
    ({ stdout } = await run(oasdiffBinary(), args, {
      // 64 MiB was not enough for a real provider. One Stripe step reports
      // 166,331 breaking entries, about 66 MiB of JSON, and truncating that
      // surfaced as a child-process error rather than as anything a reader
      // could act on. The entries are held as text only until they are parsed,
      // and the differ that produced them is far larger while it runs.
      maxBuffer: 512 * 1024 * 1024,
      timeout: timeoutMs,
      // SIGKILL rather than SIGTERM. A differ that has run out of time is often
      // one thrashing its collector, and in that state it does not get around
      // to handling a polite signal: one ignored SIGTERM for minutes. A timeout
      // is still told apart from an out-of-memory kill, because Node reports
      // `killed` for the deadline it enforced and not for a kill from outside.
      killSignal: "SIGKILL",
      env:
        memoryLimit === undefined
          ? process.env
          : { ...process.env, GOMEMLIMIT: memoryLimit },
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

/**
 * Structural changelog between two in-memory documents.
 *
 * Falls back to the breaking-only path when the full changelog cannot be
 * computed. That is not a theoretical case: two consecutive Stripe documents
 * generate over 55,000 changelog entries from a dozen changed schemas, because
 * a schema Stripe reuses across 589 operations fans out once per operation, and
 * the differ builds all of them in memory before any level filter applies. The
 * breaking-only path evaluates fewer checks and completes on the same pair in
 * about twenty seconds.
 *
 * The trade is explicit: the reduced path answers the question the gate must
 * answer and gives up the additive counts, and it says which path it took so
 * nothing downstream reports a count it did not measure.
 */
export async function diffOutcome(
  base: OpenApiDocument,
  revision: OpenApiDocument,
  options: DiffOptions = {},
): Promise<DiffOutcome> {
  const dir = await mkdtemp(join(tmpdir(), "invariant-diff-"));
  try {
    const baseFile = join(dir, "base.json");
    const revisionFile = join(dir, "revision.json");
    await Promise.all([
      writeFile(baseFile, JSON.stringify(base)),
      writeFile(revisionFile, JSON.stringify(revision)),
    ]);

    const requested: DiffMode = options.mode ?? "changelog";
    // Always, which is what the design asked for and what a working differ
    // allows. It was made conditional while oasdiff 1.32.1 could not afford it,
    // and that reason is gone: on the pinned build the same Stripe pair
    // flattens in five seconds and returns the same answer every time.
    const flatten = options.flattenAllOf !== false;
    // Any breaking-only rung needs the promotions, not just the first one.
    // Without them the two checks this policy calls breaking at INFO are not
    // reported at all, which is how a reduced run quietly loses 154 real Plaid
    // enum removals.
    const extra =
      requested !== "changelog" && options.extraArgs === undefined
        ? ["--severity-levels", await severityFile(dir)]
        : (options.extraArgs ?? []);
    try {
      const call = () =>
        changelogFiles(baseFile, revisionFile, {
          ...options,
          mode: requested,
          extraArgs: extra,
          flatten,
        });
      const entries = await call();
      if (options.confirm === true) {
        const again = await call();
        if (!sameFindings(entries, again)) {
          throw new UnstableDiffError(entries.length, again.length);
        }
      }
      return { entries, mode: requested };
    } catch (error) {
      if (error instanceof UnstableDiffError) throw error;
      // Only a differ that was stopped is worth retrying. A malformed document
      // or a dangling reference fails the same way twice, and retrying it would
      // just double the wait before reporting the same thing.
      if (options.fallback === false || !exhausted(error))
        throw explain(error, base, revision);

      const severity = ["--severity-levels", await severityFile(dir)];
      const rungs: DiffMode[] =
        requested === "changelog" ? ["breaking", "breaking-unflattened"] : [];

      let last = error;
      for (const rung of rungs) {
        try {
          return {
            entries: await changelogFiles(baseFile, revisionFile, {
              ...options,
              mode: rung,
              extraArgs: severity,
              flatten: rung === "breaking-unflattened" ? false : flatten,
            }),
            mode: rung,
          };
        } catch (next) {
          if (!exhausted(next)) throw next;
          last = next;
        }
      }
      throw last;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Whether two runs found the same things, by fingerprint. */
function sameFindings(
  first: readonly DiffEntry[],
  second: readonly DiffEntry[],
): boolean {
  if (first.length !== second.length) return false;
  const seen = new Set(second.map((entry) => entry.fingerprint));
  return first.every((entry) => seen.has(entry.fingerprint));
}

/**
 * Adds what this side knows to a failure from the differ.
 *
 * The differ refuses documents whose endpoints collide, and it says `exited
 * with 104`, which sends the reader to their own installation. Colliding
 * templates are cheap to find here, so the number becomes a sentence naming the
 * two paths. Only added when they are actually present: plenty of providers
 * ship colliding templates that the differ accepts, so this is a diagnosis
 * rather than a rule.
 */
function explain(
  error: unknown,
  base: OpenApiDocument,
  revision: OpenApiDocument,
): unknown {
  if (!(error instanceof OasdiffError)) return error;
  const clash = ambiguousPaths(base)[0] ?? ambiguousPaths(revision)[0];
  if (!clash) return error;
  return new OasdiffError(
    `${error.message}\n\n${clash.join(" and ")} are the same endpoint once the ` +
      "parameter names are taken out, which is usually what the differ is " +
      "objecting to.",
  );
}

/** The entries alone, for callers that do not care how they were obtained. */
export async function diffDocuments(
  base: OpenApiDocument,
  revision: OpenApiDocument,
  options: DiffOptions = {},
): Promise<DiffEntry[]> {
  return (await diffOutcome(base, revision, options)).entries;
}
