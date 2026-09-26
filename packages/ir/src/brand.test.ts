/**
 * The names in brand.ts are written nowhere else in the code, so changing one
 * is changing one line; and the addresses it gives point at something.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BRAND } from "./brand.ts";

const ROOT = join(import.meta.dirname, "../../..");

/** Tracked files that are code, less brand.ts itself and what is built from it. */
function codeContaining(text: string): string[] {
  let found: string;
  try {
    found = execFileSync(
      "git",
      [
        "grep",
        "-lF",
        text,
        "--",
        "*.ts",
        "*.mts",
        "*.mjs",
        "*.go",
        ":!packages/ir/src/brand.ts",
        ":!packages/action/bundle",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
  } catch {
    // git grep exits 1 when nothing matches.
    return [];
  }
  return found.split("\n").filter(Boolean);
}

describe("brand.ts", () => {
  it("is the only place in the code the service's address and the predicate type are written", () => {
    expect(codeContaining(BRAND.service)).toEqual([]);
    expect(codeContaining(BRAND.predicateType)).toEqual([]);
  });

  it("names a predicate type that is this repository's page describing it", () => {
    const prefix = `https://github.com/${BRAND.repository}/blob/main/`;
    expect(BRAND.predicateType.startsWith(prefix)).toBe(true);
    const page = join(ROOT, BRAND.predicateType.slice(prefix.length));
    expect(existsSync(page)).toBe(true);
    expect(readFileSync(page, "utf8")).toContain(BRAND.predicateType);
  });

  it("is the scope every published package is named under", () => {
    // Only a package's own manifest: a plain `*` would match through `/`
    // into the SDK releases kept as fixtures, which are other people's.
    const names = execFileSync("git", ["ls-files", ":(glob)packages/*/package.json"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
      .map(
        (file) => JSON.parse(readFileSync(join(ROOT, file), "utf8")) as { name: string },
      );
    expect(names.length).toBeGreaterThan(10);
    for (const { name } of names)
      expect(name.startsWith(`${BRAND.scope}/`), name).toBe(true);
  });
});
