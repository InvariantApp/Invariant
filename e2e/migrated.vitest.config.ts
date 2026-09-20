import { defineConfig } from "vitest/config";

/**
 * Config for running a migrated copy of a consumer.
 *
 * The ordinary suite deliberately skips `.migrated`, because those files only
 * make sense against a live provider. The demo runs them through this config
 * instead, so the exclusion cannot silently swallow the suite.
 */
export default defineConfig({
  test: {
    include: ["fixtures/**/.migrated/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 30_000,
  },
});
