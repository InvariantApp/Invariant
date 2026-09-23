/**
 * Rig E for Go: the Go language pack run where humans already migrated.
 *
 * The repository is restored at the bump's base: every Go file and every
 * go.mod and go.sum, so each module resolves its own packages. For each
 * module the humans edited, the SDK's release is read from the base's go.mod
 * and the release it moved to from the head's, which is the bump the bot
 * made and which defines the upgrade; nothing else is read from the head.
 * The engine then reads the packages that import the SDK, and the packages
 * that import those, exactly as it would on a pull request of its own.
 *
 * Nothing from the repository is executed. The go command compiles its
 * dependencies to read their types, with the toolchain installed, go.mod
 * read-only, no cgo and modules only through the public proxy.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { ManualSite } from "@invariant-app/migrate-core";
import {
  buildGoPlan,
  downloadModule,
  type GoOptions,
  majorOf,
  migrate,
  readGoMod,
  readSurface,
  requirementOf,
  requirementsOf,
  type SurfaceObject,
} from "@invariant-app/migrate-go";
import { goGithubContract, operationsListing } from "./gogithub.mts";
import type { ReplayCase } from "./mine.mts";

/** What the replay needs from the checkout it made. */
export interface Checkout {
  repo: string;
  /** Every path at the base, to its blob. */
  paths: readonly string[];
  /** Restores these paths from the base into the working tree. */
  restore(paths: readonly string[]): Promise<void>;
  /** A file's text at a commit, or "" where the commit does not have it. */
  textAt(commit: string, file: string): Promise<string>;
}

export interface GoReplay {
  engine: "contract" | "verify";
  /** New text per file the engine edited, by absolute path. */
  files: Map<string, string>;
  manual: ManualSite[];
  /** The releases replayed across, in the first module the humans edited. */
  versions?: [string, string];
  /** What the engine was told and found, for `--keep`. */
  notes: Record<string, unknown>[];
}

const SKIPPED = /(^|\/)(vendor|testdata|node_modules|\.git)\//;
/** The most Go files restored for one case. */
const MAX_FILES = 20_000;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** The directory of each file's nearest go.mod, "." for the repository's root. */
function moduleRoot(file: string, modules: ReadonlySet<string>): string | undefined {
  let dir = dirname(file);
  for (;;) {
    if (modules.has(dir)) return dir;
    if (dir === ".") return undefined;
    dir = dirname(dir);
  }
}

async function cachedSurface(
  cache: string,
  module: string,
  version: string,
  packages: readonly string[],
  options: GoOptions,
): Promise<SurfaceObject[]> {
  const path = join(
    cache,
    "surface",
    `${`${module}@${version}`.replace(/[^\w.@-]+/g, "_")}__${packages.join(",").replace(/[^\w.,-]+/g, "_") || "root"}.json`,
  );
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as SurfaceObject[];
  const surface = await readSurface(module, version, packages, options, cache);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(surface));
  return surface;
}

export async function replayGo(
  entry: ReplayCase,
  checkout: Checkout,
  humanFiles: readonly string[],
  cache: string,
): Promise<GoReplay> {
  const options: GoOptions = {
    modCache: join(cache, "go", "mod"),
    buildCache: join(cache, "go", "build"),
    cacheDir: join(cache, "go", "bin"),
    parallelism: Number(process.env["REPLAY_GO_PARALLELISM"] ?? 1),
    // A repository whose dependencies take longer than this to compile is
    // recorded as not replayed rather than holding up every case after it.
    timeout: 20 * 60_000,
  };
  await mkdir(join(cache, "go"), { recursive: true });
  const family = majorOf(entry.package).base;
  const goFiles = checkout.paths
    .filter((path) => path.endsWith(".go") && !SKIPPED.test(path))
    .slice(0, MAX_FILES);
  const manifests = checkout.paths.filter(
    (path) => /(^|\/)go\.(mod|sum)$/.test(path) && !SKIPPED.test(path),
  );
  await checkout.restore([...goFiles, ...manifests]);
  const modules = new Set(
    manifests.filter((path) => path.endsWith("go.mod")).map((path) => dirname(path)),
  );

  const roots = new Set<string>();
  for (const file of humanFiles) {
    const root = moduleRoot(file, modules);
    if (root !== undefined) roots.add(root);
  }
  if (roots.size === 0) throw new Error("no go.mod holds the files the humans edited");

  const result: GoReplay = { engine: "verify", files: new Map(), manual: [], notes: [] };
  const texts = new Map<string, string>();
  const textOf = (path: string) => {
    let text = texts.get(path);
    if (text === undefined) {
      try {
        text = readFileSync(join(checkout.repo, path), "utf8");
      } catch {
        text = "";
      }
      texts.set(path, text);
    }
    return text;
  };

  for (const root of [...roots].sort()) {
    const modPath = root === "." ? "go.mod" : `${root}/go.mod`;
    const mod = readGoMod(await readFile(join(checkout.repo, modPath), "utf8"));
    const to = requirementOf(
      readGoMod(await checkout.textAt(entry.head, modPath)),
      family,
    );
    // The release the bump moves away from: where the base requires two
    // majors at once, the one the head no longer asks for.
    const from = requirementsOf(mod, family).find(
      (each) => !to || each.path !== to.path || each.version !== to.version,
    );
    if (!to) {
      result.notes.push({ root, skipped: `the head does not require ${family}` });
      continue;
    }
    if (!from) {
      result.notes.push({
        root,
        skipped: `the base requires ${family} as the head does`,
      });
      continue;
    }

    // The module's own files: not those of a module nested inside it.
    const own = goFiles.filter((path) => moduleRoot(path, modules) === root);
    const imports = new RegExp(`"${escapeRegExp(from.path)}(/[^"]*)?"`, "g");
    const sdkPackages = new Set<string>();
    const direct = new Set<string>();
    for (const path of own) {
      for (const match of textOf(path).matchAll(imports)) {
        sdkPackages.add((match[1] ?? "").replace(/^\//, ""));
        direct.add(dirname(path));
      }
    }
    if (direct.size === 0) {
      result.notes.push({ root, skipped: `nothing imports ${from.path}` });
      continue;
    }
    // And the packages that import those, where a wrapper's callers are.
    const importPath = (dir: string) => {
      const inside = root === "." ? dir : relative(root, dir);
      return inside === "" || inside === "." ? mod.module : `${mod.module}/${inside}`;
    };
    const wrapped = [...direct].map(importPath);
    const importers = new RegExp(`"(${wrapped.map(escapeRegExp).join("|")})"`);
    const dirs = new Set(direct);
    for (const path of own) {
      if (importers.test(textOf(path))) dirs.add(dirname(path));
    }
    const patterns = [...dirs].sort().map((dir) => {
      const inside = root === "." ? dir : relative(root, dir);
      return inside === "" || inside === "." ? "." : `./${inside}`;
    });

    result.versions ??= [from.version, to.version];
    const packages = [...sdkPackages].sort();
    const before = await cachedSurface(cache, from.path, from.version, packages, options);
    const after = await cachedSurface(cache, to.path, to.version, packages, options);
    const contract =
      family === "github.com/google/go-github"
        ? goGithubContract(
            before,
            after,
            operationsListing(await downloadModule(to.path, to.version, options, cache)),
          )
        : undefined;
    if (contract) result.engine = "contract";
    const plan = buildGoPlan(
      contract?.changes ?? [],
      {
        module: from,
        upgradeTo: to,
        types: {},
        ...(contract ? { operations: contract.operations } : {}),
      },
      { before, after },
    );
    const migrated = await migrate({
      repoDir: checkout.repo,
      moduleDir: root === "." ? checkout.repo : join(checkout.repo, root),
      packages: patterns,
      plan,
      go: options,
    });
    for (const [file, text] of migrated.files) result.files.set(file, text);
    result.manual.push(...migrated.manual);
    result.notes.push({
      root,
      from,
      to,
      packages: patterns,
      retired: (contract?.changes ?? []).map((change) => change.summary),
      renames: plan.renames.map((rename) => `${rename.from.key} -> ${rename.to}`),
      edits: migrated.edits.length,
      manual: migrated.manual.map(
        (site) =>
          `${relative(checkout.repo, site.file)}:${site.line} ${site.reason.slice(0, 160)}`,
      ),
      diagnosticsBefore: migrated.diagnosticsBefore.length,
      diagnosticsAfter: migrated.diagnosticsAfter.length,
      errors: migrated.errors.slice(0, 5),
      ...(migrated.unverified ? { unverified: migrated.unverified } : {}),
    });
  }
  return result;
}
