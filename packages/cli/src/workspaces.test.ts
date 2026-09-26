/**
 * Monorepos: which packages a repository is, which release of the SDK each
 * one uses, and one result for the repository from a migration per package.
 *
 * Each fixture is a small monorepo written out for the test, in the shape
 * its package manager leaves: npm, pnpm and yarn workspaces with their
 * lockfiles, Python projects with several pyproject.toml files and a uv,
 * Poetry or requirements pin, and Go modules under a go.work or side by side.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type MigrationJob,
  type MigrationOutcome,
  migrateRepository,
  planPackages,
  type RepositoryJob,
} from "./migrate.ts";
import { detectWorkspaces, sdkUse } from "./workspaces.ts";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "invariant-workspaces-"));
});
afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

/** Writes a repository of `files`, each path relative to it, and returns where. */
async function repository(name: string, files: Record<string, unknown>): Promise<string> {
  const root = join(scratch, name);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(
      join(root, path),
      typeof content === "string" ? content : JSON.stringify(content, null, 2),
    );
  }
  return root;
}

const manifest = (name: string, dependencies: Record<string, string> = {}) => ({
  name,
  version: "0.0.0",
  dependencies,
});

describe("npm workspaces", () => {
  let repo: string;
  beforeAll(async () => {
    repo = await repository("npm", {
      "package.json": {
        name: "shop",
        private: true,
        workspaces: ["packages/*", "apps/**", "!apps/legacy"],
      },
      "packages/billing/package.json": manifest("@shop/billing", {
        "@acme/sdk": "^1.3.0",
      }),
      "packages/web/package.json": manifest("@shop/web", { "@acme/sdk": "^1.4.0" }),
      "packages/docs/package.json": manifest("@shop/docs", { react: "^19.0.0" }),
      "apps/tools/cli/package.json": manifest("@shop/cli", {
        "@acme/sdk": "workspace:*",
      }),
      "apps/legacy/package.json": manifest("@shop/legacy", { "@acme/sdk": "0.9.0" }),
      "node_modules/react/package.json": manifest("react"),
      "package-lock.json": {
        lockfileVersion: 3,
        packages: {
          "": { name: "shop" },
          "node_modules/@acme/sdk": { version: "1.4.0" },
          "packages/billing/node_modules/@acme/sdk": { version: "1.3.2" },
        },
      },
    });
  });

  it("are the root and every package the globs match, less the excluded and the installed", async () => {
    const found = await detectWorkspaces(repo, "typescript");
    expect(found.kind).toBe("npm");
    expect(found.packages).toEqual([
      { dir: ".", name: "shop" },
      { dir: "apps/tools/cli", name: "@shop/cli" },
      { dir: "packages/billing", name: "@shop/billing" },
      { dir: "packages/docs", name: "@shop/docs" },
      { dir: "packages/web", name: "@shop/web" },
    ]);
  });

  it("each use the release package-lock.json installed for them, nested or hoisted", async () => {
    expect(await sdkUse(repo, "packages/billing", "typescript", "@acme/sdk")).toEqual({
      declared: true,
      version: "1.3.2",
      source: "package-lock.json",
    });
    expect(await sdkUse(repo, "packages/web", "typescript", "@acme/sdk")).toMatchObject({
      version: "1.4.0",
    });
    expect(await sdkUse(repo, "packages/docs", "typescript", "@acme/sdk")).toEqual({
      declared: false,
      why: "it does not depend on @acme/sdk",
    });
    expect(await sdkUse(repo, "apps/tools/cli", "typescript", "@acme/sdk")).toMatchObject(
      {
        declared: true,
        why: "it takes @acme/sdk from workspace:*, not from the registry",
      },
    );
  });

  it("are planned one job each, and the root reads none of the others' files", async () => {
    const { workspaces, plans } = await planPackages(job(repo, "typescript"));
    expect(workspaces).toBe("npm");
    expect(
      plans.map((plan) => [plan.dir, plan.job?.from ?? plan.skipped, plan.job?.package]),
    ).toEqual([
      [".", "it does not depend on @acme/sdk", undefined],
      [
        "apps/tools/cli",
        "it takes @acme/sdk from workspace:*, not from the registry",
        undefined,
      ],
      ["packages/billing", "1.3.2", "packages/billing"],
      ["packages/docs", "it does not depend on @acme/sdk", undefined],
      ["packages/web", "1.4.0", "packages/web"],
    ]);
  });
});

describe("pnpm and yarn workspaces", () => {
  it("read pnpm-workspace.yaml and the importer's entry in pnpm-lock.yaml", async () => {
    const repo = await repository("pnpm", {
      "package.json": { name: "platform", private: true },
      "pnpm-workspace.yaml": "packages:\n  - services/*\n",
      "services/orders/package.json": manifest("orders", { "@acme/sdk": "^1.4.0" }),
      "services/refunds/package.json": manifest("refunds", { "@acme/sdk": "~1.2.0" }),
      "pnpm-lock.yaml": [
        "lockfileVersion: '9.0'",
        "",
        "importers:",
        "",
        "  .: {}",
        "",
        "  services/orders:",
        "    dependencies:",
        "      '@acme/sdk':",
        "        specifier: ^1.4.0",
        "        version: 1.4.2(zod@3.23.8)",
        "",
        "  services/refunds:",
        "    dependencies:",
        "      '@acme/sdk':",
        "        specifier: ~1.2.0",
        "        version: 1.2.7",
        "",
      ].join("\n"),
    });
    const { workspaces, plans } = await planPackages(job(repo, "typescript"));
    expect(workspaces).toBe("pnpm");
    expect(plans.map((plan) => [plan.dir, plan.job?.from, plan.fromSource])).toEqual([
      [".", undefined, undefined],
      ["services/orders", "1.4.2", "pnpm-lock.yaml"],
      ["services/refunds", "1.2.7", "pnpm-lock.yaml"],
    ]);
  });

  it("read yarn.lock by the range each package asks for, classic or berry", async () => {
    const classic = await repository("yarn-classic", {
      "package.json": { private: true, workspaces: { packages: ["pkgs/*"] } },
      "pkgs/a/package.json": manifest("a", { "@acme/sdk": "^1.4.0" }),
      "pkgs/b/package.json": manifest("b", { "@acme/sdk": "^2.0.0" }),
      "yarn.lock": [
        "# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.",
        "# yarn lockfile v1",
        "",
        '"@acme/sdk@^1.4.0", "@acme/sdk@~1.4.1":',
        '  version "1.4.3"',
        '  resolved "https://registry.yarnpkg.com/@acme/sdk/-/sdk-1.4.3.tgz"',
        "",
        '"@acme/sdk@^2.0.0":',
        '  version "2.0.1"',
        "",
      ].join("\n"),
    });
    const found = await detectWorkspaces(classic, "typescript");
    expect(found.kind).toBe("yarn");
    expect((await sdkUse(classic, "pkgs/a", "typescript", "@acme/sdk")).version).toBe(
      "1.4.3",
    );
    expect((await sdkUse(classic, "pkgs/b", "typescript", "@acme/sdk")).version).toBe(
      "2.0.1",
    );

    const berry = await repository("yarn-berry", {
      "package.json": { private: true, workspaces: ["pkgs/*"] },
      "pkgs/a/package.json": manifest("a", { "@acme/sdk": "^1.4.0" }),
      "yarn.lock": [
        "__metadata:",
        "  version: 8",
        "",
        '"@acme/sdk@npm:^1.4.0":',
        "  version: 1.4.5",
        '  resolution: "@acme/sdk@npm:1.4.5"',
        "",
      ].join("\n"),
    });
    expect((await sdkUse(berry, "pkgs/a", "typescript", "@acme/sdk")).version).toBe(
      "1.4.5",
    );
  });

  it("fall back to what is installed, then to an exact version, and otherwise say they cannot tell", async () => {
    const repo = await repository("npm-no-lock", {
      "package.json": { private: true, workspaces: ["p/*"] },
      "p/installed/package.json": manifest("installed", { "@acme/sdk": "^1.0.0" }),
      "p/installed/node_modules/@acme/sdk/package.json": {
        name: "@acme/sdk",
        version: "1.1.0",
      },
      "p/exact/package.json": manifest("exact", { "@acme/sdk": "1.2.3" }),
      "p/range/package.json": manifest("range", { "@acme/sdk": "^1.0.0" }),
    });
    expect(await sdkUse(repo, "p/installed", "typescript", "@acme/sdk")).toMatchObject({
      version: "1.1.0",
      source: "p/installed/node_modules/@acme/sdk/package.json",
    });
    expect((await sdkUse(repo, "p/exact", "typescript", "@acme/sdk")).version).toBe(
      "1.2.3",
    );
    expect(await sdkUse(repo, "p/range", "typescript", "@acme/sdk")).toMatchObject({
      declared: true,
      why: expect.stringMatching(/asks for @acme\/sdk \^1\.0\.0, and no lockfile/),
    });
  });
});

describe("Python projects with several pyproject.toml files", () => {
  let repo: string;
  beforeAll(async () => {
    repo = await repository("python", {
      "services/api/pyproject.toml": [
        "[project]",
        'name = "api"',
        "dependencies = [",
        '  "acme-sdk>=1.4,<2",',
        '  "httpx",',
        "]",
      ].join("\n"),
      "services/worker/pyproject.toml": [
        "[tool.poetry]",
        'name = "worker"',
        "",
        "[tool.poetry.dependencies]",
        'python = "^3.11"',
        'acme_sdk = "1.3.0"',
      ].join("\n"),
      "tools/report/pyproject.toml": [
        "[project]",
        'name = "report"',
        "dependencies = [\"Acme.SDK[async] == 1.2.0 ; python_version >= '3.9'\"]",
      ].join("\n"),
      "libs/common/pyproject.toml": '[project]\nname = "common"\ndependencies = []\n',
      ".venv/lib/site/pyproject.toml": '[project]\nname = "not-ours"\n',
      "uv.lock": [
        "version = 1",
        "",
        "[[package]]",
        'name = "acme-sdk"',
        'version = "1.4.2"',
        "",
        "[[package]]",
        'name = "httpx"',
        'version = "0.27.0"',
      ].join("\n"),
    });
  });

  it("are one package per pyproject.toml, never one inside a virtualenv", async () => {
    const found = await detectWorkspaces(repo, "python");
    expect(found.kind).toBe("python");
    expect(found.packages).toEqual([
      { dir: "libs/common", name: "common" },
      { dir: "services/api", name: "api" },
      { dir: "services/worker", name: "worker" },
      { dir: "tools/report", name: "report" },
    ]);
  });

  it("each use the release they pin, or the one the workspace's lockfile resolved", async () => {
    const { plans } = await planPackages(job(repo, "python", "acme-sdk"));
    expect(
      plans.map((plan) => [plan.dir, plan.job?.from ?? plan.skipped, plan.fromSource]),
    ).toEqual([
      ["libs/common", "it does not depend on acme-sdk", undefined],
      ["services/api", "1.4.2", "uv.lock"],
      ["services/worker", "1.3.0", "services/worker/pyproject.toml"],
      ["tools/report", "1.2.0", "tools/report/pyproject.toml"],
    ]);
  });

  it("say they cannot tell when a lockfile has two releases, and read requirements files", async () => {
    const twice = await repository("python-twice", {
      "a/pyproject.toml": '[project]\nname = "a"\ndependencies = ["acme-sdk>=1"]\n',
      "b/pyproject.toml": '[project]\nname = "b"\ndependencies = []\n',
      "b/requirements.txt":
        "# pinned by pip-compile\nacme_sdk==1.1.0  # via -r requirements.in\n",
      "poetry.lock": [
        "[[package]]",
        'name = "acme-sdk"',
        'version = "1.4.0"',
        "",
        "[[package]]",
        'name = "acme-sdk"',
        'version = "1.5.0"',
      ].join("\n"),
    });
    expect(await sdkUse(twice, "a", "python", "acme-sdk")).toMatchObject({
      declared: true,
      why: "poetry.lock resolves acme-sdk to 1.4.0 and 1.5.0, and nothing says which is this package's",
    });
    expect(await sdkUse(twice, "b", "python", "acme-sdk")).toEqual({
      declared: true,
      version: "1.1.0",
      source: "b/requirements.txt",
    });
  });
});

describe("Go modules", () => {
  it("are what go.work uses, and only those", async () => {
    const repo = await repository("go-work", {
      "go.work": [
        "go 1.22",
        "",
        "use (",
        "\t./billing",
        "\t./web // the storefront",
        ")",
        "",
        "use ./tools",
        "use ../elsewhere",
      ].join("\n"),
      "billing/go.mod":
        "module example.com/shop/billing\n\ngo 1.22\n\nrequire github.com/acme/sdk-go v1.4.0\n",
      "web/go.mod": [
        "module example.com/shop/web",
        "",
        "go 1.22",
        "",
        "require (",
        "\tgithub.com/acme/sdk-go v1.5.0",
        "\tgolang.org/x/text v0.14.0 // indirect",
        ")",
      ].join("\n"),
      "tools/go.mod": "module example.com/shop/tools\n\ngo 1.22\n",
      "unused/go.mod":
        "module example.com/shop/unused\n\nrequire github.com/acme/sdk-go v1.0.0\n",
    });
    const found = await detectWorkspaces(repo, "go");
    expect(found).toEqual({
      kind: "go.work",
      packages: [
        { dir: "billing", name: "example.com/shop/billing" },
        { dir: "tools", name: "example.com/shop/tools" },
        { dir: "web", name: "example.com/shop/web" },
      ],
    });
    const { plans } = await planPackages(job(repo, "go", "github.com/acme/sdk-go"));
    expect(
      plans.map((plan) => [plan.dir, plan.job?.from ?? plan.skipped, plan.job?.package]),
    ).toEqual([
      ["billing", "v1.4.0", "billing"],
      ["tools", "it does not require github.com/acme/sdk-go", undefined],
      ["web", "v1.5.0", "web"],
    ]);
  });

  it("are every go.mod when there is no go.work, less vendored and test data, and a replaced SDK is said so", async () => {
    const repo = await repository("go-mods", {
      "go.mod": "module example.com/root\n\nrequire github.com/acme/sdk-go v1.4.0\n",
      "cmd/admin/go.mod":
        "module example.com/admin\n\nrequire github.com/acme/sdk-go v1.4.0\n\nreplace github.com/acme/sdk-go => ../../forks/sdk-go\n",
      "vendor/github.com/x/go.mod": "module github.com/x\n",
      "internal/testdata/go.mod": "module example.com/fixture\n",
    });
    const found = await detectWorkspaces(repo, "go");
    expect(found.kind).toBe("go.mod");
    expect(found.packages.map((pkg) => pkg.dir)).toEqual([".", "cmd/admin"]);
    const { plans } = await planPackages(job(repo, "go", "github.com/acme/sdk-go"));
    expect(plans.map((plan) => [plan.dir, plan.job?.from ?? plan.skipped])).toEqual([
      [".", "v1.4.0"],
      ["cmd/admin", "its go.mod replaces github.com/acme/sdk-go with ../../forks/sdk-go"],
    ]);
    // The root module's own ./... never reaches into a nested module, but
    // what is read of it by hand is told to stay out.
    expect(plans[0]?.job?.exclude).toEqual(["cmd/admin"]);
  });
});

describe("a repository that is one package", () => {
  it("is migrated from the job's from when it gives one, and from its manifest when not", async () => {
    const repo = await repository("single", {
      "package.json": manifest("app", { "@acme/sdk": "^1.4.0" }),
      "package-lock.json": {
        lockfileVersion: 3,
        packages: { "node_modules/@acme/sdk": { version: "1.4.1" } },
      },
    });
    const given = await planPackages({ ...job(repo, "typescript"), from: "1.4.0" });
    expect(
      given.plans.map((plan) => [plan.dir, plan.job?.from, plan.fromSource]),
    ).toEqual([[".", "1.4.0", "the job"]]);
    const read = await planPackages(job(repo, "typescript"));
    expect(read.plans.map((plan) => [plan.job?.from, plan.fromSource])).toEqual([
      ["1.4.1", "package-lock.json"],
    ]);
    const bare = await repository("single-bare", {
      "package.json": manifest("app", { "@acme/sdk": "^1.4.0" }),
    });
    await expect(planPackages(job(bare, "typescript"))).rejects.toThrow(
      /no lockfile or install says which release that is; name the release/,
    );
  });

  it("is what a job names by package, module, sources or tsconfig, whatever the workspaces", async () => {
    const repo = await repository("scoped", {
      "package.json": { private: true, workspaces: ["p/*"] },
      "p/a/package.json": manifest("a", { "@acme/sdk": "1.0.0" }),
      "p/b/package.json": manifest("b", { "@acme/sdk": "1.0.0" }),
    });
    const { plans } = await planPackages({ ...job(repo, "typescript"), package: "p/b" });
    expect(plans.map((plan) => [plan.dir, plan.job?.from])).toEqual([["p/b", "1.0.0"]]);
  });
});

describe("one result for the repository", () => {
  const outcome = (files: Record<string, string>, edits: number): MigrationOutcome => ({
    language: "typescript",
    files,
    manual: [
      { file: Object.keys(files)[0] ?? "x.ts", line: 1, changeId: "c", reason: "r" },
    ],
    edits,
    diagnostics: { before: 1, after: 1 },
    notes: ["checked"],
  });

  it("merges every package's edits, reports each package, and leaves a file two packages disagree on", async () => {
    const plans = [
      { dir: "a", job: { ...job("/r", "typescript"), from: "1.0.0", package: "a" } },
      { dir: "b", job: { ...job("/r", "typescript"), from: "1.1.0", package: "b" } },
      { dir: "c", job: { ...job("/r", "typescript"), from: "1.0.0", package: "c" } },
      { dir: "d", skipped: "it does not depend on @acme/sdk" },
      { dir: "e", job: { ...job("/r", "typescript"), from: "1.0.0", package: "e" } },
    ];
    const results: Record<string, MigrationOutcome> = {
      a: outcome({ "a/x.ts": "a", "shared/types.ts": "one way" }, 2),
      b: outcome({ "b/y.ts": "b", "shared/types.ts": "another way" }, 3),
      c: outcome({}, 0),
    };
    const run = async (each: MigrationJob) => {
      if (each.package === "e")
        throw new Error("could not fetch @acme/sdk@1.0.0 from npm");
      return { outcome: results[each.package ?? ""] as MigrationOutcome };
    };
    const { outcome: merged } = await migrateRepository(
      job("/r", "typescript"),
      plans,
      run,
    );
    expect(Object.keys(merged.files).sort()).toEqual(["a/x.ts", "b/y.ts"]);
    expect(merged.edits).toBe(5);
    expect(merged.manual).toHaveLength(3);
    expect(merged.diagnostics).toEqual({ before: 3, after: 3 });
    expect(merged.notes).toContain(
      "shared/types.ts: a and b edit it differently, so it is left as it is",
    );
    expect(merged.notes).toContain("a: checked");
    expect(
      merged.packages?.map((pkg) => [pkg.dir, pkg.status, pkg.reason ?? pkg.edits]),
    ).toEqual([
      ["a", "migrated", 2],
      ["b", "migrated", 3],
      ["c", "unchanged", 0],
      ["d", "skipped", "it does not depend on @acme/sdk"],
      ["e", "failed", "could not fetch @acme/sdk@1.0.0 from npm"],
    ]);
  });

  it("fails as the command when the repository is one package that fails", async () => {
    const plans = [{ dir: ".", job: { ...job("/r", "typescript"), from: "1.0.0" } }];
    await expect(
      migrateRepository(job("/r", "typescript"), plans, async () => {
        throw new Error("no registry");
      }),
    ).rejects.toThrow("no registry");
  });
});

function job(
  repo: string,
  language: RepositoryJob["language"],
  sdk = "@acme/sdk",
): RepositoryJob {
  return {
    language,
    repo,
    changes: [],
    sdk:
      language === "go"
        ? {
            module: { path: sdk },
            upgradeTo: { path: sdk, version: "v2.0.0" },
            types: {},
          }
        : {
            package: sdk,
            upgradeTo: { package: sdk, version: "2.0.0" },
            types: {},
            accessors: [],
          },
  };
}
