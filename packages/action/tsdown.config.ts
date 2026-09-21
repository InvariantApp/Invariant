import { defineConfig } from "tsdown";

/**
 * One self-contained file, committed, because an action runs from the
 * repository at the ref a workflow names and never runs an install step.
 */
export default defineConfig({
  entry: ["src/main.ts"],
  format: "esm",
  fixedExtension: false,
  platform: "node",
  target: "node24",
  outDir: "bundle",
  noExternal: [/.*/],
  dts: false,
  sourcemap: false,
  clean: true,
});
