import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
      "fixtures/**/*.test.ts",
      "e2e/**/*.test.ts",
      "proving/**/*.test.ts",
    ],
    // `.migrated` holds the output of a migration run. It is exercised by the
    // end-to-end demo against a live provider, not by the ordinary suite.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.migrated/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
