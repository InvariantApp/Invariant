/**
 * `invariant migrate <job.json>`: one consumer repository moved to one
 * release, by the same engine the hosted service runs.
 *
 * A job names the repository, the language it is written in, the Changes
 * (from a signed bundle, or listed), the SDK map, and the release the
 * consumer uses today. The migration is always two steps. The fetch
 * downloads both releases of the SDK, and for Go the modules the consumer
 * and the SDK need, with install scripts off and nothing from the
 * repository but its go.mod. The analysis then reads the repository
 * against them without touching the network, and says what it would edit
 * and what it leaves to a person.
 *
 * By default both steps run here, in this process. With `--sandbox
 * oci-rootless` each runs in a container of its own (`@invariant-app/sandbox`):
 * the fetch on a network whose only way out is the registry allowlist, the
 * analysis with no network at all. The containers run this same
 * installation of the CLI, mounted read-only, as `migrate --phase`, so the
 * code is the same either way and only where it runs differs. What comes
 * back from a sandbox is checked before anything is believed or written:
 * every path must name a file inside the repository.
 */
import { existsSync, realpathSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type DsseEnvelope, openBundle } from "@invariant-app/bundle";
import type { Change } from "@invariant-app/ir";
import { buildPlan, type ManualSite, type SymbolMap } from "@invariant-app/migrate-core";
import {
  ENGINE,
  exec,
  type LocalWorkspace,
  NODE_IMAGE,
  type OciRuntime,
  ociSandbox,
  type PhaseResult,
  WORKSPACE,
} from "@invariant-app/sandbox";

export type Language = "typescript" | "python" | "go";

/** How a Go SDK names what a contract describes (`@invariant-app/migrate-go`'s `GoSymbolMap`). */
export interface GoSdkMap {
  module: { path: string; version?: string };
  upgradeTo: { path: string; version: string };
  types: Record<string, { package: string; key: string }>;
  [field: string]: unknown;
}

/**
 * A job with everything read in: the only paths left are the repository
 * and what is inside it, so the same job can be handed to a sandbox with
 * the repository mounted somewhere else.
 */
export interface MigrationJob {
  language: Language;
  /** The consumer's repository. */
  repo: string;
  changes: Change[];
  sdk: SymbolMap | GoSdkMap;
  /** The release of the SDK the consumer uses today. */
  from: string;
  /** TypeScript: the project file, relative to the repository (default tsconfig.json). */
  tsconfig?: string;
  /** TypeScript and Python: the files to read, relative to the repository. */
  sources?: string[];
  /** Go: the module's directory, relative to the repository (default the root). */
  module?: string;
  /** Go: the packages to read, as the go command takes them (default ./...). */
  packages?: string[];
}

/** What the fetch downloads. Nothing in it is read from the repository but a go.mod. */
export interface FetchPlan {
  npm: { name: string; version: string }[];
  pypi: { name: string; version: string }[];
  go?: {
    /** The consumer module's go.mod and go.sum, as text. */
    mod: string;
    sum: string;
    releases: { path: string; version: string }[];
  };
}

/** What the fetch left, relative to the directory it fetched into. */
export interface Fetched {
  npm: Record<string, string>;
  pypi: Record<string, string[]>;
  go?: { modCache: string };
  /** What could not be fetched and was left out, such as a dependency with no wheel. */
  skipped: string[];
}

export interface MigrationOutcome {
  language: Language;
  /** New contents of each file the migration changed, by path in the repository. */
  files: Record<string, string>;
  /** Places left to a person, by path in the repository. */
  manual: { file: string; line: number; changeId: string; reason: string }[];
  edits: number;
  /** Type errors before the edits against the old release, and after them against the new. */
  diagnostics: { before: number; after: number };
  notes: string[];
}

export class MigrateError extends Error {
  override name = "MigrateError";
}

const LANGUAGES: readonly Language[] = ["typescript", "python", "go"];
const VERSION = /^v?[0-9A-Za-z][0-9A-Za-z.+-]*$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A path inside the repository: relative, and never climbing out of it. */
function inside(path: string, what: string): string {
  const normal = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    normal.length === 0 ||
    isAbsolute(normal) ||
    /^[A-Za-z]:/.test(normal) ||
    normal.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new MigrateError(`${what} must be a path inside the repository, not ${path}`);
  }
  return normal;
}

function strings(value: unknown, what: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new MigrateError(`${what} must be a list of paths`);
  }
  return (value as string[]).map((entry) => inside(entry, what));
}

/** The SDK release names the fetch downloads, checked before anything runs. */
function packageName(name: unknown, what: string): string {
  if (
    typeof name !== "string" ||
    !/^(@[a-z0-9][\w.-]*\/)?[A-Za-z0-9][\w.-]*$/.test(name)
  ) {
    throw new MigrateError(`${what} is not a package name: ${String(name)}`);
  }
  return name;
}

function version(value: unknown, what: string): string {
  if (typeof value !== "string" || !VERSION.test(value)) {
    throw new MigrateError(`${what} is not a version: ${String(value)}`);
  }
  return value;
}

/** The Changes a job names: a signed bundle opened with a trusted key, or a list. */
async function changesOf(
  job: Record<string, unknown>,
  base: string,
  keys: readonly string[],
): Promise<Change[]> {
  if (job["bundle"] !== undefined) {
    if (typeof job["bundle"] !== "string")
      throw new MigrateError("bundle must be a path");
    if (keys.length === 0) {
      throw new MigrateError(
        "a bundle's Changes are only used once its signature is checked: pass --key with the publisher's public key",
      );
    }
    const envelope = JSON.parse(
      await readFile(resolve(base, job["bundle"]), "utf8"),
    ) as DsseEnvelope;
    return openBundle(envelope, keys).bundle.changes;
  }
  const changes =
    typeof job["changes"] === "string"
      ? (JSON.parse(await readFile(resolve(base, job["changes"]), "utf8")) as unknown)
      : job["changes"];
  if (!Array.isArray(changes)) {
    throw new MigrateError(
      "a job needs a bundle (a signed release) or changes (a list of Changes)",
    );
  }
  return changes as Change[];
}

/**
 * Reads a job file. Paths in it are relative to it; the bundle, the Changes
 * and the SDK map are read in, so what is returned stands on its own.
 */
export async function readJob(
  path: string,
  options: { keys?: readonly string[] } = {},
): Promise<MigrationJob> {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isObject(raw)) throw new MigrateError(`${path} is not a JSON object`);
  const base = dirname(resolve(path));
  const language = raw["language"];
  if (!LANGUAGES.includes(language as Language)) {
    throw new MigrateError(`language must be one of ${LANGUAGES.join(", ")}`);
  }
  if (typeof raw["repo"] !== "string") throw new MigrateError("repo must be a path");
  const sdk =
    typeof raw["sdk"] === "string"
      ? (JSON.parse(await readFile(resolve(base, raw["sdk"]), "utf8")) as unknown)
      : raw["sdk"];
  const job: MigrationJob = {
    language: language as Language,
    repo: resolve(base, raw["repo"]),
    changes: await changesOf(raw, base, options.keys ?? []),
    sdk: sdk as MigrationJob["sdk"],
    from: version(raw["from"], "from"),
  };
  if (raw["tsconfig"] !== undefined)
    job.tsconfig = inside(String(raw["tsconfig"]), "tsconfig");
  if (raw["module"] !== undefined) job.module = inside(String(raw["module"]), "module");
  const sources = strings(raw["sources"], "sources");
  if (sources) job.sources = sources;
  if (raw["packages"] !== undefined) {
    const packages = raw["packages"];
    if (!Array.isArray(packages) || packages.some((entry) => typeof entry !== "string")) {
      throw new MigrateError("packages must be a list of package patterns");
    }
    job.packages = packages as string[];
  }
  checkSdk(job);
  return job;
}

function checkSdk(job: MigrationJob): void {
  if (!isObject(job.sdk)) throw new MigrateError("sdk must be an SDK map");
  const sdk = job.sdk as Record<string, unknown>;
  if (!isObject(sdk["upgradeTo"])) throw new MigrateError("the SDK map has no upgradeTo");
  const upgradeTo = sdk["upgradeTo"];
  if (job.language === "go") {
    if (!isObject(sdk["module"]) || typeof sdk["module"]["path"] !== "string") {
      throw new MigrateError("a Go SDK map names its module: { module: { path } }");
    }
    goModulePath(sdk["module"]["path"], "the SDK map's module");
    goModulePath(upgradeTo["path"], "the SDK map's upgradeTo.path");
    version(upgradeTo["version"], "the SDK map's upgradeTo.version");
    return;
  }
  packageName(sdk["package"], "the SDK map's package");
  packageName(upgradeTo["package"], "the SDK map's upgradeTo.package");
  version(upgradeTo["version"], "the SDK map's upgradeTo.version");
}

function goModulePath(path: unknown, what: string): string {
  if (typeof path !== "string" || !/^[a-z0-9.-]+(\/[\w.~-]+)+$/i.test(path)) {
    throw new MigrateError(`${what} is not a Go module path: ${String(path)}`);
  }
  return path;
}

/** What a job's fetch downloads. For Go this reads the module's go.mod and go.sum. */
export async function fetchPlanOf(job: MigrationJob): Promise<FetchPlan> {
  if (job.language === "go") {
    const sdk = job.sdk as GoSdkMap;
    const moduleDir = join(job.repo, job.module ?? ".");
    const read = (name: string) =>
      readFile(join(moduleDir, name), "utf8").catch(() => "");
    const mod = await read("go.mod");
    if (!mod) throw new MigrateError(`there is no go.mod in ${moduleDir}`);
    return {
      npm: [],
      pypi: [],
      go: {
        mod,
        sum: await read("go.sum"),
        releases: [
          { path: sdk.module.path, version: job.from },
          { path: sdk.upgradeTo.path, version: sdk.upgradeTo.version },
        ],
      },
    };
  }
  const sdk = job.sdk as SymbolMap;
  const releases = [
    { name: sdk.package, version: job.from },
    { name: sdk.upgradeTo.package, version: sdk.upgradeTo.version },
  ];
  return job.language === "typescript"
    ? { npm: releases, pypi: [] }
    : { npm: [], pypi: releases };
}

/** Loads a language pack, which the CLI does not depend on unless you migrate. */
async function pack<T>(name: string): Promise<T> {
  try {
    return (await import(name)) as T;
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_MODULE_NOT_FOUND") {
      throw new MigrateError(
        `migrating this language needs ${name}; install it beside @invariant-app/cli`,
      );
    }
    throw error;
  }
}

type GoPack = typeof import("@invariant-app/migrate-go");
type PyPack = typeof import("@invariant-app/migrate-py");
type TsPack = typeof import("@invariant-app/migrate-ts");

const npmKey = (name: string, version: string) => `${name}@${version}`;
const npmDir = (name: string, version: string) =>
  `npm/${name.replaceAll("/", "+")}@${version}`;

/**
 * The fetch step: downloads what `plan` lists into `into`, and records where
 * each release landed in `into/fetched.json`. It runs no install script, no
 * build, and nothing it downloaded.
 */
export async function fetchPackages(plan: FetchPlan, into: string): Promise<Fetched> {
  const fetched: Fetched = { npm: {}, pypi: {}, skipped: [] };
  for (const release of plan.npm) {
    const dir = npmDir(release.name, release.version);
    await mkdir(join(into, dir), { recursive: true });
    const installed = await exec(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-save",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        "--omit=dev",
        "--prefix",
        join(into, dir),
        `${release.name}@${release.version}`,
      ],
      { env: { ...process.env, npm_config_ignore_scripts: "true" } },
    );
    if (installed.code !== 0) {
      throw new MigrateError(
        `could not fetch ${release.name}@${release.version} from npm: ${installed.stderr.trim().split("\n").slice(-3).join(" ")}`,
      );
    }
    fetched.npm[npmKey(release.name, release.version)] = dir;
  }
  if (plan.pypi.length > 0) {
    const python = await pack<PyPack>("@invariant-app/migrate-py");
    for (const release of plan.pypi) {
      const installed = await python.installWithDependencies(
        release.name,
        release.version,
        join(into, "pypi"),
      );
      fetched.pypi[npmKey(release.name, release.version)] = installed.sites.map((site) =>
        relative(into, site),
      );
      fetched.skipped.push(
        ...installed.skipped.map((name) => `${release.name}: ${name}`),
      );
    }
  }
  if (plan.go) await fetchGo(plan.go, into, fetched);
  await writeFile(join(into, "fetched.json"), `${JSON.stringify(fetched, null, 2)}\n`);
  return fetched;
}

/**
 * Go's modules: everything the consumer's module graph names, the same with
 * the SDK moved to its new release, each SDK release's own graph (its
 * surface is read as a module of its own), and the helper's. Each is read
 * from a go.mod copied into scratch space, so the go command has only
 * go.mod files to go on and no package of anyone's to build.
 */
async function fetchGo(
  plan: NonNullable<FetchPlan["go"]>,
  into: string,
  fetched: Fetched,
): Promise<void> {
  const go = await pack<GoPack>("@invariant-app/migrate-go");
  const modCache = join(into, "go", "mod");
  const scratch = await mkdtemp(join(tmpdir(), "invariant-go-fetch-"));
  const options = { modCache, buildCache: join(scratch, "build") };
  try {
    const graph = async (name: string, mod: string, sum: string) => {
      const dir = join(scratch, name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "go.mod"), mod);
      await writeFile(join(dir, "go.sum"), sum);
      await go.goCommand(["mod", "download", "all"], dir, options);
      return dir;
    };
    const consumer = await graph("consumer", plan.mod, plan.sum);
    const upgrade = plan.releases.at(-1);
    if (upgrade) {
      await go.goCommand(
        ["get", `${upgrade.path}@${upgrade.version}`],
        consumer,
        options,
      );
      await go.goCommand(["mod", "download", "all"], consumer, options);
    }
    for (const [index, release] of plan.releases.entries()) {
      const dir = await go.downloadModule(
        release.path,
        release.version,
        options,
        scratch,
      );
      const mod = await readFile(join(dir, "go.mod"), "utf8").catch(() => "");
      if (mod) {
        await graph(
          `release-${index}`,
          mod,
          await readFile(join(dir, "go.sum"), "utf8").catch(() => ""),
        );
      }
    }
    const helper = helperModule();
    if (helper) {
      await graph(
        "helper",
        await readFile(join(helper, "go.mod"), "utf8"),
        await readFile(join(helper, "go.sum"), "utf8"),
      );
    }
    fetched.go = { modCache: relative(into, modCache) };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** The Go helper's module, where the migrate-go pack keeps its source. */
function helperModule(): string | undefined {
  try {
    const entry = fileURLToPath(import.meta.resolve("@invariant-app/migrate-go"));
    for (const candidate of ["helper", "../../../engines/go/migrate"]) {
      const dir = resolve(dirname(entry), candidate);
      if (existsSync(join(dir, "go.mod"))) return dir;
    }
  } catch {
    // Not installed; a Go job has already failed to load the pack by now.
  }
  return undefined;
}

/**
 * The repository's own files copied to `to`: not its installed packages or
 * its history, and not its links, which could point anywhere on the
 * machine the copy is made on.
 */
async function copySource(from: string, to: string): Promise<void> {
  await cp(from, to, {
    recursive: true,
    filter: async (path) => {
      if (path === from) return true;
      const name = basename(path);
      if (name === "node_modules" || name === ".git") return false;
      return !(await lstat(path)).isSymbolicLink();
    },
  });
}

/** Files under `root` with one of `extensions`, skipping what is never the consumer's own. */
async function filesUnder(
  root: string,
  extensions: readonly string[],
): Promise<string[]> {
  const skipped = new Set([
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "env",
    "__pycache__",
    "site-packages",
    ".tox",
    "vendor",
    "testdata",
  ]);
  const found: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 20 || found.length >= 20_000) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipped.has(entry.name)) await walk(path, depth + 1);
      } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
        found.push(path);
      }
    }
  };
  await walk(root, 0);
  return found.sort();
}

/**
 * The analysis step: the migration itself, over the releases the fetch left
 * in `packages`. It needs no network, and asks for none: the Go command is
 * told the module proxy is off.
 */
export async function analyse(
  job: MigrationJob,
  packages: string,
): Promise<MigrationOutcome> {
  const fetched = JSON.parse(
    await readFile(join(packages, "fetched.json"), "utf8"),
  ) as Fetched;
  const repo = realpathSync(job.repo);
  const notes = fetched.skipped.map((entry) => `not fetched: ${entry}`);
  const outcome = (
    result: {
      files: Map<string, string>;
      manual: ManualSite[];
      edits: unknown[];
      diagnosticsBefore: unknown[];
      diagnosticsAfter: unknown[];
    },
    more: string[] = [],
    /** Where the migration read the repository, when not in place. */
    root = repo,
  ): MigrationOutcome => {
    const at = (file: string) => relative(root, file).replaceAll(sep, "/");
    const said = (list: unknown[]) =>
      list.map((entry) => String(entry).replaceAll(`${root}/`, ""));
    const before = new Set(said(result.diagnosticsBefore));
    return {
      language: job.language,
      files: Object.fromEntries(
        [...result.files].map(([file, text]) => [at(file), text]),
      ),
      manual: result.manual.map((site) => ({
        file: at(site.file),
        line: site.line,
        changeId: site.changeId,
        reason: site.reason,
      })),
      edits: result.edits.length,
      diagnostics: {
        before: result.diagnosticsBefore.length,
        after: result.diagnosticsAfter.length,
      },
      notes: [
        ...notes,
        ...more,
        ...said(result.diagnosticsAfter)
          .filter((entry) => !before.has(entry))
          .slice(0, 20)
          .map((entry) => `new type error: ${entry}`),
      ],
    };
  };

  if (job.language === "typescript") {
    const ts = await pack<TsPack>("@invariant-app/migrate-ts");
    const sdk = job.sdk as SymbolMap;
    const prefix = (name: string, at: string) => {
      const dir = fetched.npm[npmKey(name, at)];
      if (!dir) throw new MigrateError(`${name}@${at} was not fetched`);
      return join(packages, dir);
    };
    const current = prefix(sdk.package, job.from);
    const upgraded = prefix(sdk.upgradeTo.package, sdk.upgradeTo.version);
    const installed = realpathSync(join(current, "node_modules", sdk.package));
    // The consumer's imports resolve through node_modules, which the
    // repository does not have and may not be given. So the migration reads
    // a copy of its source in scratch space, with the release it uses today
    // linked in where an install would put it; the repository itself stays
    // read-only, and every path is mapped back to it.
    const scratch = await mkdtemp(join(tmpdir(), "invariant-ts-"));
    try {
      const view = join(scratch, "repo");
      await copySource(repo, view);
      await mkdir(dirname(join(view, "node_modules", sdk.package)), { recursive: true });
      await symlink(installed, join(view, "node_modules", sdk.package), "dir");
      const tsconfig = join(view, job.tsconfig ?? "tsconfig.json");
      const project =
        job.sources || !existsSync(tsconfig)
          ? {
              sources: job.sources
                ? job.sources.map((file) => join(view, file))
                : await filesUnder(view, [".ts", ".tsx", ".mts", ".cts"]),
            }
          : { tsConfigFilePath: tsconfig };
      const result = await ts.migrate({
        repoDir: view,
        // Both where the release is and where the copy reaches it: which of
        // the two a file is known by depends on whether the compiler host
        // follows the link.
        generated: [installed, join(view, "node_modules", sdk.package)],
        ...project,
        plan: buildPlan(job.changes, sdk),
        current: { package: sdk.package, from: current },
        upgraded: { package: sdk.upgradeTo.package, from: upgraded },
      });
      return outcome(
        result,
        result.unchecked.map((file) => `not checked in time: ${relative(view, file)}`),
        view,
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  if (job.language === "python") {
    const python = await pack<PyPack>("@invariant-app/migrate-py");
    const sdk = job.sdk as SymbolMap;
    const sites = (name: string, at: string) => {
      const found = fetched.pypi[npmKey(name, at)];
      if (!found) throw new MigrateError(`${name} ${at} was not fetched`);
      return found.map((site) => join(packages, site));
    };
    const module = sdk.package.toLowerCase().replaceAll("-", "_");
    const imports = new RegExp(`^\\s*(from|import)\\s+${module}\\b`, "m");
    const sources = job.sources
      ? job.sources.map((file) => join(repo, file))
      : (
          await Promise.all(
            (
              await filesUnder(repo, [".py"])
            ).map(async (file) =>
              imports.test(await readFile(file, "utf8")) ? [file] : [],
            ),
          )
        ).flat();
    const result = await python.migrate({
      repoDir: repo,
      sources,
      packages: sites(sdk.package, job.from),
      upgraded: sites(sdk.upgradeTo.package, sdk.upgradeTo.version),
      plan: buildPlan(job.changes, sdk),
    });
    return outcome(result);
  }

  const go = await pack<GoPack>("@invariant-app/migrate-go");
  if (!fetched.go) throw new MigrateError("the fetch left no Go modules");
  const sdk = job.sdk as GoSdkMap;
  const scratch = await mkdtemp(join(tmpdir(), "invariant-go-"));
  try {
    // The helper is built into the pack's usual cache, once per version of
    // its source; in a sandbox that cache is scratch space, so an image that
    // ships the helper prebuilt says so with INVARIANT_GO_HELPER.
    const options = {
      modCache: join(packages, fetched.go.modCache),
      buildCache: join(scratch, "build"),
      proxy: "off",
    };
    const moduleDir = join(repo, job.module ?? ".");
    // The SDK's packages the consumer imports: the surface worth reading.
    const imported = new RegExp(
      `"${sdk.module.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/[^"]*)?"`,
      "g",
    );
    const sdkPackages = new Set<string>();
    for (const file of await filesUnder(moduleDir, [".go"])) {
      for (const match of (await readFile(file, "utf8")).matchAll(imported)) {
        sdkPackages.add((match[1] ?? "").replace(/^\//, ""));
      }
    }
    const listed = [...sdkPackages].sort();
    const before = await go.readSurface(
      sdk.module.path,
      job.from,
      listed,
      options,
      scratch,
    );
    const after = await go.readSurface(
      sdk.upgradeTo.path,
      sdk.upgradeTo.version,
      listed,
      options,
      scratch,
    );
    const plan = go.buildGoPlan(
      job.changes,
      {
        ...(sdk as unknown as Parameters<GoPack["buildGoPlan"]>[1]),
        module: { path: sdk.module.path, version: job.from },
      },
      { before, after },
    );
    const result = await go.migrate({
      repoDir: repo,
      moduleDir,
      packages: job.packages ?? ["./..."],
      plan,
      go: options,
    });
    const files = new Map(result.files);
    if (result.goMod) {
      files.set(join(moduleDir, "go.mod"), result.goMod.mod);
      files.set(join(moduleDir, "go.sum"), result.goMod.sum);
    }
    const said = (list: typeof result.diagnosticsBefore) =>
      list.map(
        (diagnostic) => `${diagnostic.file}:${diagnostic.line} ${diagnostic.message}`,
      );
    return outcome(
      {
        ...result,
        files,
        diagnosticsBefore: said(result.diagnosticsBefore),
        diagnosticsAfter: said(result.diagnosticsAfter),
      },
      [
        ...result.errors.map((error) => `go: ${error}`),
        ...(result.unverified
          ? [`not checked against the new release: ${result.unverified}`]
          : []),
      ],
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** The most a sandbox may hand back, in bytes of file contents. */
const MOST_RETURNED = 64 * 1024 * 1024;

/**
 * An outcome as read back from a sandbox, checked field by field. It was
 * written by a process that read a stranger's repository, so it is believed
 * only as far as it holds together: every path relative and inside the
 * repository, every field the type it claims.
 */
export function checkOutcome(value: unknown, language: Language): MigrationOutcome {
  if (!isObject(value) || value["language"] !== language) {
    throw new MigrateError("the sandbox's result is not an outcome of this job");
  }
  const files: Record<string, string> = {};
  let size = 0;
  if (!isObject(value["files"]))
    throw new MigrateError("the sandbox's result has no files");
  for (const [file, text] of Object.entries(value["files"])) {
    if (typeof text !== "string")
      throw new MigrateError(`the sandbox returned ${file} as not text`);
    size += Buffer.byteLength(text);
    if (size > MOST_RETURNED)
      throw new MigrateError("the sandbox returned more than 64 MiB");
    const path = inside(file, "a file the sandbox returned");
    if (path === ".git" || path.startsWith(".git/")) {
      throw new MigrateError(`the sandbox returned a file inside .git: ${file}`);
    }
    files[path] = text;
  }
  const manual = Array.isArray(value["manual"]) ? value["manual"] : [];
  const diagnostics = isObject(value["diagnostics"]) ? value["diagnostics"] : {};
  return {
    language,
    files,
    manual: manual.filter(isObject).map((site) => ({
      file: inside(String(site["file"]), "a site the sandbox returned"),
      line: Number(site["line"]) || 0,
      changeId: String(site["changeId"] ?? ""),
      reason: String(site["reason"] ?? ""),
    })),
    edits: Number(value["edits"]) || 0,
    diagnostics: {
      before: Number(diagnostics["before"]) || 0,
      after: Number(diagnostics["after"]) || 0,
    },
    notes: Array.isArray(value["notes"]) ? value["notes"].map(String) : [],
  };
}

/**
 * Writes an outcome's files into the repository. Each one's directory has
 * to be inside the repository once links are followed, and a file that is
 * itself a link is not written through.
 */
export async function writeOutcome(
  repo: string,
  outcome: MigrationOutcome,
): Promise<string[]> {
  const root = await realpath(repo);
  const written: string[] = [];
  for (const [file, text] of Object.entries(outcome.files)) {
    const target = join(root, inside(file, "a file to write"));
    const parent = await realpath(dirname(target)).catch(() => undefined);
    if (!parent || (parent !== root && !parent.startsWith(`${root}${sep}`))) {
      throw new MigrateError(`${file} is not inside the repository`);
    }
    const existing = await lstat(target).catch(() => undefined);
    if (existing?.isSymbolicLink())
      throw new MigrateError(`${file} is a link; not written`);
    await writeFile(join(parent, basename(target)), text, "utf8");
    written.push(file);
  }
  return written;
}

/** Runs both steps here, in this process: what `invariant migrate` does by default. */
export async function migrateInProcess(job: MigrationJob): Promise<MigrationOutcome> {
  const packages = await mkdtemp(join(tmpdir(), "invariant-migrate-"));
  try {
    await fetchPackages(await fetchPlanOf(job), packages);
    return checkOutcome(
      JSON.parse(JSON.stringify(await analyse(job, packages))),
      job.language,
    );
  } finally {
    await removeFetched(packages);
  }
}

/** Removes what a fetch left; Go keeps its module cache read-only, so it is asked first. */
async function removeFetched(dir: string): Promise<void> {
  const modCache = join(dir, "go", "mod");
  if (existsSync(modCache)) {
    await exec("go", ["clean", "-modcache"], {
      env: { ...process.env, GOMODCACHE: modCache, GOFLAGS: "" },
    }).catch(() => undefined);
  }
  await rm(dir, { recursive: true, force: true });
}

/**
 * The installation this CLI runs from, as a directory to mount and the
 * entry to start inside it: the `node_modules` it was installed into, or,
 * in this repository, the workspace.
 */
export function engineMount(): { dir: string; entry: string } {
  const here = realpathSync(dirname(fileURLToPath(import.meta.url)));
  const main = ["main.js", "main.ts"].find((name) => existsSync(join(here, name)));
  if (!main) throw new MigrateError(`the CLI's entry is not beside ${here}`);
  const parts = here.split(sep);
  const top = parts.indexOf("node_modules");
  let dir: string;
  if (top > 0) {
    dir = parts.slice(0, top + 1).join(sep);
  } else {
    dir = here;
    while (!existsSync(join(dir, "pnpm-workspace.yaml")) && dirname(dir) !== dir) {
      dir = dirname(dir);
    }
    if (!existsSync(join(dir, "pnpm-workspace.yaml"))) dir = dirname(here);
  }
  return { dir, entry: relative(dir, join(here, main)).split(sep).join("/") };
}

export interface SandboxedOptions {
  image?: string;
  runtime?: OciRuntime;
  /** Hosts the fetch may reach beyond the public registries. */
  allow?: readonly string[];
  /** Told what each phase prints, as it prints it. */
  onOutput?: (chunk: Buffer) => void;
}

/**
 * Runs both steps in containers, each as `invariant migrate --phase` from
 * this same installation, and reads back what the analysis found.
 */
export async function migrateSandboxed(
  job: MigrationJob,
  options: SandboxedOptions = {},
): Promise<{ outcome: MigrationOutcome; phases: PhaseResult[] }> {
  const work = await mkdtemp(join(tmpdir(), "invariant-sandbox-"));
  const workspace: LocalWorkspace = {
    request: join(work, "request"),
    packages: join(work, "packages"),
    out: join(work, "out"),
    repo: job.repo,
  };
  try {
    for (const dir of [workspace.request, workspace.packages, workspace.out]) {
      await mkdir(dir as string, { recursive: true });
    }
    const request: SandboxRequest = {
      job: { ...job, repo: WORKSPACE.repo },
      fetch: await fetchPlanOf(job),
    };
    await writeFile(join(work, "request", "job.json"), JSON.stringify(request));
    const engine = engineMount();
    workspace.engine = engine.dir;
    const sandbox = ociSandbox({
      image: options.image ?? NODE_IMAGE,
      ...(options.runtime ? { runtime: options.runtime } : {}),
      ...(options.onOutput ? { onOutput: options.onOutput } : {}),
    });
    const command = (phase: "fetch" | "analyse") => [
      "node",
      `${ENGINE}/${engine.entry}`,
      "migrate",
      "--phase",
      phase,
      `${WORKSPACE.request}/job.json`,
    ];
    const fetched = await sandbox.fetch({
      workspace,
      command: command("fetch"),
      ...(options.allow ? { allow: options.allow } : {}),
    });
    const analysed = await sandbox.analyse({ workspace, command: command("analyse") });
    const outcome = checkOutcome(
      JSON.parse(await readFile(join(work, "out", "outcome.json"), "utf8")),
      job.language,
    );
    return { outcome, phases: [fetched, analysed] };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** What a sandboxed migration's phases are handed, at `request/job.json`. */
export interface SandboxRequest {
  job: MigrationJob;
  fetch: FetchPlan;
}

/**
 * `migrate --phase <fetch|analyse> <request>`: one step, inside a sandbox,
 * over the workspace's fixed layout.
 */
export async function runPhase(phase: string, requestPath: string): Promise<void> {
  const request = JSON.parse(await readFile(requestPath, "utf8")) as SandboxRequest;
  if (phase === "fetch") {
    await fetchPackages(request.fetch, WORKSPACE.packages);
    return;
  }
  if (phase === "analyse") {
    const outcome = await analyse(request.job, WORKSPACE.packages);
    await writeFile(join(WORKSPACE.out, "outcome.json"), JSON.stringify(outcome));
    return;
  }
  throw new MigrateError(`there is no phase called ${phase}`);
}

export function renderOutcome(
  job: MigrationJob,
  outcome: MigrationOutcome,
  how: { sandbox?: string; phases?: PhaseResult[]; written?: string[] },
): string {
  const [from, to] =
    job.language === "go"
      ? [(job.sdk as GoSdkMap).module.path, (job.sdk as GoSdkMap).upgradeTo.path]
      : [(job.sdk as SymbolMap).package, (job.sdk as SymbolMap).upgradeTo.package];
  const files = Object.keys(outcome.files).sort();
  const lines = [
    `${job.repo} (${job.language}): ${from} ${job.from} -> ${to} ${job.sdk.upgradeTo.version}`,
    `  ${outcome.edits} edit${outcome.edits === 1 ? "" : "s"} in ${files.length} file${files.length === 1 ? "" : "s"}${files.length ? `: ${files.join(", ")}` : ""}`,
    `  type errors: ${outcome.diagnostics.before} before, ${outcome.diagnostics.after} after, against each release`,
  ];
  if (outcome.manual.length > 0) {
    lines.push(`  ${outcome.manual.length} left to a person:`);
    for (const site of outcome.manual) {
      lines.push(`    ${site.file}:${site.line}  ${site.reason.split("\n")[0]}`);
    }
  }
  for (const note of outcome.notes) lines.push(`  note: ${note}`);
  if (how.sandbox) {
    const timing = (how.phases ?? [])
      .map((phase) => `${phase.phase} ${(phase.durationMs / 1000).toFixed(1)}s`)
      .join(", ");
    lines.push(`  ran in: ${how.sandbox}${timing ? ` (${timing})` : ""}`);
    const refused = (how.phases ?? []).flatMap((phase) =>
      (phase.egress ?? []).filter((decision) => !decision.allowed),
    );
    for (const decision of refused) {
      lines.push(
        `  refused egress: ${decision.host}:${decision.port} (${decision.reason})`,
      );
    }
  } else {
    lines.push("  ran in: this process, with no sandbox");
  }
  lines.push(
    how.written
      ? `  written: ${how.written.length} file${how.written.length === 1 ? "" : "s"}`
      : "  written: nothing; pass --write to apply the edits",
  );
  return `${lines.join("\n")}\n`;
}
