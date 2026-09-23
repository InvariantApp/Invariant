/**
 * What a `go.mod` says, read as text.
 *
 * The go command would answer all of this too, but only by resolving the
 * module graph, which downloads; reading which version a repository asks for
 * should not need the network.
 */

export interface GoMod {
  /** The module's own path. */
  module: string;
  /** The `go` directive, if any. */
  go?: string;
  /** Each required module's version, direct and indirect alike. */
  require: Record<string, string>;
}

/** Reads the directives a migration needs; anything else is ignored. */
export function readGoMod(text: string): GoMod {
  const mod: GoMod = { module: "", require: {} };
  let block: string | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (line === "") continue;
    if (block) {
      if (line === ")") {
        block = undefined;
        continue;
      }
      if (block === "require") addRequirement(mod, line.split(/\s+/));
      continue;
    }
    const [verb, ...rest] = line.split(/\s+/);
    if (rest[0] === "(") {
      block = verb;
      continue;
    }
    if (verb === "module") mod.module = unquote(rest[0] ?? "");
    else if (verb === "go" && rest[0]) mod.go = rest[0];
    else if (verb === "require") addRequirement(mod, rest);
  }
  return mod;
}

function addRequirement(mod: GoMod, words: string[]): void {
  const [path, version] = words;
  if (path && version) mod.require[unquote(path)] = version;
}

function unquote(word: string): string {
  return word.replace(/^"(.*)"$/, "$1");
}

/**
 * A module path apart from its major version: `github.com/google/go-github/v88`
 * is `github.com/google/go-github` at 88. Before v2 the path has no suffix.
 */
export function majorOf(path: string): { base: string; major: number } {
  const match = /^(.*)\/v(\d+)$/.exec(path);
  if (match && Number(match[2]) >= 2) {
    return { base: match[1] as string, major: Number(match[2]) };
  }
  return { base: path, major: 1 };
}

/** The module path a major version of a module has. */
export function pathAtMajor(base: string, major: number): string {
  return major >= 2 ? `${base}/v${major}` : base;
}

/**
 * The requirements a `go.mod` has on major versions of a module, named
 * without its major version, newest major first: which of
 * `github.com/google/go-github/v*` it asks for, and at what version. A module
 * can require two at once while it moves from one to the other, as
 * vertti/ci-snitch required v84 and v85 on the day it dropped v84.
 */
export function requirementsOf(
  mod: GoMod,
  base: string,
): { path: string; version: string }[] {
  return Object.entries(mod.require)
    .filter(([path]) => majorOf(path).base === base)
    .sort(([a], [b]) => majorOf(b).major - majorOf(a).major)
    .map(([path, version]) => ({ path, version }));
}

/** The newest major version of a module a `go.mod` requires. */
export function requirementOf(
  mod: GoMod,
  base: string,
): { path: string; version: string } | undefined {
  return requirementsOf(mod, base)[0];
}
