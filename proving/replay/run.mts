/**
 * Rig E, the replay: the migration engine run where humans already migrated,
 * and scored against what they did.
 *
 * Each case is a pull request that bumped an SDK and carried the humans'
 * fixes. The repository is fetched at the bump's base without its history or
 * any blob it does not need, the SDK is installed at the version the base
 * used with every install script off, and the engine reads the consumer's
 * source against it, exactly as it would on a pull request of its own. Then
 * the humans' result and the engine's are both read as regions changed from
 * the base, and laid over each other (`score.mts`).
 *
 * Nothing from the repository is executed: not its scripts, not its tests,
 * not its build. Its files are read as text and type-checked. Only the SDK
 * is installed, from the registry, with scripts disabled.
 *
 * What the engine is told comes from the SDK alone, the way `invariant sdk
 * stamp` records it: where the SDK's options name the API version, and which
 * version the upgraded release speaks. A package with nothing recorded is
 * replayed with no plan. Either way the consumer is checked against both
 * releases, TypeScript and JavaScript alike, and every place it stops
 * type-checking across the upgrade is reported; what that does not reach
 * counts as missed rather than being left out of the denominator.
 *
 * Usage:
 *   node --env-file-if-exists=.env --import tsx proving/replay/run.mts [--package stripe]
 *     [--ecosystem npm|pypi|go] [--case owner/repo#1] [--limit 10] [--keep] [--classify]
 *     [--recheck] [--settle] [--again] [--shard 0/4] [--results shard-0.json] [--verbose]
 *     [--minutes 200]
 *   node --import tsx proving/replay/run.mts --merge shard-*.json
 *   node --env-file-if-exists=.env --import tsx proving/replay/run.mts --rescore
 *     [--ecosystem pypi] [--classify] [--recheck] [--settle]
 *
 * Cases already in the results are skipped, so a run resumes where the last
 * one stopped; `--again` replays them too.
 *
 * `--classify` asks Jev which sites follow from a contract change
 * (`classify.mts`), for sites not already classed.
 *
 * A CI run replays with no key, in shards, each to its own results file;
 * `--merge` lays them over the recorded results. The sites it cached, with
 * how the engine did on each, are then classed and scored again here with
 * `--rescore`, which replays nothing.
 *
 * PyPI cases go through the Python pack (`@invariant-app/migrate-py`): the
 * SDK's wheels are unpacked, never built, and pyright reads the files that
 * import it against the old release and checks them against the new one.
 *
 * Go cases go through the Go pack (`@invariant-app/migrate-go`, `go.mts`):
 * modules come through the proxy, dependencies are compiled for their types
 * and nothing is run, and the consumer is read against the old release and
 * checked against the new one.
 *
 * `--recheck` with `--classify` also settles classes recorded before the
 * rules and the second question existed; `--settle` asks the third question
 * of each site the first two disagreed about (`classify.mts`); `--minutes`
 * stops starting cases in time for what was replayed to be kept.
 *
 * `--keep` leaves each case's checkout in place and prints what the engine
 * was told and did, for reading a miss; `--verbose` prints the same and keeps
 * nothing.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Change } from "@invariant-app/ir";
import type { ManualSite } from "@invariant-app/migrate-core";
import {
  installWithDependencies,
  migrate as migratePython,
} from "@invariant-app/migrate-py";
import { buildPlan, migrate, type SymbolMap } from "@invariant-app/migrate-ts";
import { ts } from "ts-morph";
import { ROOT } from "../corpus/manifest.mts";
import {
  type ClassRecord,
  cachedOutcomes,
  cacheSite,
  classify,
  readClasses,
  type Site,
  siteKey,
  writeClasses,
} from "./classify.mts";
import { replayGo } from "./go.mts";
import type { ReplayCase, ReplayIndex } from "./mine.mts";
import {
  importingPython,
  PYTHON_PINS,
  pinnedPython,
  releaseBefore,
  stripePythonVersion,
  topLevelModules,
} from "./python.mts";
import {
  changedRegions,
  type Outcome,
  type Region,
  type Score,
  score,
} from "./score.mts";
import { type Language, languageOf } from "./sites.mts";
import { type ContractPlan, stripePlan } from "./stripe.mts";

const run = promisify(execFile);
const CACHE = join(ROOT, ".cache/replay");
const RESULTS = join(ROOT, "proving/replay/results.json");
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
/** What counts as source in each ecosystem, for the humans' sites. */
const SOURCES: Record<ReplayCase["ecosystem"], RegExp> = {
  npm: SOURCE,
  pypi: /\.py$/,
  go: /\.go$/,
};
const SKIPPED_DIRS = /(^|\/)(node_modules|dist|build|out|coverage|\.next|vendor)\//;
/** The most source files restored for one case; the engine reads only those that import the SDK. */
const MAX_FILES = 20_000;

export interface ReplayResult extends Score {
  id: string;
  language: Language;
  package: string;
  /**
   * What the engine was told: the SDK's pin and the Changes between the two
   * contracts, the pin alone, or nothing recorded for this package.
   * `verify`: nothing about the contract, but both releases, so the engine
   * reported where the consumer stops type-checking across the upgrade.
   */
  engine: "contract" | "pin" | "verify" | "none";
  /** The releases replayed across, where they were found. */
  versions?: [string, string];
  /** Human sites: regions of source the humans changed. */
  sites: number;
  /**
   * The same, over only the sites that follow from a change to the API's
   * contract, as classed by `classify.mts`; the rest are the SDK's own
   * changes, or unrelated. Sites not yet classed are counted apart.
   */
  inScope?: ScopedScore;
  /**
   * Every site's outcome by its class, `unclassified` for a site not yet
   * classed: what the engine did for the SDK's own changes and for the sites
   * the classifier could not settle, which L8 does not count, beside the ones
   * it does.
   */
  byClass?: Record<string, Record<Outcome, number>>;
  /** Sites the engine could not reach for a reason outside it, such as a repository gone. */
  error?: string;
}

export interface ScopedScore {
  sites: number;
  identical: number;
  differs: number;
  flagged: number;
  missed: number;
  unclassified: number;
  /** Sites the two questions disagreed about, counted as neither. */
  contested?: number;
}

/** What an SDK records about itself, read from the installed package. */
interface SdkStamp {
  /** Options type and property naming the API version, as the declarations spell them. */
  pinType: string;
  pinProperty: string;
  /** The version the release speaks. */
  label: string;
}

/** How to read a stamp from an installed SDK, and where its contracts are. */
interface StampReader {
  (dir: string): SdkStamp | undefined;
  /** The Changes between two releases' contracts, and what the SDK calls each schema. */
  contract?: (
    from: string,
    to: string,
    sdk: string,
    namespaced: boolean,
  ) => Promise<ContractPlan>;
}

/** How to read a stamp from each SDK that has one. */
const STAMPS: Record<string, StampReader> = {
  stripe: Object.assign(
    (dir: string): SdkStamp | undefined => {
      const apiVersion = findFile(dir, /^apiVersion\.js$/);
      const label =
        apiVersion &&
        /ApiVersion = ['"]([^'"]+)['"]/.exec(readFileSync(apiVersion, "utf8"))?.[1];
      if (!label) return undefined;
      // Up to 21 the options sit in `namespace Stripe` inside `declare module
      // "stripe"`; from 22 they are a top-level export of the compiled source.
      const namespaced = existsSync(join(dir, "types/lib.d.ts"))
        ? /interface StripeConfig/.test(readFileSync(join(dir, "types/lib.d.ts"), "utf8"))
        : false;
      return {
        pinType: namespaced ? "Stripe.StripeConfig" : "StripeConfig",
        pinProperty: "apiVersion",
        label,
      };
    },
    { contract: stripePlan },
  ),
};

/** The exact version of an installed package. */
function versionOf(dir: string): string {
  return (
    JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string }
  ).version;
}

function findFile(dir: string, name: RegExp, depth = 0): string | undefined {
  if (depth > 3) return undefined;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && name.test(entry.name)) return path;
    if (entry.isDirectory() && entry.name !== "node_modules") {
      const found = findFile(path, name, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", repo, ...args], {
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}

/**
 * Fetches the blobs in a few requests. A blobless clone otherwise fetches each
 * one as it is first read, a request per file, which on a monorepo took most
 * of an hour for one case.
 */
async function prefetch(repo: string, blobs: readonly string[]): Promise<void> {
  const CHUNK = 2_000;
  for (let start = 0; start < blobs.length; start += CHUNK) {
    await new Promise<void>((done, fail) => {
      const child = spawn(
        "git",
        [
          "-C",
          repo,
          "-c",
          "fetch.negotiationAlgorithm=noop",
          "fetch",
          "-q",
          "origin",
          "--no-tags",
          "--no-write-fetch-head",
          "--recurse-submodules=no",
          "--filter=blob:none",
          "--stdin",
        ],
        {
          stdio: ["pipe", "ignore", "pipe"],
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", fail);
      child.on("close", (code) =>
        code === 0
          ? done()
          : fail(new Error(`fetching blobs: ${stderr.trim().split("\n")[0]}`)),
      );
      child.stdin.end(`${blobs.slice(start, start + CHUNK).join("\n")}\n`);
    });
  }
}

/**
 * The files that import the SDK. Only there can its options be written, and a
 * constant they pass comes in through their own imports, which the engine
 * follows. Reading every file of a monorepo instead ran out of memory.
 */
export function importing(
  repo: string,
  paths: readonly string[],
  name: string,
): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const imports = new RegExp(
    `(?:from|import|require\\()\\s*['"]${escaped}(?:/[^'"]*)?['"]`,
  );
  return paths
    .map((path) => join(repo, path))
    .filter((path) => {
      try {
        return imports.test(readFileSync(path, "utf8"));
      } catch {
        return false;
      }
    });
}

/**
 * How a monorepo's imports of its own packages resolve, from its root
 * tsconfig: the `baseUrl` and `paths` that map `@decipad/backend-config` to
 * `libs/backend-config/src/index.ts`. Read as data with TypeScript's own
 * reader, which allows the comments tsconfig files have; nothing it extends is
 * followed, since that may be a package nobody installed.
 */
export async function pathsOf(
  repo: string,
  commit: string,
): Promise<{ baseUrl: string; paths: Record<string, string[]> } | undefined> {
  for (const name of ["tsconfig.base.json", "tsconfig.json"]) {
    const text = await textAt(repo, commit, name);
    if (!text) continue;
    const { config } = ts.parseConfigFileTextToJson(name, text) as {
      config?: {
        compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
      };
    };
    const options = config?.compilerOptions;
    if (!options?.paths) continue;
    return { baseUrl: join(repo, options.baseUrl ?? "."), paths: options.paths };
  }
  return undefined;
}

/** A file's text at a commit, or none where the commit does not have it. */
async function textAt(repo: string, commit: string, file: string): Promise<string> {
  try {
    return await git(repo, "show", `${commit}:${file}`);
  } catch {
    return "";
  }
}

/** Each path at a commit, to its blob id, which the tree gives before any blob is fetched. */
async function treeAt(repo: string, commit: string): Promise<Map<string, string>> {
  const blobs = new Map<string, string>();
  for (const line of (await git(repo, "ls-tree", "-r", commit)).split("\n")) {
    const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
    if (match) blobs.set(match[2] as string, match[1] as string);
  }
  return blobs;
}

/** Restores paths from a commit into the working tree, their blobs fetched together first. */
async function restoreAt(
  repo: string,
  work: string,
  commit: string,
  blobs: ReadonlyMap<string, string>,
  paths: readonly string[],
): Promise<void> {
  const present = paths.filter((path) => blobs.has(path));
  if (present.length === 0) return;
  await writeFile(join(work, "paths"), present.join("\n"));
  await prefetch(
    repo,
    present.map((path) => blobs.get(path) as string),
  );
  await git(
    repo,
    "restore",
    `--source=${commit}`,
    "--worktree",
    `--pathspec-from-file=${join(work, "paths")}`,
  );
}

/**
 * The SDK installed at `spec`, once per version, scripts off: the package, and
 * the prefix it and its dependencies resolve from.
 */
async function installed(
  name: string,
  spec: string,
): Promise<{ sdk: string; prefix: string }> {
  const dir = join(CACHE, "npm", `${name.replaceAll("/", "+")}@${spec}`);
  const sdk = join(dir, "node_modules", name);
  if (!existsSync(join(sdk, "package.json"))) {
    await mkdir(dir, { recursive: true });
    await run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-save",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        "--prefix",
        dir,
        `${name}@${spec}`,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
  }
  return { sdk: realpathSync(sdk), prefix: dir };
}

/** The version range the base's nearest manifest asks for, when the bump did not say. */
function requested(manifest: string, name: string): string | undefined {
  try {
    const parsed = JSON.parse(manifest) as Record<
      string,
      Record<string, string> | undefined
    >;
    return parsed["dependencies"]?.[name] ?? parsed["devDependencies"]?.[name];
  } catch {
    return undefined;
  }
}

/**
 * The exact version of `name` a commit's lockfile installed, near `root`.
 *
 * A bump's title can name only a major version, as Renovate's "to v20" does,
 * and the newest release of that major may speak a later API version than the
 * one the humans actually moved to. The lockfile says which release it was.
 * Where one lists several, the one whose major the manifest asks for wins.
 */
export function lockedVersion(
  lockfiles: readonly { path: string; text: string }[],
  name: string,
  wanted?: string,
): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const found: string[] = [];
  for (const { path, text } of lockfiles) {
    if (path.endsWith("package-lock.json") || path.endsWith("npm-shrinkwrap.json")) {
      try {
        const lock = JSON.parse(text) as {
          packages?: Record<string, { version?: string }>;
          dependencies?: Record<string, { version?: string }>;
        };
        for (const [key, entry] of Object.entries(lock.packages ?? {})) {
          if (key.endsWith(`node_modules/${name}`) && entry.version)
            found.push(entry.version);
        }
        const legacy = lock.dependencies?.[name]?.version;
        if (legacy) found.push(legacy);
      } catch {
        // A lockfile that does not parse says nothing.
      }
    } else if (path.endsWith("pnpm-lock.yaml")) {
      const pattern = new RegExp(
        `\\n\\s+['"]?/?${escaped}[@/](\\d+\\.\\d+\\.\\d+[^:'"(\\s]*)`,
        "g",
      );
      for (const match of text.matchAll(pattern)) found.push(match[1] as string);
    } else if (path.endsWith("bun.lock")) {
      // `"stripe": ["stripe@20.0.0", "", { ... }, "sha512-..."]`
      const pattern = new RegExp(`"${escaped}": \\[\\s*"${escaped}@(\\d[^"]*)"`, "g");
      for (const match of text.matchAll(pattern)) found.push(match[1] as string);
    } else if (path.endsWith("yarn.lock")) {
      const pattern = new RegExp(
        `(?:^|\\n)"?${escaped}@[^\\n]*:\\n\\s+version:? "?(\\d[^"\\n]*)`,
        "g",
      );
      for (const match of text.matchAll(pattern)) found.push(match[1] as string);
    }
  }
  const major = wanted && /(\d+)/.exec(wanted)?.[1];
  return found.find((version) => major && version.split(".")[0] === major) ?? found[0];
}

const LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];

/** The lockfiles at `root` and at the repository root, as a commit has them. */
async function lockfilesAt(
  repo: string,
  commit: string,
  root: string,
): Promise<{ path: string; text: string }[]> {
  const dirs = root === "." ? ["."] : [root, "."];
  const found: { path: string; text: string }[] = [];
  for (const dir of dirs) {
    for (const name of LOCKFILES) {
      const path = dir === "." ? name : `${dir}/${name}`;
      const text = await textAt(repo, commit, path);
      if (text) found.push({ path, text });
    }
  }
  return found;
}

/** The directory of each file's nearest manifest: the package whose code it is. */
function packageRoots(paths: readonly string[], files: readonly string[]): string[] {
  const manifests = new Set(
    paths
      .filter((path) => /(^|\/)package\.json$/.test(path))
      .map((path) => dirname(path)),
  );
  const roots = new Set<string>();
  for (const file of files) {
    let dir = dirname(file);
    while (dir !== "." && !manifests.has(dir)) dir = dirname(dir);
    roots.add(dir);
  }
  return [...roots];
}

interface ReplayOptions {
  keep: boolean;
  /** Print what the engine was told and did, without keeping the checkout. */
  verbose?: boolean;
  classes: Record<string, ClassRecord>;
  classifier?: { client: Parameters<typeof classify>[2]; model: string };
  /** Settle classes recorded before the rules and the second question existed. */
  recheck?: boolean;
  /** Ask the third question of sites the first two disagreed about. */
  settle?: boolean;
}

async function replay(entry: ReplayCase, options: ReplayOptions): Promise<ReplayResult> {
  const keep = options.keep;
  const language = languageOf(entry);
  const base: Omit<ReplayResult, keyof Score | "sites"> = {
    id: entry.id,
    language,
    package: entry.package,
    engine:
      entry.ecosystem === "pypi"
        ? PYTHON_CONTRACTS[entry.package]
          ? "contract"
          : "verify"
        : entry.ecosystem === "go"
          ? "verify"
          : entry.ecosystem !== "npm"
            ? "none"
            : STAMPS[entry.package]?.contract
              ? "contract"
              : STAMPS[entry.package]
                ? "pin"
                : "verify",
  };
  const work = join(CACHE, "work", entry.id.replace(/[^\w.-]+/g, "_"));
  const repo = join(work, "repo");
  await rm(work, { recursive: true, force: true });
  await mkdir(repo, { recursive: true });
  try {
    await git(repo, "init", "-q");
    await git(repo, "remote", "add", "origin", `https://github.com/${entry.repo}.git`);
    await git(
      repo,
      "fetch",
      "-q",
      "--depth",
      "1",
      "--filter=blob:none",
      "origin",
      entry.base,
    );
    try {
      await git(
        repo,
        "fetch",
        "-q",
        "--depth",
        "1",
        "--filter=blob:none",
        "origin",
        entry.head,
      );
    } catch {
      // A squash merge can leave the head reachable only from the pull request.
      await git(
        repo,
        "fetch",
        "-q",
        "--depth",
        "1",
        "--filter=blob:none",
        "origin",
        `+refs/pull/${entry.pr}/head:refs/replay/head`,
      );
    }

    const files = entry.files.filter((file) => SOURCES[entry.ecosystem].test(file));
    const before = new Map<string, string>();
    const human = new Map<string, Region[]>();
    for (const file of files) {
      const text = await textAt(repo, entry.base, file);
      before.set(file, text);
      human.set(
        file,
        changedRegions(
          text.split("\n"),
          (await textAt(repo, entry.head, file)).split("\n"),
        ),
      );
    }
    const sites = [...human.values()].reduce((sum, regions) => sum + regions.length, 0);

    // The TypeScript engine reads TypeScript and JavaScript, the Python pack
    // Python; elsewhere only the humans' sites are read and classed, which is
    // the denominator a pack is judged on.
    const stamp = entry.ecosystem === "npm" ? STAMPS[entry.package] : undefined;
    const engineText = new Map<string, string>();
    /** Base lines, per file, the engine reported to a person rather than edited. */
    const flagged = new Map<string, (readonly [number, number])[]>();
    if (entry.ecosystem === "pypi") {
      const python = await replayPython(
        entry,
        repo,
        work,
        before,
        keep || options.verbose === true,
      );
      for (const [file, ranges] of python.flagged) flagged.set(file, ranges);
      for (const [file, text] of python.files) engineText.set(file, text);
      base.versions = python.versions;
    }
    if (entry.ecosystem === "go") {
      const blobs = await treeAt(repo, entry.base);
      const go = await replayGo(
        entry,
        {
          repo,
          paths: [...blobs.keys()],
          restore: (paths) => restoreAt(repo, work, entry.base, blobs, paths),
          textAt: (commit, file) => textAt(repo, commit, file),
        },
        files,
        CACHE,
      );
      base.engine = go.engine;
      if (go.versions) base.versions = go.versions;
      if (keep || options.verbose) {
        process.stdout.write(`${JSON.stringify(go.notes, null, 2)}\n`);
      }
      for (const [file, ranges] of flaggedLines(go.manual, repo, before)) {
        flagged.set(file, ranges);
      }
      for (const [path, text] of go.files)
        engineText.set(path.slice(repo.length + 1), text);
    }
    if (entry.ecosystem === "npm") {
      // Each file's blob id comes with the tree, before any blob is fetched.
      const blobs = new Map<string, string>();
      for (const line of (await git(repo, "ls-tree", "-r", entry.base)).split("\n")) {
        const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
        if (match) blobs.set(match[2] as string, match[1] as string);
      }
      const paths = [...blobs.keys()];
      const roots = packageRoots(paths, files);
      // Every source file, so an import across a monorepo has something to
      // resolve to; only the ones that import the SDK, and what they import,
      // are read by the engine.
      const readable = paths
        .filter(
          (path) =>
            SOURCE.test(path) && !SKIPPED_DIRS.test(path) && !path.endsWith(".d.ts"),
        )
        .slice(0, MAX_FILES);
      const manifestOf = (root: string) =>
        root === "." ? "package.json" : `${root}/package.json`;
      await writeFile(
        join(work, "paths"),
        [...new Set([...readable, ...roots.map(manifestOf)])].join("\n"),
      );
      await prefetch(
        repo,
        [...readable, ...roots.map(manifestOf)].flatMap((path) => {
          const blob = blobs.get(path);
          return blob ? [blob] : [];
        }),
      );
      await git(
        repo,
        "restore",
        `--source=${entry.base}`,
        "--worktree",
        `--pathspec-from-file=${join(work, "paths")}`,
      ).catch(() =>
        // A listed manifest the commit does not have fails the whole restore.
        git(repo, "restore", `--source=${entry.base}`, "--worktree", "--", ...readable),
      );

      const root = roots[0] ?? ".";
      const range = requested(readManifest(repo, root), entry.package);
      const from =
        lockedVersion(
          await lockfilesAt(repo, entry.base, root),
          entry.package,
          entry.from || range,
        ) ||
        entry.from ||
        range;
      if (!from) throw new Error("the base does not say which version it used");
      const to =
        lockedVersion(
          await lockfilesAt(repo, entry.head, root),
          entry.package,
          entry.to,
        ) || entry.to;
      const oldRelease = await installed(entry.package, from);
      const newRelease = await installed(entry.package, to);
      const oldSdk = oldRelease.sdk;
      const newSdk = newRelease.sdk;
      // An SDK that records the API version it speaks is told the pin and,
      // where its contracts are known, the Changes; every other one is still
      // checked against both releases, and each place the upgrade breaks is
      // reported.
      // A release from before the SDK recorded its version (stripe-node
      // before 12) is checked against the other all the same.
      const old = stamp?.(oldSdk);
      const next = stamp?.(newSdk);
      if (!old || !next) base.engine = "verify";

      // A scoped package's link sits in its scope's directory.
      await mkdir(dirname(join(repo, "node_modules", entry.package)), {
        recursive: true,
      });
      await symlink(oldSdk, join(repo, "node_modules", entry.package), "dir");
      // What changed in the contract between the two releases, where the SDK
      // says which contracts they speak.
      const contract =
        stamp?.contract && old && next
          ? await stamp.contract(
              versionOf(oldSdk),
              versionOf(newSdk),
              oldSdk,
              old.pinType.includes("."),
            )
          : undefined;
      const symbols: SymbolMap = {
        package: entry.package,
        upgradeTo: {
          package: entry.package,
          version: entry.to,
          // The SDK keeps its type names across the upgrade.
          ...(contract ? { types: contract.types } : {}),
        },
        types: contract?.types ?? {},
        ...(contract ? { operations: contract.operations } : {}),
        accessors: [],
        ...(old && next
          ? { pin: { type: old.pinType, property: old.pinProperty, label: next.label } }
          : {}),
      };
      const resolution = await pathsOf(repo, entry.base);
      const sources = importing(repo, readable, entry.package);
      const result = await migrate({
        repoDir: `${repo}/`,
        generated: [oldSdk],
        sources,
        ...(resolution ? { resolution } : {}),
        plan: buildPlan(contract?.changes ?? [], symbols),
        current: { package: entry.package, from: oldRelease.prefix },
        upgraded: { package: entry.package, from: newRelease.prefix },
      });
      base.versions = [versionOf(oldSdk), versionOf(newSdk)];
      for (const [file, ranges] of flaggedLines(result.manual, repo, before)) {
        flagged.set(file, ranges);
      }
      if (keep || options.verbose) {
        process.stdout.write(
          `${JSON.stringify({ versions: [versionOf(oldSdk), versionOf(newSdk)], sources: sources.length, contract: contract && { drafted: contract.drafted, removed: contract.removed, types: Object.keys(contract.types).length, subscription: contract.changes.filter((change) => change.id.includes("subscription")).map((change) => change.id) }, pin: symbols.pin, read: readable.length, edits: result.edits.map((edit) => `${edit.file}:${edit.start} ${edit.reason}`), manual: result.manual.map((site) => `${site.file}:${site.line} ${site.reason}`) }, null, 2)}\n`,
        );
      }
      for (const [path, text] of result.files) {
        engineText.set(path.slice(repo.length + 1), text);
      }
    }

    const total: Score = {
      identical: 0,
      differs: 0,
      flagged: 0,
      missed: 0,
      extra: 0,
      extraFlags: 0,
    };
    const scored: { site: Site; outcome: Outcome }[] = [];
    const engineRegions = new Map<string, Region[]>();
    for (const file of new Set([...human.keys(), ...engineText.keys()])) {
      const text = before.get(file) ?? (await textAt(repo, entry.base, file));
      const lines = text.split("\n");
      const engine = engineText.has(file)
        ? changedRegions(lines, (engineText.get(file) as string).split("\n"))
        : [];
      engineRegions.set(file, engine);
      const regions = human.get(file) ?? [];
      const result = score(lines, regions, engine, flagged.get(file) ?? []);
      total.identical += result.identical;
      total.differs += result.differs;
      total.flagged += result.flagged;
      total.missed += result.missed;
      total.extra += result.extra;
      total.extraFlags = (total.extraFlags ?? 0) + (result.extraFlags ?? 0);
      regions.forEach((region, at) => {
        scored.push({
          site: {
            caseId: entry.id,
            package: entry.package,
            from: entry.from,
            to: entry.to,
            file,
            base: lines,
            region,
          },
          outcome: result.outcomes[at] as Outcome,
        });
      });
    }
    for (const { site, outcome } of scored) await cacheSite(site, undefined, outcome);
    if (options.classifier) {
      try {
        await classify(
          scored.map((each) => each.site),
          options.classes,
          options.classifier.client,
          options.classifier.model,
          { recheck: options.recheck ?? false, settle: options.settle ?? false },
        );
      } catch (error) {
        // The case is still scored; what could not be classed counts as
        // unclassified, and no later case asks again.
        process.stderr.write(
          `classification stopped: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}\n`,
        );
        delete options.classifier;
      }
    }
    if (keep || options.verbose) {
      // What the engine missed among the contract sites, to read beside the diff.
      for (const { site, outcome } of scored) {
        if (outcome !== "missed" || options.classes[siteKey(site)]?.class !== "contract")
          continue;
        const removed =
          site.base.slice(site.region.oldStart, site.region.oldEnd)[0] ?? "";
        const added = site.region.lines[0] ?? "";
        process.stdout.write(
          `missed ${site.file}:${site.region.oldStart + 1}\n  - ${removed.trim().slice(0, 110)}\n  + ${added.trim().slice(0, 110)}\n`,
        );
      }
    }
    if (keep || options.verbose) {
      // Every edit that differs from the humans', whatever its class, to
      // judge equivalent or wrong: in a CI run's log too.
      for (const { site, outcome } of scored) {
        if (outcome !== "differs") continue;
        const { oldStart, oldEnd } = site.region;
        const covering = (engineRegions.get(site.file) ?? []).filter(
          (region) =>
            region.oldStart < Math.max(oldEnd, oldStart + 1) &&
            oldStart < Math.max(region.oldEnd, region.oldStart + 1),
        );
        const show = (mark: string, lines: readonly string[]) =>
          lines.map((line) => `  ${mark} ${line.trim().slice(0, 110)}\n`).join("");
        process.stdout.write(
          `differs ${site.file}:${oldStart + 1} (${options.classes[siteKey(site)]?.class ?? "unclassed"})\n${show("-", site.base.slice(oldStart, oldEnd))}${show("+", site.region.lines)}${covering.map((region) => `${show("-", site.base.slice(region.oldStart, region.oldEnd))}${show("=", region.lines)}`).join("")}`,
        );
      }
    }
    return {
      ...base,
      sites,
      ...total,
      inScope: scopeOf(scored, options.classes),
      byClass: byClassOf(scored, options.classes),
    };
  } catch (error) {
    return {
      ...base,
      sites: 0,
      identical: 0,
      differs: 0,
      flagged: 0,
      missed: 0,
      extra: 0,
      error:
        (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "",
    };
  } finally {
    if (!keep) await rm(work, { recursive: true, force: true });
  }
}

/** A case's sites that follow from a contract change, by how the engine did on each. */
export function scopeOf(
  scored: readonly { site: Site; outcome: Outcome }[],
  classes: Record<string, ClassRecord>,
): ScopedScore {
  const scope: ScopedScore = {
    sites: 0,
    identical: 0,
    differs: 0,
    flagged: 0,
    missed: 0,
    unclassified: 0,
  };
  for (const { site, outcome } of scored) {
    const record = classes[siteKey(site)];
    if (!record) {
      scope.unclassified += 1;
      continue;
    }
    if (record.class === "contested") {
      scope.contested = (scope.contested ?? 0) + 1;
      continue;
    }
    if (record.class !== "contract") continue;
    scope.sites += 1;
    scope[outcome] += 1;
  }
  return scope;
}

/** A case's sites by class, by how the engine did on each. */
export function byClassOf(
  scored: readonly { site: Site; outcome: Outcome }[],
  classes: Record<string, ClassRecord>,
): Record<string, Record<Outcome, number>> {
  const counts: Record<string, Record<Outcome, number>> = {};
  for (const { site, outcome } of scored) {
    const name = classes[siteKey(site)]?.class ?? "unclassified";
    const bucket = counts[name] ?? { identical: 0, differs: 0, flagged: 0, missed: 0 };
    counts[name] = bucket;
    bucket[outcome] += 1;
  }
  return counts;
}

/**
 * The PyPI packages whose contracts the pack is told about. Every other SDK
 * is replayed with no Changes: the engine is still checked against both
 * releases, and reports where the consumer stops type-checking.
 */
const PYTHON_CONTRACTS: Record<string, true> = { stripe: true };

/** Directories in a Python repository that hold someone else's code or none. */
const PYTHON_SKIPPED =
  /(^|\/)(\.?venv[^/]*|env|site-packages|__pycache__|\.tox|\.nox|\.eggs|migrations)\//;

/** The 0-based line an offset is on, from each line's start offset. */
export function lineOf(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((starts[middle] as number) <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Base lines each manual site covers, per file, as the score reads them. */
function flaggedLines(
  manual: readonly ManualSite[],
  repo: string,
  before: Map<string, string>,
): Map<string, (readonly [number, number])[]> {
  const flagged = new Map<string, (readonly [number, number])[]>();
  // Each file's line starts once: a file the upgrade broke all over has tens
  // of thousands of sites, and counting lines from the top for each held
  // decipad's replay for hours.
  const starts = new Map<string, number[]>();
  for (const site of manual) {
    const file = site.file.slice(repo.length + 1);
    let lines = starts.get(file);
    if (!lines) {
      const text = before.get(file) ?? readFileSync(site.file, "utf8");
      lines = [0];
      for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) {
        lines.push(at + 1);
      }
      starts.set(file, lines);
    }
    const range = [
      lineOf(lines, site.offset),
      lineOf(lines, site.end ?? site.offset) + 1,
    ] as const;
    const ranges = flagged.get(file);
    if (ranges) ranges.push(range);
    else flagged.set(file, [range]);
  }
  return flagged;
}

/**
 * A PyPI case through the Python pack: the repository's Python restored at
 * the base, both releases unpacked from their wheels, the files that import
 * the SDK read against the old one and checked against the new one.
 */
async function replayPython(
  entry: ReplayCase,
  repo: string,
  work: string,
  before: Map<string, string>,
  keep: boolean,
): Promise<{
  flagged: Map<string, (readonly [number, number])[]>;
  files: Map<string, string>;
  versions: [string, string];
}> {
  const tree = async (commit: string) => {
    const blobs = new Map<string, string>();
    for (const line of (await git(repo, "ls-tree", "-r", commit)).split("\n")) {
      const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
      if (match) blobs.set(match[2] as string, match[1] as string);
    }
    return blobs;
  };
  const blobs = await tree(entry.base);
  const readable = [...blobs.keys()]
    .filter(
      (path) =>
        path.endsWith(".py") && !SKIPPED_DIRS.test(path) && !PYTHON_SKIPPED.test(path),
    )
    .slice(0, MAX_FILES);
  await writeFile(join(work, "paths"), readable.join("\n"));
  await prefetch(
    repo,
    readable.flatMap((path) => {
      const blob = blobs.get(path);
      return blob ? [blob] : [];
    }),
  );
  if (readable.length > 0) {
    await git(
      repo,
      "restore",
      `--source=${entry.base}`,
      "--worktree",
      `--pathspec-from-file=${join(work, "paths")}`,
    );
  }

  const pinsAt = async (commit: string, paths: Iterable<string>) => {
    const found: { path: string; text: string }[] = [];
    for (const path of [...paths]
      .filter((each) => PYTHON_PINS.test(each) && !SKIPPED_DIRS.test(each))
      .slice(0, 60)) {
      const text = await textAt(repo, commit, path);
      if (text) found.push({ path, text });
    }
    return found;
  };
  const to =
    pinnedPython(
      await pinsAt(entry.head, (await tree(entry.head)).keys()),
      entry.package,
      entry.to,
    ) || entry.to;
  const from =
    pinnedPython(await pinsAt(entry.base, blobs.keys()), entry.package, entry.from) ||
    entry.from ||
    (await releaseBefore(entry.package, to, entry.mergedAt));
  if (!from) throw new Error("the base does not say which version it used");
  const cache = join(CACHE, "pypi");
  // Each release with what its wheel says it needs, so a pydantic model's
  // fields are read through pydantic rather than an unknown base.
  const oldSites = await installWithDependencies(entry.package, from, cache);
  const nextSites = await installWithDependencies(entry.package, to, cache);
  const old = { site: oldSites.sites[0] as string, version: oldSites.version };
  const next = { site: nextSites.sites[0] as string, version: nextSites.version };

  let changes: Change[] = [];
  let types: Record<string, string> = {};
  let pin: SymbolMap["pin"];
  let contract: ContractPlan | undefined;
  if (PYTHON_CONTRACTS[entry.package] && entry.package === "stripe") {
    const label = stripePythonVersion(next.site);
    const was = stripePythonVersion(old.site);
    // stripe-python before 8 records no version of its own, and speaks
    // whatever the account is pinned to; there is nothing to compare.
    if (label && was && label !== was) {
      contract = await stripePlan(
        old.version,
        next.version,
        old.site,
        false,
        "stripe-python",
      );
      changes = contract.changes;
      types = contract.types;
    }
    if (label) {
      pin = {
        type: "stripe",
        property: "api_version",
        label,
        ...(was ? { from: was } : {}),
        keywords: ["stripe_version"],
      };
    }
  }
  const symbols: SymbolMap = {
    package: entry.package,
    upgradeTo: { package: entry.package, version: next.version, types },
    types,
    accessors: [],
    ...(pin ? { pin } : {}),
  };
  const sources = importingPython(repo, readable, topLevelModules(old.site));
  const result = await migratePython({
    repoDir: repo,
    sources,
    packages: oldSites.sites,
    upgraded: nextSites.sites,
    plan: buildPlan(changes, symbols),
  });
  if (keep) {
    process.stdout.write(
      `${JSON.stringify(
        {
          versions: [old.version, next.version],
          contract: contract && {
            drafted: contract.drafted,
            removed: contract.removed,
            types: Object.keys(contract.types).length,
          },
          targets: result.targets,
          pin,
          read: readable.length,
          sources: sources.length,
          edits: result.edits.map(
            (edit) => `${edit.file.slice(repo.length + 1)}:${edit.start} ${edit.reason}`,
          ),
          manual: result.manual.map(
            (site) =>
              `${site.file.slice(repo.length + 1)}:${site.line} ${site.reason.slice(0, 160)}`,
          ),
        },
        null,
        2,
      )}\n`,
    );
  }
  const files = new Map<string, string>();
  for (const [path, text] of result.files) files.set(path.slice(repo.length + 1), text);
  return {
    flagged: flaggedLines(result.manual, repo, before),
    files,
    versions: [old.version, next.version],
  };
}

function readManifest(repo: string, root: string): string {
  try {
    return readFileSync(join(repo, root, "package.json"), "utf8");
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const at = args.indexOf(`--${name}`);
    return at === -1 ? undefined : args[at + 1];
  };
  const only = option("package");
  const single = option("case");
  const ecosystem = option("ecosystem");
  const classes = readClasses();
  // Sites are classed by Jev, only when asked and with a key.
  let classifier: ReplayOptions["classifier"];
  if (args.includes("--classify")) {
    if (!process.env["TYPESAFE_API_KEY"])
      throw new Error("--classify needs TYPESAFE_API_KEY");
    const { TypeSafeClient } = await import("@typesafe-ai/sdk");
    const { JEV_MODEL } = await import("@invariant-app/proposer");
    classifier = {
      client: new TypeSafeClient() as unknown as Parameters<typeof classify>[2],
      model: JEV_MODEL,
    };
  }
  const limit = Number(option("limit") ?? Number.POSITIVE_INFINITY);
  const index = JSON.parse(
    readFileSync(join(ROOT, "proving/replay/index.json"), "utf8"),
  ) as ReplayIndex;
  const path = option("results") ?? RESULTS;
  const readResults = (file: string): ReplayResult[] =>
    existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as ReplayResult[]) : [];
  const results = new Map(readResults(path).map((entry) => [entry.id, entry]));
  const save = () =>
    writeFile(
      path,
      `${JSON.stringify(
        [...results.values()].sort((a, b) => a.id.localeCompare(b.id)),
        null,
        2,
      )}\n`,
    );

  // Shards of a CI run, each replayed apart, laid over the recorded results.
  if (args.includes("--merge")) {
    for (const file of args.slice(args.indexOf("--merge") + 1)) {
      if (file.startsWith("--")) break;
      for (const entry of readResults(file)) results.set(entry.id, entry);
    }
    await save();
    return;
  }

  const [shard, shards] = (option("shard") ?? "0/1").split("/").map(Number) as [
    number,
    number,
  ];
  const cases = index.cases
    .filter(
      (entry) =>
        (!ecosystem || entry.ecosystem === ecosystem) &&
        (!only || entry.package === only) &&
        (!single || entry.id === single),
    )
    .filter((_, at) => at % shards === shard)
    .slice(0, limit);

  // Scores again from the sites a replay cached, with the classes as they
  // are now: a CI run replays without a key, and its sites are classed here.
  if (args.includes("--rescore")) {
    const wanted = new Set(cases.map((entry) => entry.id));
    const byCase = new Map<string, { site: Site; outcome: Outcome }[]>();
    for (const { site, outcome } of cachedOutcomes()) {
      if (!outcome || !wanted.has(site.caseId)) continue;
      byCase.set(site.caseId, [...(byCase.get(site.caseId) ?? []), { site, outcome }]);
    }
    for (const [id, scored] of byCase) {
      const result = results.get(id);
      if (!result || result.error !== undefined) continue;
      if (scored.length !== result.sites) {
        process.stderr.write(
          `${id}: ${scored.length} cached sites for ${result.sites}; replay it again\n`,
        );
        continue;
      }
      if (classifier) {
        try {
          await classify(
            scored.map((each) => each.site),
            classes,
            classifier.client,
            classifier.model,
            { recheck: args.includes("--recheck"), settle: args.includes("--settle") },
          );
        } catch (error) {
          // What could not be classed stays unclassified, and is counted so.
          process.stderr.write(
            `${id}: classification stopped: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}\n`,
          );
        }
        await writeClasses(classes);
      }
      result.inScope = scopeOf(scored, classes);
      result.byClass = byClassOf(scored, classes);
    }
    await save();
    return;
  }

  // Stops starting cases in time for what was replayed to be kept.
  const deadline =
    Date.now() + Number(option("minutes") ?? Number.POSITIVE_INFINITY) * 60_000;
  for (const entry of cases) {
    if (Date.now() > deadline) {
      process.stdout.write("stopped early: out of time\n");
      break;
    }
    // A run picks up where the last one stopped, unless asked to start over.
    if (results.has(entry.id) && !args.includes("--again")) continue;
    const result = await replay(entry, {
      keep: args.includes("--keep"),
      verbose: args.includes("--verbose"),
      recheck: args.includes("--recheck"),
      settle: args.includes("--settle"),
      classes,
      ...(classifier ? { classifier } : {}),
    });
    await writeClasses(classes);
    results.set(entry.id, result);
    process.stdout.write(
      `${entry.id} ${entry.package}: ${result.error ?? `${result.identical}/${result.sites} identical, ${result.differs} differ, ${result.flagged} flagged, ${result.missed} missed; ${result.extra} extra edits, ${result.extraFlags ?? 0} extra flags`}\n`,
    );
    await save();
  }
}

if (process.argv[1]?.endsWith("run.mts")) await main();
