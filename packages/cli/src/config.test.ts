/**
 * How a request names its contract, as `invariant.yaml` declares it and the
 * program carries it.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "invariant-config-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function configWith(identity: string) {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.yaml`);
  await writeFile(
    path,
    `api: acme\nspec:\n  current: openapi.json\n  currentLabel: "2026-09-20"\nidentity:\n${identity}`,
  );
  return loadConfig(path);
}

describe("identity in invariant.yaml", () => {
  it("is read as the program will carry it", async () => {
    const config = await configWith(
      [
        "  - kind: header",
        "    name: Acme-Version",
        "  - kind: principal",
        "    description: The account's pinned contract.",
        "  - kind: default",
        '    label: "2026-01-15"',
      ].join("\n"),
    );
    // Header names lower-cased; a description is for whoever reads the file.
    expect(config.identity).toEqual([
      { kind: "header", name: "acme-version" },
      { kind: "principal" },
      { kind: "default", label: "2026-01-15" },
    ]);
  });

  it("is refused where the file is wrong, not at a runtime's start", async () => {
    await expect(configWith("  - kind: cookie\n    name: v")).rejects.toThrow(
      ConfigError,
    );
    await expect(configWith("  - kind: header")).rejects.toThrow(/identity\[0\]\.name/);
  });
});
