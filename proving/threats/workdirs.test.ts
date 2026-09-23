/**
 * Migration workdirs, and everything that writes a file named by someone
 * else: path traversal, links out of the checkout, and consumer code that
 * would run if anything here ran it.
 *
 * The service runs migrations for many consumers on one machine. The names of
 * the files a migration writes come from input: the provider's published
 * symbol map names the helpers module and the regenerated types, and the
 * consumer's repository decides which files are source and can commit links.
 * A path that leaves the checkout is a write into another tenant's checkout
 * or into the service. Each test builds a real consumer repository, runs the
 * migration with `write` on, and looks at the disk afterwards.
 */
import { cp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildBundle, generateSigningKey, signBundle } from "@invariant-app/bundle";
import { DeliveryError, deliverMigration, type GitHubApi } from "@invariant-app/github";
import {
  buildPlan,
  MigrationPathError,
  migrate,
  type SymbolMap,
} from "@invariant-app/migrate-ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { invariant, ROOT, workdir } from "./harness.ts";

const FIXTURE = join(ROOT, "fixtures/consumer-pinned");
const MANIFEST = '{"name":"consumer","dependencies":{"paysdk":"1.0.0"}}\n';

let base: string;
let repo: string;
/** Somewhere no migration of `repo` may write. */
let outside: string;

beforeEach(async () => {
  base = await workdir("workdirs");
  repo = join(base, "repo");
  outside = join(base, "repo-other");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(outside, "src"), { recursive: true });
  await cp(join(FIXTURE, "sdk"), join(repo, "sdk"), { recursive: true });
  await cp(join(FIXTURE, "src/clients.ts"), join(repo, "src/clients.ts"));
  await writeFile(join(repo, "package.json"), MANIFEST);
  await writeFile(
    join(repo, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ["src", "sdk"],
    }),
  );
  await cp(join(FIXTURE, "src/clients.ts"), join(outside, "src/clients.ts"));
  await writeFile(join(outside, "package.json"), MANIFEST);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const symbols = (extra: Partial<SymbolMap> = {}): SymbolMap => ({
  package: "paysdk",
  upgradeTo: { package: "paysdk", version: "2.0.0" },
  types: {},
  accessors: [],
  pin: { type: "Pay.PayConfig", property: "apiVersion", label: "2024-04-10" },
  ...extra,
});

function run(extra: Partial<SymbolMap> = {}, options: Record<string, unknown> = {}) {
  return migrate({
    repoDir: repo,
    generated: [join(repo, "sdk/")],
    tsConfigFilePath: join(repo, "tsconfig.json"),
    plan: buildPlan([], symbols(extra)),
    write: true,
    ...options,
  });
}

/** Every file under a directory with its contents, to compare before and after. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[path] = await readFile(path, "utf8");
  }
  return out;
}

const helpers = (path: string): Partial<SymbolMap> => ({
  helpers: {
    toMinor: "toMinor",
    fromMinor: "fromMinor",
    from: "./units",
    emit: { path },
  },
});

describe("a path a provider's symbol map names", () => {
  it.each([
    ["a climb out of the repository", "../repo-other/src/units.ts"],
    ["a climb through the source directory", "src/../../escaped-units.ts"],
    ["an absolute path", "{base}/absolute-units.ts"],
  ])(
    "refuses a helpers module at %s, and writes nothing anywhere",
    async (_name, path) => {
      const before = await snapshot(base);
      await expect(run(helpers(path.replace("{base}", base)))).rejects.toBeInstanceOf(
        MigrationPathError,
      );
      expect(await snapshot(base)).toEqual(before);
    },
  );

  it("refuses a regenerated file that climbs out, and writes nothing anywhere", async () => {
    const before = await snapshot(base);
    await expect(
      run(
        {},
        {
          regenerate: [{ path: "../repo-other/src/clients.ts", source: "export {};\n" }],
        },
      ),
    ).rejects.toBeInstanceOf(MigrationPathError);
    expect(await snapshot(base)).toEqual(before);
  });

  it("still writes a helpers module that stays inside", async () => {
    await run(helpers("src/units.ts"));
    expect(await readFile(join(repo, "src/units.ts"), "utf8")).toContain("toMinor");
  });
});

describe("a repository that links or reaches outside itself", () => {
  it("does not write through a package.json that is a link to another checkout", async () => {
    // Before the fix the manifest was read and written through the link.
    await rm(join(repo, "package.json"));
    await symlink(join(outside, "package.json"), join(repo, "package.json"));
    await expect(run()).rejects.toBeInstanceOf(MigrationPathError);
    expect(await readFile(join(outside, "package.json"), "utf8")).toBe(MANIFEST);
  });

  it("does not edit another checkout its configuration includes", async () => {
    // `/work/repo` is a prefix of `/work/repo-other`, and the check was a
    // prefix: a consumer's tsconfig that includes the sibling had it migrated.
    const tsconfig = JSON.parse(await readFile(join(repo, "tsconfig.json"), "utf8"));
    tsconfig.include.push("../repo-other/src");
    await writeFile(join(repo, "tsconfig.json"), JSON.stringify(tsconfig));
    const before = await readFile(join(outside, "src/clients.ts"), "utf8");
    const result = await run();
    expect([...result.files.keys()].filter((file) => file.startsWith(outside))).toEqual(
      [],
    );
    expect(await readFile(join(outside, "src/clients.ts"), "utf8")).toBe(before);
    // Its own source was migrated as usual.
    expect(await readFile(join(repo, "src/clients.ts"), "utf8")).toContain("2024-04-10");
  });

  it("does not write through a source file that is a link out of the checkout", async () => {
    await symlink(join(outside, "src/clients.ts"), join(repo, "src/linked.ts"));
    const before = await readFile(join(outside, "src/clients.ts"), "utf8");
    await run().catch((error: unknown) => {
      expect(error).toBeInstanceOf(MigrationPathError);
    });
    expect(await readFile(join(outside, "src/clients.ts"), "utf8")).toBe(before);
  });
});

describe("consumer code", () => {
  it("is never run: install scripts, compiler plugins and module side effects stay inert", async () => {
    const marker = join(base, "ran");
    const touch = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`;
    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({
        name: "consumer",
        dependencies: { paysdk: "1.0.0" },
        scripts: {
          preinstall: `node -e '${touch}'`,
          postinstall: `node -e '${touch}'`,
          prepare: `node -e '${touch}'`,
          test: `node -e '${touch}'`,
        },
      }),
    );
    const tsconfig = JSON.parse(await readFile(join(repo, "tsconfig.json"), "utf8"));
    tsconfig.compilerOptions.plugins = [{ name: "../plugin.cjs" }];
    await writeFile(join(repo, "tsconfig.json"), JSON.stringify(tsconfig));
    await writeFile(
      join(repo, "plugin.cjs"),
      `${touch};\nmodule.exports = () => ({});\n`,
    );
    await writeFile(
      join(repo, "src/side-effect.ts"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\n`,
    );
    await run();
    await expect(readFile(marker)).rejects.toThrow();
  });

  it("the engine imports nothing that can start a process, load code or send source anywhere", async () => {
    const dir = join(ROOT, "packages/migrate-ts/src");
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      const text = await readFile(join(dir, name), "utf8");
      expect(text, name).not.toMatch(
        /node:child_process|node:vm|node:worker_threads|node:https?\b|node:net|node:dgram|\bfetch\(|\bimport\(|\brequire\(|\beval\(|new Function/,
      );
    }
  });
});

describe("delivering a migration", () => {
  const recording = () => {
    const calls: string[] = [];
    const api: GitHubApi = {
      async request(method: string, path: string) {
        calls.push(`${method} ${path}`);
        return { status: 200, data: {} } as never;
      },
    } as GitHubApi;
    return { api, calls };
  };

  it.each([
    ["a climb out of the repository", "../outside.ts"],
    ["a climb in the middle", "src/../../outside.ts"],
    ["an absolute path", "/etc/cron.d/job"],
    ["the repository's own git directory", ".git/hooks/post-checkout"],
    ["a git directory further down", "vendor/.GIT/config"],
    ["a backslash path", "src\\..\\..\\outside.ts"],
    ["an empty segment", "src//clients.ts"],
  ])("refuses %s before calling GitHub at all", async (_name, path) => {
    const { api, calls } = recording();
    await expect(
      deliverMigration({
        api,
        repo: "globex/app",
        baseBranch: "main",
        headBranch: "invariant/migrate",
        summary: {} as never,
        files: [
          { path: "src/clients.ts", content: "ok" },
          { path, content: "pwned" },
        ],
        commitMessage: "Migrate",
      }),
    ).rejects.toBeInstanceOf(DeliveryError);
    expect(calls).toEqual([]);
  });
});

describe("the rebuild workdir", () => {
  it("is removed when a rebuild fails, and the checkout is left as it was", async () => {
    const temporary = await workdir("tmpdir");
    try {
      const { privateKeyPem, publicKeyPem } = generateSigningKey();
      const { bundle, digest } = buildBundle({
        api: "acme-payments",
        from: { label: "2026-03-01", digest: "sha256:aaaa" },
        to: { label: "2026-09-20", digest: "sha256:bbbb" },
        // A commit id that names nothing, so `git worktree add` fails.
        source: { repo: "acme/payments-api", commit: "f".repeat(40) },
        changes: [
          {
            irVersion: 1,
            id: "chg_x",
            summary: "x",
            scopes: [{ schema: "#/components/schemas/Payment" }],
            ops: [{ op: "move", from: "/a", to: "/b" }],
          },
        ],
        evidence: [],
        program: {
          irVersion: 2,
          compiledBy: "threats",
          minRuntime: "0.1.0",
          api: "acme-payments",
          current: "sha256:bbbb",
          currentLabel: "2026-09-20",
          contracts: {},
        },
        gate: { result: "pass", unexplained: [] },
      });
      await writeFile(join(temporary, "key.pem"), publicKeyPem);
      await writeFile(
        join(temporary, "bundle.json"),
        JSON.stringify(signBundle(bundle, digest, privateKeyPem)),
      );
      const scratch = join(temporary, "tmp");
      await mkdir(scratch);
      const result = await invariant(
        [
          "verify",
          join(temporary, "bundle.json"),
          "--key",
          join(temporary, "key.pem"),
          "--config",
          join(ROOT, "fixtures/provider-acme/invariant.yaml"),
          "--rebuild",
        ],
        { env: { ...process.env, TMPDIR: scratch } },
      );
      expect(result.code).toBe(1);
      expect(result.output).toMatch(/git worktree add/);
      const left = (await readdir(scratch)).filter((name) =>
        name.startsWith("invariant-"),
      );
      expect(left).toEqual([]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
