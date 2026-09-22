/**
 * What the request path is allowed to touch.
 *
 * The product's central claim is that a model can propose anything because
 * nothing it proposes reaches production without passing checks a person
 * reviewed. That claim rests on the request path containing no model, no
 * network call and no file read, and "we were careful" is not a way to keep it
 * true across the next hundred commits.
 *
 * So it is asserted from the source. Every import the runtime makes, directly
 * or through anything it depends on, has to be something on this list.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGES = join(import.meta.dirname, "../..");

/**
 * Packages the request path may reach.
 *
 * Exact decimal arithmetic is here because money cannot be done in floating
 * point and the alternative is inlining it. It has no dependencies of its own,
 * which this test also checks.
 */
const ALLOWED_PACKAGES = new Set(["@invariant-app/decimal"]);

/**
 * Node built-ins the request path may use.
 *
 * Deliberately empty. `node:fs` would let a program read a file, `node:https`
 * would let it call out, and `node:child_process` needs no explanation. A
 * runtime that cannot do any of those cannot be made to do them by a bad
 * compiled program either.
 */
const ALLOWED_BUILTINS = new Set<string>([]);

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Specifiers this file imports, re-exports, or imports dynamically.
 *
 * Anchored to the start of a line rather than matching `from` anywhere,
 * because a field called `from` appears in the compiled program's own route
 * rules and a looser pattern reads `raw["from"]` as an import of `]`.
 */
function importsIn(text: string): string[] {
  const found: string[] = [];
  const patterns = [
    // import x from "y" / export { x } from "y", but not `import type`, which
    // is erased before anything runs. The runtime is allowed to know the shape
    // of the IR; it is not allowed to load anything at a request.
    /^\s*(?:import|export)\s+(?!type\b)[^'"]*?\bfrom\s*["']([^"']+)["']/gm,
    // import "y", for a side effect
    /^\s*import\s+["']([^"']+)["']/gm,
    // await import("y"), which is the one a reviewer misses
    /\bimport\s*\(\s*["']([^"']+)["']/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier) found.push(specifier);
    }
  }
  return found;
}

async function importsOfPackage(name: string): Promise<string[]> {
  const files = await sourceFiles(join(PACKAGES, name, "src"));
  const texts = await Promise.all(files.map((file) => readFile(file, "utf8")));
  return texts.flatMap(importsIn);
}

describe("what the request path can reach", () => {
  it("imports nothing but exact decimal arithmetic", async () => {
    const specifiers = await importsOfPackage("runtime");

    for (const specifier of specifiers) {
      if (specifier.startsWith(".")) continue;
      if (specifier.startsWith("node:")) {
        expect(
          ALLOWED_BUILTINS.has(specifier),
          `packages/runtime imports ${specifier}, which the request path must not reach`,
        ).toBe(true);
        continue;
      }
      expect(
        ALLOWED_PACKAGES.has(specifier),
        `packages/runtime imports ${specifier}, which is not on the allowed list`,
      ).toBe(true);
    }
  });

  it("depends on nothing that itself reaches further", async () => {
    // One level is not enough: a dependency that grew a network client would
    // put one in the request path without changing a line of this package.
    for (const allowed of ALLOWED_PACKAGES) {
      const name = allowed.replace("@invariant-app/", "");
      const specifiers = await importsOfPackage(name);
      const external = specifiers.filter((entry) => !entry.startsWith("."));
      expect(external, `${allowed} should import nothing at all`).toEqual([]);
    }
  });

  it("counts a value import even when a type import of the same thing is fine", () => {
    // The distinction this rests on, stated rather than assumed. The first
    // disappears at compile time; the second is a module loaded at a request.
    expect(importsIn('import type { Instr } from "@invariant-app/ir";')).toEqual([]);
    expect(importsIn('import { parseChange } from "@invariant-app/ir";')).toEqual([
      "@invariant-app/ir",
    ]);
    expect(importsIn('import { type A, b } from "x";')).toEqual(["x"]);
  });

  it("names no model, no client and no transport anywhere in its source", async () => {
    const files = await sourceFiles(join(PACKAGES, "runtime/src"));
    const texts = await Promise.all(files.map((file) => readFile(file, "utf8")));
    const source = texts.join("\n");

    // A crude check on purpose. It catches the import that a refactor adds
    // without thinking, which is the realistic way this property gets lost.
    for (const forbidden of [
      "@typesafe-ai/sdk",
      "@anthropic-ai/sdk",
      "openai",
      "node:fs",
      "node:http",
      "node:https",
      "node:net",
      "node:child_process",
      "node:worker_threads",
    ]) {
      expect(source.includes(forbidden), `packages/runtime mentions ${forbidden}`).toBe(
        false,
      );
    }
  });

  it("declares in its manifest exactly what it imports", async () => {
    const manifest = JSON.parse(
      await readFile(join(PACKAGES, "runtime/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    // A package can import something it does not declare and still work in a
    // workspace, so the manifest is checked against the source rather than
    // trusted on its own.
    expect(new Set(Object.keys(manifest.dependencies ?? {}))).toEqual(ALLOWED_PACKAGES);
  });
});
