/**
 * Walking an unpacked release. Only the release's own files are read: a
 * dependency it bundles, its tests and its examples declare nothing a
 * consumer reaches through it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SKIPPED = new Set([
  "node_modules",
  "__pycache__",
  ".git",
  "test",
  "tests",
  "__tests__",
  "testdata",
  "examples",
  "example",
  "docs",
  "vendor",
]);

/** A file larger than this is not generated source anyone reads by hand. */
const MAX_BYTES = 8 * 1024 * 1024;

/** Every file under `root` whose name `wanted` accepts, as paths relative to it, sorted. */
export function filesUnder(root: string, wanted: (name: string) => boolean): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 12) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name) && !entry.name.endsWith(".dist-info")) {
          walk(path, depth + 1);
        }
      } else if (entry.isFile() && wanted(entry.name)) {
        found.push(relative(root, path).split(sep).join("/"));
      }
    }
  };
  walk(root, 0);
  // Directory order differs between file systems; the map must not.
  return found.sort();
}

/** A file's text, or undefined when it is too large or unreadable. */
export function textOf(root: string, file: string): string | undefined {
  const path = join(root, file);
  try {
    if (statSync(path).size > MAX_BYTES) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
