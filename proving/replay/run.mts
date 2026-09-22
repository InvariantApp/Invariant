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
 * replayed with no plan, so its sites count as missed rather than being left
 * out of the denominator.
 *
 * Usage:
 *   node --import tsx proving/replay/run.mts [--package stripe] [--limit 10] [--keep]
 *
 * `--keep` leaves each case's checkout in place and prints what the engine
 * was told and did, for reading a miss.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { buildPlan, migrate, type SymbolMap } from "@invariant/migrate-ts";
import { ROOT } from "../corpus/manifest.mts";
import type { ReplayCase, ReplayIndex } from "./mine.mts";
import { changedRegions, type Region, type Score, score } from "./score.mts";
import { type Language, languageOf } from "./sites.mts";

const run = promisify(execFile);
const CACHE = join(ROOT, ".cache/replay");
const RESULTS = join(ROOT, "proving/replay/results.json");
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIPPED_DIRS = /(^|\/)(node_modules|dist|build|out|coverage|\.next|vendor)\//;
/** The most files read for one case: enough for any package root, not a whole monorepo. */
const MAX_FILES = 4_000;

export interface ReplayResult extends Score {
  id: string;
  language: Language;
  package: string;
  /** What the engine was told: the SDK's pin, or nothing recorded for this package. */
  engine: "pin" | "none";
  /** Human sites: regions of source the humans changed. */
  sites: number;
  /** Sites the engine could not reach for a reason outside it, such as a repository gone. */
  error?: string;
}

/** What an SDK records about itself, read from the installed package. */
interface SdkStamp {
  /** Options type and property naming the API version, as the declarations spell them. */
  pinType: string;
  pinProperty: string;
  /** The version the release speaks. */
  label: string;
}

/** How to read a stamp from each SDK that has one. */
const STAMPS: Record<string, (dir: string) => SdkStamp | undefined> = {
  stripe: (dir) => {
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
};

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

/** A file's text at a commit, or none where the commit does not have it. */
async function textAt(repo: string, commit: string, file: string): Promise<string> {
  try {
    return await git(repo, "show", `${commit}:${file}`);
  } catch {
    return "";
  }
}

/** The SDK installed at `spec`, once per version, scripts off. */
async function installed(name: string, spec: string): Promise<string> {
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
  return realpathSync(sdk);
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

async function replay(entry: ReplayCase, keep = false): Promise<ReplayResult> {
  const language = languageOf(entry);
  const base: Omit<ReplayResult, keyof Score | "sites"> = {
    id: entry.id,
    language,
    package: entry.package,
    engine: STAMPS[entry.package] ? "pin" : "none",
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

    const files = entry.files.filter((file) => SOURCE.test(file));
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

    const stamp = STAMPS[entry.package];
    const engineText = new Map<string, string>();
    if (stamp) {
      const paths = (await git(repo, "ls-tree", "-r", "--name-only", entry.base))
        .split("\n")
        .filter(Boolean);
      const roots = packageRoots(paths, files);
      const readable = paths
        .filter(
          (path) =>
            SOURCE.test(path) &&
            !SKIPPED_DIRS.test(path) &&
            !path.endsWith(".d.ts") &&
            roots.some((root) => root === "." || path.startsWith(`${root}/`)),
        )
        .slice(0, MAX_FILES);
      const manifestOf = (root: string) =>
        root === "." ? "package.json" : `${root}/package.json`;
      await writeFile(
        join(work, "paths"),
        [...new Set([...readable, ...roots.map(manifestOf)])].join("\n"),
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
      const oldSdk = await installed(entry.package, from);
      const newSdk = await installed(entry.package, to);
      const old = stamp(oldSdk);
      const next = stamp(newSdk);
      if (!old || !next) throw new Error("the SDK records no API version");

      await mkdir(join(repo, "node_modules"), { recursive: true });
      await symlink(oldSdk, join(repo, "node_modules", entry.package), "dir");
      const symbols: SymbolMap = {
        package: entry.package,
        upgradeTo: { package: entry.package, version: entry.to },
        types: {},
        accessors: [],
        pin: { type: old.pinType, property: old.pinProperty, label: next.label },
      };
      const result = await migrate({
        repoDir: `${repo}/`,
        generated: [oldSdk],
        sources: readable.map((path) => join(repo, path)),
        plan: buildPlan([], symbols),
      });
      if (keep) {
        process.stdout.write(
          `${JSON.stringify({ symbols, read: readable.length, edits: result.edits.map((edit) => `${edit.file}:${edit.start} ${edit.reason}`), manual: result.manual.map((site) => `${site.file}:${site.line} ${site.reason}`) }, null, 2)}\n`,
        );
      }
      for (const [path, text] of result.files) {
        engineText.set(path.slice(repo.length + 1), text);
      }
    }

    const total: Score = { identical: 0, differs: 0, missed: 0, extra: 0 };
    for (const file of new Set([...human.keys(), ...engineText.keys()])) {
      const text = before.get(file) ?? (await textAt(repo, entry.base, file));
      const lines = text.split("\n");
      const engine = engineText.has(file)
        ? changedRegions(lines, (engineText.get(file) as string).split("\n"))
        : [];
      const scored = score(lines, human.get(file) ?? [], engine);
      total.identical += scored.identical;
      total.differs += scored.differs;
      total.missed += scored.missed;
      total.extra += scored.extra;
    }
    return { ...base, sites, ...total };
  } catch (error) {
    return {
      ...base,
      sites: 0,
      identical: 0,
      differs: 0,
      missed: 0,
      extra: 0,
      error:
        (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "",
    };
  } finally {
    if (!keep) await rm(work, { recursive: true, force: true });
  }
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
  const limit = Number(option("limit") ?? Number.POSITIVE_INFINITY);
  const index = JSON.parse(
    readFileSync(join(ROOT, "proving/replay/index.json"), "utf8"),
  ) as ReplayIndex;
  const previous: ReplayResult[] = existsSync(RESULTS)
    ? (JSON.parse(readFileSync(RESULTS, "utf8")) as ReplayResult[])
    : [];
  const results = new Map(previous.map((entry) => [entry.id, entry]));
  const cases = index.cases
    .filter((entry) => entry.ecosystem === "npm" && (!only || entry.package === only))
    .slice(0, limit);
  for (const entry of cases) {
    const result = await replay(entry, args.includes("--keep"));
    results.set(entry.id, result);
    process.stdout.write(
      `${entry.id} ${entry.package}: ${result.error ?? `${result.identical}/${result.sites} identical, ${result.differs} differ, ${result.missed} missed, ${result.extra} extra`}\n`,
    );
    await writeFile(
      RESULTS,
      `${JSON.stringify(
        [...results.values()].sort((a, b) => a.id.localeCompare(b.id)),
        null,
        2,
      )}\n`,
    );
  }
}

if (process.argv[1]?.endsWith("run.mts")) await main();
