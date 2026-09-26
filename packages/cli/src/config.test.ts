/**
 * How a request names its contract, as `invariant.yaml` declares it and the
 * program carries it.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, type InvariantConfig, loadConfig } from "./config.ts";

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

describe("where a released contract's build comes from", () => {
  async function withBuild(contracts: string) {
    const path = join(dir, `${Math.random().toString(36).slice(2)}.yaml`);
    await writeFile(
      path,
      [
        "api: acme",
        "spec:",
        "  current: openapi.json",
        "identity:",
        "  - kind: default",
        '    label: "2026-09-20"',
        "build:",
        "  head:",
        "    command: pnpm start",
        "  contracts:",
        contracts,
      ].join("\n"),
    );
    return loadConfig(path);
  }

  it("reads a running environment, an image and a released commit", async () => {
    const config = await withBuild(
      [
        '    "2025-06-01":',
        "      url: https://v1.staging.example.com/",
        '    "2026-01-01":',
        "      image: ghcr.io/acme/api:2026-01-01",
        "      port: 3000",
        "      env: { MODE: test }",
        '    "2026-03-01":',
        "      worktree: v2026-03-01",
        "      install: pnpm install --frozen-lockfile",
        "      command: pnpm start",
      ].join("\n"),
    );
    expect([...(config.build?.contracts ?? [])]).toEqual([
      ["2025-06-01", { kind: "url", url: "https://v1.staging.example.com" }],
      [
        "2026-01-01",
        {
          kind: "image",
          image: "ghcr.io/acme/api:2026-01-01",
          port: 3000,
          env: { MODE: "test" },
        },
      ],
      [
        "2026-03-01",
        {
          kind: "worktree",
          ref: "v2026-03-01",
          install: { command: "pnpm", args: ["install", "--frozen-lockfile"] },
          command: "pnpm",
          args: ["start"],
          env: {},
        },
      ],
    ]);
  });

  it("refuses a source that is ambiguous or mistyped", async () => {
    await expect(
      withBuild(
        ['    "2026-01-01":', "      url: https://a", "      image: b"].join("\n"),
      ),
    ).rejects.toThrow(/exactly one of url, image, compose or worktree/);
    await expect(
      withBuild(['    "2026-01-01":', "      image: b", "      comand: x"].join("\n")),
    ).rejects.toThrow(/comand is not a setting of an image source/);
    await expect(
      withBuild(['    "2026-01-01":', "      worktree: v1"].join("\n")),
    ).rejects.toThrow(ConfigError);
  });
});

describe("the current build", () => {
  async function withHead(head: string[], rest: string[] = []): Promise<InvariantConfig> {
    const path = join(dir, "head.yaml");
    await writeFile(
      path,
      [
        "api: acme",
        "spec:",
        "  current: openapi.json",
        "build:",
        "  head:",
        ...head.map((line) => `    ${line}`),
        ...rest,
      ].join("\n"),
    );
    return loadConfig(path);
  }

  it("can be an image behind the proxy, with released builds from a Compose file", async () => {
    const config = await withHead(
      ["image: ghcr.io/acme/api:head", "port: 3000", "proxy: true"],
      [
        "  readyTimeout: 240",
        "  startPer: contract",
        "  contracts:",
        '    "2026-01-01":',
        "      compose: deploy/compose.yaml",
        `      env: { TAG: "\${contract}" }`,
      ],
    );
    expect(config.build).toMatchObject({
      command: "",
      headSource: { kind: "image", image: "ghcr.io/acme/api:head", port: 3000, env: {} },
      proxy: true,
      readyTimeoutMs: 240_000,
      startPer: "contract",
    });
    expect(config.build?.contracts.get("2026-01-01")).toEqual({
      kind: "compose",
      file: join(dir, "deploy/compose.yaml"),
      env: { TAG: `\${contract}` },
    });
  });

  it("is a command by default, started each scenario afresh", async () => {
    const config = await withHead(["command: pnpm start"]);
    expect(config.build).toMatchObject({
      command: "pnpm",
      args: ["start"],
      headSource: undefined,
      proxy: false,
      readyTimeoutMs: 30_000,
      startPer: "scenario",
    });
  });

  it("is exactly one thing", async () => {
    await expect(withHead(["command: pnpm start", "image: api"])).rejects.toThrow(
      /build.head must name exactly one of command, url, image or compose/,
    );
    await expect(withHead(["proxy: true"])).rejects.toThrow(/exactly one/);
    await expect(withHead(["image: api"], ["  startPer: build"])).rejects.toThrow(
      /startPer must be scenario or contract/,
    );
  });
});

describe("a setting nobody reads", () => {
  it("is refused and named, never silently ignored", async () => {
    const path = join(dir, "typo.yaml");
    await writeFile(
      path,
      'api: acme\nspec:\n  current: openapi.json\ngates:\n  declaredLossy: block\nbuild:\n  head:\n    command: npm start\n    enviroment: { A: "1" }\n',
    );
    const error = await loadConfig(path).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain("the top level: gates is not a setting");
    expect((error as Error).message).toContain("build.head: enviroment is not a setting");
  });
});
