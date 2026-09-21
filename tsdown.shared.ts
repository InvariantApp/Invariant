/**
 * How every published package is built.
 *
 * Sources import each other with `.ts` extensions and run directly under Node's
 * type stripping in development, so nothing is compiled to work on this
 * repository. What gets published is ESM with bundled declarations, built
 * here, and each package's manifest points its published exports at it.
 *
 * ESM only. The published floor is Node 22.12, where `require()` of an ES
 * module works unflagged, so a CommonJS provider can still load every package.
 * A dual build would ship two copies of every class, and an `instanceof` check
 * across them fails in ways nobody can debug from the outside.
 */
import { defineConfig, type UserConfig } from "tsdown";

export function library(options: Partial<UserConfig> = {}) {
  return defineConfig({
    entry: ["src/index.ts"],
    format: "esm",
    // Plain `.js`: every package is `"type": "module"` already, and a `.mjs`
    // file is one more thing for a manifest to get wrong.
    fixedExtension: false,
    platform: "node",
    target: "node22",
    dts: { tsconfig: "../../tsconfig.build.json" },
    sourcemap: true,
    clean: true,
    ...options,
  });
}
