/**
 * The packages a consumer's repository is made of, and which release of the
 * SDK each one uses.
 *
 * A monorepo is not one consumer: each workspace package declares its own
 * dependencies, and two of them can be on different releases of the same SDK,
 * so each is planned and migrated against its own. What a package uses is read
 * the way its package manager would, from its manifest and then its lockfile
 * (or what is installed), never guessed from a range: a migration planned
 * against the wrong release edits code for an SDK the consumer does not have.
 *
 * Only files are read here. Nothing is installed and nothing is run.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

export type WorkspaceLanguage = "typescript" | "python" | "go";

export interface WorkspacePackage {
  /** Its directory, relative to the repository and written with `/`; `.` for the root. */
  dir: string;
  /** Its name, as its manifest gives it. */
  name?: string;
}

export interface Workspaces {
  /** What made these the packages: the workspace file, or finding several manifests. */
  kind: "npm" | "pnpm" | "yarn" | "python" | "go.work" | "go.mod" | "single";
  packages: WorkspacePackage[];
}

export interface SdkUse {
  /** The package's manifest names the SDK. */
  declared: boolean;
  /** The release it uses, when that can be told. */
  version?: string;
  /** Where the release was read, such as `pnpm-lock.yaml`. */
  source?: string;
  /** Why no release could be told, when none could. */
  why?: string;
}

/** Directories that are never a consumer's own packages. */
const NEVER = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  "site-packages",
  ".tox",
  ".nox",
  "vendor",
  "testdata",
  "dist",
  "build",
]);

/** Every directory under `repo` holding `file`, relative, skipping what is never the consumer's. */
async function directoriesWith(repo: string, file: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 12 || found.length >= 2_000) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === file)) {
      found.push(toPosix(relative(repo, dir)) || ".");
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (
        NEVER.has(entry.name) ||
        entry.name.startsWith(".") ||
        entry.name.startsWith("_")
      )
        continue;
      await walk(join(dir, entry.name), depth + 1);
    }
  };
  await walk(repo, 0);
  return found.sort();
}

const toPosix = (path: string) => path.split(sep).join("/");

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  const text = await readText(path);
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A workspace glob as npm, pnpm and yarn read one, over directory paths:
 * `*` is one path segment, `**` any number of them, and a leading `!`
 * excludes.
 */
function globToRegExp(pattern: string): RegExp {
  const normal = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
  let source = "";
  for (let index = 0; index < normal.length; index++) {
    const char = normal[index] as string;
    if (char === "*" && normal[index + 1] === "*") {
      // `**/` matches no directory at all, as well as any number.
      if (normal[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

async function expand(repo: string, patterns: readonly string[], manifest: string) {
  const candidates = await directoriesWith(repo, manifest);
  const include = patterns
    .filter((pattern) => !pattern.startsWith("!"))
    .map(globToRegExp);
  const exclude = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => globToRegExp(pattern.slice(1)));
  return candidates.filter(
    (dir) =>
      dir !== "." &&
      include.some((pattern) => pattern.test(dir)) &&
      !exclude.some((pattern) => pattern.test(dir)),
  );
}

async function npmWorkspaces(repo: string): Promise<Workspaces> {
  const root = await readJson(join(repo, "package.json"));
  let patterns: string[] | undefined;
  let kind: Workspaces["kind"] = "npm";
  const pnpm = await readText(join(repo, "pnpm-workspace.yaml"));
  if (pnpm !== undefined) {
    const parsed = parseYaml(pnpm) as { packages?: unknown } | null;
    if (Array.isArray(parsed?.packages)) {
      patterns = parsed.packages.filter(
        (entry): entry is string => typeof entry === "string",
      );
      kind = "pnpm";
    }
  }
  if (!patterns) {
    const declared = root?.["workspaces"];
    const list = Array.isArray(declared)
      ? declared
      : typeof declared === "object" && declared !== null
        ? (declared as { packages?: unknown }).packages
        : undefined;
    if (Array.isArray(list)) {
      patterns = list.filter((entry): entry is string => typeof entry === "string");
      kind = existsSync(join(repo, "yarn.lock")) ? "yarn" : "npm";
    }
  }
  if (!patterns) {
    return { kind: "single", packages: [{ dir: ".", ...nameOf(root) }] };
  }
  const dirs = await expand(repo, patterns, "package.json");
  const packages: WorkspacePackage[] = [{ dir: ".", ...nameOf(root) }];
  for (const dir of dirs) {
    packages.push({ dir, ...nameOf(await readJson(join(repo, dir, "package.json"))) });
  }
  return { kind, packages };
}

function nameOf(manifest: Record<string, unknown> | undefined): { name?: string } {
  return typeof manifest?.["name"] === "string" ? { name: manifest["name"] } : {};
}

async function pythonWorkspaces(repo: string): Promise<Workspaces> {
  const dirs = await directoriesWith(repo, "pyproject.toml");
  if (dirs.length <= 1) return { kind: "single", packages: [{ dir: dirs[0] ?? "." }] };
  const packages: WorkspacePackage[] = [];
  for (const dir of dirs) {
    const project = await readToml(join(repo, dir, "pyproject.toml"));
    const name =
      field(project, ["project", "name"]) ?? field(project, ["tool", "poetry", "name"]);
    packages.push({ dir, ...(typeof name === "string" ? { name } : {}) });
  }
  return { kind: "python", packages };
}

async function goWorkspaces(repo: string): Promise<Workspaces> {
  const work = await readText(join(repo, "go.work"));
  if (work !== undefined) {
    const uses = goDirectives(work, "use")
      .map((fields) => fields[0])
      .filter((path): path is string => path !== undefined)
      .map(
        (path) => posix.normalize(path.replace(/^"|"$/g, "")).replace(/\/+$/, "") || ".",
      )
      // A use outside the repository is some other checkout on the machine
      // that wrote go.work, and not this repository's to migrate.
      .filter((path) => !path.startsWith("..") && !posix.isAbsolute(path));
    const packages: WorkspacePackage[] = [];
    for (const dir of [...new Set(uses)].sort()) {
      const mod = await readText(join(repo, dir, "go.mod"));
      if (mod === undefined) continue;
      packages.push({ dir, ...goModuleName(mod) });
    }
    return { kind: "go.work", packages };
  }
  const dirs = await directoriesWith(repo, "go.mod");
  if (dirs.length <= 1) {
    const dir = dirs[0] ?? ".";
    const mod = await readText(join(repo, dir, "go.mod"));
    return { kind: "single", packages: [{ dir, ...(mod ? goModuleName(mod) : {}) }] };
  }
  const packages: WorkspacePackage[] = [];
  for (const dir of dirs) {
    packages.push({
      dir,
      ...goModuleName((await readText(join(repo, dir, "go.mod"))) ?? ""),
    });
  }
  return { kind: "go.mod", packages };
}

/** The packages of a repository in `language`: its workspaces, or the one package it is. */
export async function detectWorkspaces(
  repo: string,
  language: WorkspaceLanguage,
): Promise<Workspaces> {
  if (language === "typescript") return npmWorkspaces(repo);
  if (language === "python") return pythonWorkspaces(repo);
  return goWorkspaces(repo);
}

/** Which release of `sdk` the package at `dir` uses, from its manifest, then its lockfile. */
export async function sdkUse(
  repo: string,
  dir: string,
  language: WorkspaceLanguage,
  sdk: string,
): Promise<SdkUse> {
  if (language === "typescript") return npmUse(repo, dir, sdk);
  if (language === "python") return pythonUse(repo, dir, sdk);
  return goUse(repo, dir, sdk);
}

/** The directories from `dir` up to the repository's root, nearest first. */
function upward(dir: string): string[] {
  const dirs: string[] = [];
  let at = dir === "." ? "" : dir;
  for (;;) {
    dirs.push(at || ".");
    if (!at) return dirs;
    at = posix.dirname(at) === "." ? "" : posix.dirname(at);
  }
}

const EXACT = /^=?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?)$/;

async function npmUse(repo: string, dir: string, sdk: string): Promise<SdkUse> {
  const manifest = await readJson(join(repo, dir, "package.json"));
  if (!manifest) return { declared: false, why: `there is no package.json in ${dir}` };
  let range: string | undefined;
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const deps = manifest[field];
    if (
      typeof deps === "object" &&
      deps !== null &&
      typeof (deps as Record<string, unknown>)[sdk] === "string"
    ) {
      range = (deps as Record<string, string>)[sdk];
      break;
    }
  }
  if (range === undefined)
    return { declared: false, why: `it does not depend on ${sdk}` };
  if (/^(workspace|file|link|portal|git|git\+\w+|https?|github):/.test(range)) {
    return {
      declared: true,
      why: `it takes ${sdk} from ${range}, not from the registry`,
    };
  }
  // An `npm:` alias names another package: what is installed is that one.
  if (range.startsWith("npm:")) {
    return { declared: true, why: `it installs ${sdk} as an alias, ${range}` };
  }

  for (const at of upward(dir)) {
    const within = toPosix(relative(join(repo, at), join(repo, dir)));
    for (const name of ["package-lock.json", "npm-shrinkwrap.json"]) {
      const lock = await readJson(join(repo, at, name));
      if (!lock) continue;
      const packages = lock["packages"] as
        | Record<string, { version?: unknown }>
        | undefined;
      const version =
        (within ? packages?.[`${within}/node_modules/${sdk}`]?.version : undefined) ??
        packages?.[`node_modules/${sdk}`]?.version ??
        (lock["dependencies"] as Record<string, { version?: unknown }> | undefined)?.[sdk]
          ?.version;
      if (typeof version === "string")
        return { declared: true, version, source: posix.join(at, name) };
    }
    const pnpm = await readText(join(repo, at, "pnpm-lock.yaml"));
    if (pnpm !== undefined) {
      const version = pnpmVersion(pnpm, within || ".", sdk);
      if (version)
        return { declared: true, version, source: posix.join(at, "pnpm-lock.yaml") };
    }
    const yarn = await readText(join(repo, at, "yarn.lock"));
    if (yarn !== undefined) {
      const version = yarnVersion(yarn, sdk, range);
      if (version)
        return { declared: true, version, source: posix.join(at, "yarn.lock") };
    }
  }
  // Installed, when there is no lockfile but there is an install.
  for (const at of upward(dir)) {
    const installed = await readJson(join(repo, at, "node_modules", sdk, "package.json"));
    if (typeof installed?.["version"] === "string") {
      return {
        declared: true,
        version: installed["version"],
        source: posix.join(at, "node_modules", sdk, "package.json"),
      };
    }
  }
  const exact = EXACT.exec(range.trim());
  if (exact?.[1])
    return { declared: true, version: exact[1], source: posix.join(dir, "package.json") };
  return {
    declared: true,
    why: `its package.json asks for ${sdk} ${range}, and no lockfile or install says which release that is`,
  };
}

function pnpmVersion(text: string, importer: string, sdk: string): string | undefined {
  let lock: {
    importers?: Record<string, Record<string, Record<string, unknown>>>;
  } | null;
  try {
    lock = parseYaml(text, { maxAliasCount: 100 }) as typeof lock;
  } catch {
    return undefined;
  }
  const entry = lock?.importers?.[importer];
  if (!entry) return undefined;
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const found = entry[field]?.[sdk];
    const version =
      typeof found === "string"
        ? found
        : typeof found === "object" && found !== null
          ? (found as { version?: unknown }).version
          : undefined;
    if (typeof version !== "string") continue;
    if (version.startsWith("link:") || version.startsWith("file:")) return undefined;
    // `1.4.0(react@18.2.0)` is 1.4.0 resolved with those peers.
    return version.replace(/\(.*$/, "");
  }
  return undefined;
}

/**
 * yarn.lock, classic or berry: each entry's header lists the descriptors it
 * resolves (`"@acme/sdk@^1.4.0", "@acme/sdk@^1.3.0":`), and its body gives
 * the version. The package's own range picks the entry.
 */
function yarnVersion(text: string, sdk: string, range: string): string | undefined {
  const wanted = new Set([`${sdk}@${range}`, `${sdk}@npm:${range}`]);
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string;
    if (!line || line.startsWith(" ") || line.startsWith("#") || !line.endsWith(":"))
      continue;
    const descriptors = line
      .slice(0, -1)
      .split(/,\s*/)
      .map((entry) => entry.trim().replace(/^"|"$/g, ""));
    if (!descriptors.some((entry) => wanted.has(entry))) continue;
    for (let body = index + 1; body < lines.length; body++) {
      const field = lines[body] as string;
      if (!field.startsWith(" ")) break;
      const version = /^\s+version:?\s+"?([^"\s]+)"?\s*$/.exec(field);
      if (version?.[1]) return version[1];
    }
  }
  return undefined;
}

async function readToml(path: string): Promise<Record<string, unknown> | undefined> {
  const text = await readText(path);
  if (text === undefined) return undefined;
  try {
    return parseToml(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function field(value: unknown, path: readonly string[]): unknown {
  let at = value;
  for (const key of path) {
    if (typeof at !== "object" || at === null) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

/** PEP 503: names compare lowercased, with runs of `-`, `_` and `.` as one `-`. */
export const normalizePython = (name: string) =>
  name.toLowerCase().replace(/[-_.]+/g, "-");

/** A requirement's name and, when it pins one exact release, that release. */
function requirement(spec: string): { name: string; pinned?: string } | undefined {
  const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(\(?)([^;]*)/.exec(
    spec,
  );
  if (!match?.[1]) return undefined;
  const constraint = (match[4] ?? "").replace(/\)\s*$/, "").trim();
  const exact = /^===?\s*([0-9][0-9A-Za-z.+!-]*)$/.exec(constraint);
  return { name: normalizePython(match[1]), ...(exact?.[1] ? { pinned: exact[1] } : {}) };
}

async function pythonUse(repo: string, dir: string, sdk: string): Promise<SdkUse> {
  const wanted = normalizePython(sdk);
  const project = await readToml(join(repo, dir, "pyproject.toml"));
  const strings: string[] = [];
  const take = (value: unknown) => {
    if (Array.isArray(value)) {
      strings.push(
        ...value.filter((entry): entry is string => typeof entry === "string"),
      );
    }
  };
  take(field(project, ["project", "dependencies"]));
  for (const group of Object.values(
    (field(project, ["project", "optional-dependencies"]) as Record<string, unknown>) ??
      {},
  )) {
    take(group);
  }
  for (const group of Object.values(
    (field(project, ["dependency-groups"]) as Record<string, unknown>) ?? {},
  )) {
    take(group);
  }
  let declared = false;
  let pinned: { version: string; source: string } | undefined;
  for (const spec of strings) {
    const found = requirement(spec);
    if (found?.name !== wanted) continue;
    declared = true;
    if (found.pinned)
      pinned ??= { version: found.pinned, source: posix.join(dir, "pyproject.toml") };
  }
  // Poetry keeps dependencies as a table, where a bare version is exact.
  const poetry = [
    field(project, ["tool", "poetry", "dependencies"]),
    ...Object.values(
      (field(project, ["tool", "poetry", "group"]) as Record<string, unknown>) ?? {},
    ).map((group) => field(group, ["dependencies"])),
  ];
  for (const table of poetry) {
    if (typeof table !== "object" || table === null) continue;
    for (const [name, value] of Object.entries(table)) {
      if (normalizePython(name) !== wanted) continue;
      declared = true;
      const version =
        typeof value === "string" ? value : (value as { version?: unknown })?.version;
      if (typeof version === "string") {
        const exact = /^(?:==)?\s*([0-9][0-9A-Za-z.+!-]*)$/.exec(version.trim());
        if (exact?.[1])
          pinned ??= { version: exact[1], source: posix.join(dir, "pyproject.toml") };
      }
    }
  }
  const requirementFiles = (await readdir(join(repo, dir)).catch(() => [] as string[]))
    .filter((name) => /^requirements.*\.txt$/.test(name))
    .sort();
  for (const name of requirementFiles) {
    for (const line of ((await readText(join(repo, dir, name))) ?? "").split(/\r?\n/)) {
      const found = requirement(line.replace(/#.*$/, ""));
      if (found?.name !== wanted) continue;
      declared = true;
      if (found.pinned)
        pinned ??= { version: found.pinned, source: posix.join(dir, name) };
    }
  }
  if (!declared) return { declared: false, why: `it does not depend on ${sdk}` };
  if (pinned) return { declared: true, ...pinned };

  // A range: the lockfile, nearest first, says what it resolved to. A
  // workspace shares one lockfile at its root, so the search goes up.
  for (const at of upward(dir)) {
    for (const name of ["uv.lock", "poetry.lock", "pdm.lock"]) {
      const lock = await readToml(join(repo, at, name));
      if (!lock) continue;
      const versions = new Set(
        (Array.isArray(lock["package"])
          ? (lock["package"] as Record<string, unknown>[])
          : []
        )
          .filter(
            (entry) =>
              typeof entry["name"] === "string" &&
              normalizePython(entry["name"]) === wanted,
          )
          .map((entry) => entry["version"])
          .filter((version): version is string => typeof version === "string"),
      );
      if (versions.size === 1) {
        return {
          declared: true,
          version: [...versions][0] as string,
          source: posix.join(at, name),
        };
      }
      if (versions.size > 1) {
        return {
          declared: true,
          why: `${posix.join(at, name)} resolves ${sdk} to ${[...versions].sort().join(" and ")}, and nothing says which is this package's`,
        };
      }
    }
  }
  return {
    declared: true,
    why: `it asks for ${sdk} without pinning a release, and no lockfile says which one it resolved to`,
  };
}

/**
 * Directives of one kind from go.mod or go.work, each as its fields, in both
 * the one-line form and the parenthesised block.
 */
function goDirectives(text: string, verb: string): string[][] {
  const found: string[][] = [];
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\/\/.*$/, "").trim());
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string;
    if (line === `${verb} (`) {
      for (index++; index < lines.length && lines[index] !== ")"; index++) {
        const fields = (lines[index] as string).split(/\s+/).filter(Boolean);
        if (fields.length > 0) found.push(fields);
      }
    } else if (line.startsWith(`${verb} `)) {
      found.push(line.slice(verb.length).trim().split(/\s+/).filter(Boolean));
    }
  }
  return found;
}

function goModuleName(mod: string): { name?: string } {
  const name = goDirectives(mod, "module")[0]?.[0]?.replace(/^"|"$/g, "");
  return name ? { name } : {};
}

async function goUse(repo: string, dir: string, sdk: string): Promise<SdkUse> {
  const mod = await readText(join(repo, dir, "go.mod"));
  if (mod === undefined) return { declared: false, why: `there is no go.mod in ${dir}` };
  const required = goDirectives(mod, "require").find((fields) => fields[0] === sdk);
  if (!required?.[1]) return { declared: false, why: `it does not require ${sdk}` };
  const replaced = goDirectives(mod, "replace").find(
    (fields) => fields[0] === sdk && (fields[1] === "=>" || fields[1] === required[1]),
  );
  if (replaced) {
    return {
      declared: true,
      why: `its go.mod replaces ${sdk} with ${replaced.slice(replaced.indexOf("=>") + 1).join(" ")}`,
    };
  }
  return { declared: true, version: required[1], source: posix.join(dir, "go.mod") };
}
