import { defineConfig } from "tsdown";

/**
 * The proxy as one file, for the container image. Nothing is installed or
 * compiled inside the image, so it holds exactly this and a Node runtime.
 */
export default defineConfig({
  entry: { "invariant-sidecar": "src/cli.ts" },
  format: "esm",
  fixedExtension: false,
  platform: "node",
  target: "node24",
  outDir: "image/bundle",
  noExternal: [/.*/],
  dts: false,
  sourcemap: false,
  clean: true,
});
