/**
 * Behavior flags in authentication and authorization code.
 *
 * A behavior flag says which side of a change a caller's contract is on, and
 * the contract is whatever label the caller sent. Branching on it in code that
 * decides who a caller is or what they may do lets a caller choose their own
 * permissions by naming an older contract (DESIGN 11.1). So `invariant check`
 * reads the provider's source for each flag this release declares and refuses
 * the release where one is used in such a place.
 *
 * It reads text, not a syntax tree, so it works the same for every language a
 * binding exists for: a flag's id is a string nothing else in a codebase is
 * named, and a place is taken as authorization code when its file's path, or
 * the lines around the flag, say so in the words such code is written in.
 */
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const SOURCE = /\.(?:[cm]?[jt]sx?|go|py|rb|java|kt|cs|php)$/;

/** Directories that are not the provider's own source. */
const SKIPPED = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "target",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
]);

/** A path segment that names authentication or authorization code. */
const AUTH_PATH =
  /(?:^|[/._-])(?:auth|authn|authz|authori[sz]\w*|authenticat\w*|permissions?|rbac|acl|guards?|access[-_]?control|login)(?:[/._-]|$)/i;

/** Words code that decides who a caller is, or what they may do, is written in. */
const AUTH_WORDS =
  /\b(?:authori[sz]\w*|authenticat\w*|unauthori[sz]ed|forbidden|permissions?|hasRole|has_role|isAdmin|is_admin|canAccess|can_access|access denied|acl|rbac|requireAuth|require_auth|verifyToken|verify_token|jwt|401|403)\b/i;

/** How many lines either side of a flag are read as its context. */
const BEFORE = 2;
const AFTER = 3;
const MAX_FILES = 20_000;
const MAX_BYTES = 1024 * 1024;

async function sourceFiles(root: string, skip: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (found.length >= MAX_FILES) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED.has(entry.name) || path === skip) continue;
        await walk(path);
      } else if (entry.isFile() && SOURCE.test(entry.name)) {
        found.push(path);
        if (found.length >= MAX_FILES) return;
      }
    }
  };
  await walk(root);
  return found.sort();
}

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every place a declared behavior flag is used in authentication or
 * authorization code, one message each, with the file relative to `root`.
 */
export async function flagsInAuthCode(
  root: string,
  flags: readonly string[],
  options: { skip?: string } = {},
): Promise<string[]> {
  if (flags.length === 0) return [];
  const quoted = new RegExp(`(["'\`])(${flags.map(literal).join("|")})\\1`, "g");
  const found: string[] = [];
  for (const path of await sourceFiles(root, options.skip ?? "")) {
    if ((await stat(path)).size > MAX_BYTES) continue;
    const text = await readFile(path, "utf8");
    if (!flags.some((flag) => text.includes(flag))) continue;
    const file = relative(root, path).split(sep).join("/");
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(quoted)) {
        const flag = match[2] as string;
        const around = lines
          .slice(Math.max(0, index - BEFORE), index + AFTER + 1)
          .join("\n");
        const byPath = AUTH_PATH.test(file);
        const byWords = AUTH_WORDS.test(around.replace(quoted, ""));
        if (!byPath && !byWords) continue;
        found.push(
          `${file}:${index + 1}: behavior flag ${flag} is used in ` +
            `${byPath ? "authentication or authorization code" : "a decision about who a caller is or what they may do"}. ` +
            "A caller chooses its own contract, so a branch on it there lets a caller choose " +
            "its own permissions: decide access from who the caller is, never from the contract it speaks.",
        );
      }
    });
  }
  return found;
}
