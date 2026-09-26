/**
 * `invariant migrate`, as a consumer runs it.
 *
 * In this process: the acme fixture's SDK releases are published to a
 * registry on this machine, and the command fetches them with npm and
 * migrates a copy of consumer A, exactly as it would from npmjs.com.
 *
 * In a sandbox: the same command with `--sandbox oci-rootless`, fetching a
 * real package from the public registry through the egress proxy and
 * analysing with no network, from this same installation mounted
 * read-only. That half needs docker or podman and the registry, and says so
 * when it skips; CI sets INVARIANT_REQUIRE_SANDBOX so it cannot.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  buildWellKnown,
  type DsseEnvelope,
  type EvolutionBundle,
  generateSigningKey,
  signBundle,
} from "@invariant-app/bundle";
import { digestOf, loadPendingChanges, loadReleaseStep } from "@invariant-app/contract";
import type { Change, JsonValue } from "@invariant-app/ir";
import { detectRuntime } from "@invariant-app/sandbox";
import { Project, ts } from "ts-morph";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkOutcome,
  engineMount,
  fetchPlanOf,
  inProcess,
  type MigrationJob,
  type MigrationOutcome,
  migrateRepository,
  planPackages,
  readJob,
  writeOutcome,
} from "./migrate.ts";

const run = promisify(execFile);
const ROOT = new URL("../../../", import.meta.url).pathname;
const MAIN = join(ROOT, "packages/cli/src/main.ts");

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "invariant-migrate-test-"));
});
afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

async function jobFile(name: string, job: Record<string, unknown>): Promise<string> {
  const path = join(scratch, `${name}.json`);
  await writeFile(path, JSON.stringify(job));
  return path;
}

const SDK = {
  package: "@acme/sdk-v1",
  upgradeTo: { package: "@acme/sdk-v3", version: "3.0.0" },
  types: {},
  accessors: [],
};

/** How the acme fixture SDK names what the acme provider's contract describes. */
const ACME_SDK = {
  package: "@acme/sdk-v1",
  upgradeTo: { package: "@acme/sdk-v3", version: "3.0.0" },
  types: {
    Charge: "Charge",
    ChargeCreateParams: "ChargeCreateParams",
    Payment: "Charge",
    PaymentCreateParams: "ChargeCreateParams",
    Refund: "Refund",
    RefundCreateParams: "RefundCreateParams",
  },
  accessors: [{ from: ["charges"], to: ["payments"] }],
  helpers: { toMinor: "toMinorUnits", fromMinor: "fromMinorUnits" },
};

describe("reading a job", () => {
  it("reads the Changes and the SDK map in, and resolves the repository", async () => {
    await writeFile(join(scratch, "sdk.json"), JSON.stringify(SDK));
    const job = await readJob(
      await jobFile("ok", {
        language: "typescript",
        repo: "consumer",
        changes: [],
        sdk: "sdk.json",
        from: "1.4.0",
        tsconfig: "./tsconfig.json",
      }),
    );
    expect(job).toMatchObject({
      repo: join(scratch, "consumer"),
      sdk: SDK,
      tsconfig: "tsconfig.json",
    });
    const { plans } = await planPackages(job);
    expect(plans).toHaveLength(1);
    expect(await fetchPlanOf(plans[0]?.job as MigrationJob)).toEqual({
      npm: [
        { name: "@acme/sdk-v1", version: "1.4.0" },
        { name: "@acme/sdk-v3", version: "3.0.0" },
      ],
      pypi: [],
    });
  });

  it.each([
    [{ language: "cobol" }, /language/],
    [{ from: "1.0.0; rm -rf /" }, /not a version/],
    [{ sdk: { ...SDK, package: "--registry=http://evil" } }, /not a package name/],
    [{ sources: ["../elsewhere.ts"] }, /inside the repository/],
    [{ sources: ["/etc/passwd"] }, /inside the repository/],
    [{ package: "../other-repo" }, /inside the repository/],
    [{ changes: undefined }, /bundle.*or changes/],
    [
      { bundle: "release.json" },
      /one of bundle, release and changes, not bundle and changes/,
    ],
    [
      { changes: undefined, release: { provider: "acme.example" } },
      /names the provider's domain and the API/,
    ],
  ])("refuses %o", async (change, message) => {
    const path = await jobFile("bad", {
      language: "typescript",
      repo: "consumer",
      changes: [],
      sdk: SDK,
      from: "1.4.0",
      ...change,
    });
    await expect(readJob(path)).rejects.toThrow(message);
  });

  it("uses a bundle's Changes only once its signature checks out", async () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKey();
    const other = generateSigningKey();
    const changes = await loadPendingChanges(
      join(ROOT, "fixtures/provider-acme/invariant"),
    );
    const bundle = {
      bundleVersion: 1,
      api: "acme",
      from: { label: "2026-03-01", digest: "sha256:0" },
      to: { label: "next", digest: "sha256:1" },
      source: { repo: "acme/api", commit: "c0ffee" },
      changes,
      evidence: [],
      compiled: { programDigest: "sha256:2" },
      gate: { result: "pass", unexplained: [] },
    } as unknown as EvolutionBundle;
    await writeFile(
      join(scratch, "release.json"),
      JSON.stringify(
        signBundle(bundle, digestOf(bundle as unknown as JsonValue), privateKeyPem),
      ),
    );
    const path = await jobFile("bundled", {
      language: "typescript",
      repo: "consumer",
      bundle: "release.json",
      sdk: SDK,
      from: "1.4.0",
    });
    await expect(readJob(path)).rejects.toThrow(/pass --key/);
    await expect(readJob(path, { keys: [other.publicKeyPem] })).rejects.toThrow();
    const job = await readJob(path, { keys: [publicKeyPem] });
    expect(job.changes.map((change) => change.id)).toEqual(
      changes.map((change) => change.id),
    );
    expect(job.changes.length).toBeGreaterThan(0);
  });

  it("reads a provider's published release with no key given, trusting only the provider's own domain", async () => {
    const changes = await loadPendingChanges(
      join(ROOT, "fixtures/provider-acme/invariant"),
    );
    const provider = generateSigningKey();
    const impostor = generateSigningKey();
    const trusted = published(changes, provider.privateKeyPem);
    const forged = published(changes, impostor.privateKeyPem);
    const path = await jobFile("released", {
      language: "typescript",
      repo: "consumer",
      release: { provider: "acme.example", api: "acme-payments" },
      sdk: SDK,
      from: "1.4.0",
    });
    const job = await readJob(path, {
      discovery: {
        fetch: providerNetwork(provider.publicKeyPem, trusted).fetch,
        service: "https://bundles.test",
      },
    });
    expect(job.changes.map((change) => change.id)).toEqual(
      changes.map((change) => change.id),
    );
    expect(job.release).toMatchObject({
      provider: "acme.example",
      api: "acme-payments",
      wellKnown: "https://acme.example/.well-known/invariant.json",
      service: "https://bundles.test",
      steps: [{ digest: trusted.digest, from: "2026-03-01", to: "next" }],
    });
    // The service serves a bundle the provider never signed: refused.
    await expect(
      readJob(path, {
        discovery: {
          fetch: providerNetwork(provider.publicKeyPem, forged).fetch,
          service: "https://bundles.test",
        },
      }),
    ).rejects.toThrow(/no key the provider vouches for signed this bundle/);
  });
});

/** A release of `changes`, signed, as the service would list and serve it. */
function published(changes: Change[], privateKeyPem: string) {
  const bundle = {
    bundleVersion: 1,
    api: "acme-payments",
    from: { label: "2026-03-01", digest: "sha256:0" },
    to: { label: "next", digest: "sha256:1" },
    source: { repo: "acme/api", commit: "c0ffee" },
    changes,
    evidence: [],
    compiled: { programDigest: "sha256:2" },
    gate: { result: "pass", unexplained: [] },
  } as unknown as EvolutionBundle;
  const digest = digestOf(bundle as unknown as JsonValue);
  return { envelope: signBundle(bundle, digest, privateKeyPem), digest };
}

/**
 * The network a consumer with no account reaches, faked: the provider's
 * domain serving its keys, and a service serving its bundles.
 */
function providerNetwork(
  publicKeyPem: string,
  release: { envelope: DsseEnvelope; digest: string },
) {
  const document = buildWellKnown({
    apis: ["acme-payments"],
    keys: [{ publicKeyPem, addedAt: "2026-01-01T00:00:00Z" }],
  });
  const answers: Record<string, unknown> = {
    "https://acme.example/.well-known/invariant.json": document,
    "https://bundles.test/public/v1/apis/acme-payments/bundles": {
      bundles: [
        {
          digest: release.digest,
          from: "2026-03-01",
          to: "next",
          keyid: release.envelope.signatures[0]?.keyid,
          publishedAt: Date.parse("2026-09-20T00:00:00Z") / 1000,
        },
      ],
    },
    [`https://bundles.test/public/v1/apis/acme-payments/bundles/${release.digest}`]:
      release.envelope,
  };
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const answer = answers[`${url.origin}${url.pathname}`];
    return answer === undefined
      ? new Response("{}", { status: 404 })
      : new Response(JSON.stringify(answer), { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch };
}

describe("what a sandbox hands back", () => {
  const outcome = (files: Record<string, unknown>): unknown => ({
    language: "typescript",
    files,
    manual: [],
    edits: 1,
    diagnostics: { before: 0, after: 0 },
    notes: [],
  });

  it.each([
    ["../outside.ts"],
    ["/etc/cron.d/job"],
    ["src/../../outside.ts"],
    [".git/hooks/pre-commit"],
    ["C:/Windows/evil"],
  ])("is refused when it names %s", (path) => {
    expect(() => checkOutcome(outcome({ [path]: "x" }), "typescript")).toThrow();
  });

  it("is refused for another job's language, or a file that is not text", () => {
    expect(() => checkOutcome(outcome({}), "python")).toThrow(
      /not an outcome of this job/,
    );
    expect(() => checkOutcome(outcome({ "a.ts": 42 }), "typescript")).toThrow(/not text/);
  });

  it("is written only inside the repository, never through a link", async () => {
    const repo = join(scratch, "writes");
    const elsewhere = join(scratch, "elsewhere");
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    await symlink(elsewhere, join(repo, "linked"));
    await writeFile(join(elsewhere, "target.ts"), "old");
    await symlink(join(elsewhere, "target.ts"), join(repo, "src", "link.ts"));

    const checked = (files: Record<string, string>) =>
      checkOutcome(outcome(files), "typescript") as MigrationOutcome;
    expect(await writeOutcome(repo, checked({ "src/a.ts": "new" }))).toEqual([
      "src/a.ts",
    ]);
    expect(await readFile(join(repo, "src/a.ts"), "utf8")).toBe("new");
    await expect(writeOutcome(repo, checked({ "linked/x.ts": "x" }))).rejects.toThrow(
      /not inside the repository/,
    );
    await expect(writeOutcome(repo, checked({ "src/link.ts": "x" }))).rejects.toThrow(
      /is a link/,
    );
    expect(await readFile(join(elsewhere, "target.ts"), "utf8")).toBe("old");
  });
});

describe("the installation a sandbox runs", () => {
  it("is this workspace, with the CLI's entry inside it", () => {
    const { dir, entry } = engineMount();
    expect(dir).toBe(ROOT.replace(/\/$/, ""));
    expect(entry).toBe("packages/cli/src/main.ts");
  });
});

/**
 * A fixture SDK as a package is published: its declarations, built from its
 * source, and a manifest pointing at them. The fixtures are TypeScript
 * source for the workspace's sake; no SDK on npm ships that way.
 */
async function publishedForm(
  dir: string,
  name: string,
  version: string,
): Promise<string> {
  const out = join(scratch, "published", name.replace("/", "+"));
  await mkdir(out, { recursive: true });
  const project = new Project({
    compilerOptions: {
      declaration: true,
      emitDeclarationOnly: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      rootDir: join(dir, "src"),
      outDir: out,
      skipLibCheck: true,
    },
  });
  project.addSourceFileAtPath(join(dir, "src/index.ts"));
  for (const file of project.emitToMemory({ emitOnlyDtsFiles: true }).getFiles()) {
    await writeFile(file.filePath, file.text);
  }
  await writeFile(join(out, "index.js"), "export {};\n");
  await writeFile(
    join(out, "package.json"),
    JSON.stringify({
      name,
      version,
      type: "module",
      types: "./index.d.ts",
      exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
    }),
  );
  return out;
}

/** An npm registry on this machine, serving packed tarballs of the fixture SDKs. */
async function fixtureRegistry(
  tarballs: { name: string; version: string; file: string }[],
) {
  const server: Server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname);
    const tarball = tarballs.find(
      (entry) => path === `/-/${entry.name}-${entry.version}.tgz`,
    );
    if (tarball) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(await readFile(tarball.file));
      return;
    }
    const name = path.slice(1);
    const versions = tarballs.filter((entry) => entry.name === name);
    if (versions.length === 0) {
      response.writeHead(404).end("{}");
      return;
    }
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const packument = {
      name,
      "dist-tags": { latest: versions.at(-1)?.version },
      versions: Object.fromEntries(
        await Promise.all(
          versions.map(async (entry) => {
            const bytes = await readFile(entry.file);
            return [
              entry.version,
              {
                name,
                version: entry.version,
                dist: {
                  tarball: `http://127.0.0.1:${port}/-/${name}-${entry.version}.tgz`,
                  integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
                },
              },
            ];
          }),
        ),
      ),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(packument));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}/` };
}

describe("invariant migrate, in this process", () => {
  let registry: Awaited<ReturnType<typeof fixtureRegistry>>;
  let consumer: string;
  let job: string;

  beforeAll(async () => {
    const packed = join(scratch, "packed");
    await mkdir(packed, { recursive: true });
    const tarballs = [];
    for (const [dir, name, version] of [
      ["sdk-acme-v1", "@acme/sdk-v1", "1.3.0"],
      ["sdk-acme-v1", "@acme/sdk-v1", "1.4.0"],
      ["sdk-acme-v3", "@acme/sdk-v3", "3.0.0"],
    ] as const) {
      const { stdout } = await run("npm", [
        "pack",
        await publishedForm(join(ROOT, "fixtures", dir), name, version),
        "--ignore-scripts",
        "--pack-destination",
        packed,
        "--json",
      ]);
      const [{ filename }] = JSON.parse(stdout) as { filename: string }[] as [
        { filename: string },
      ];
      tarballs.push({ name, version, file: join(packed, filename) });
    }
    registry = await fixtureRegistry(tarballs);

    consumer = join(scratch, "consumer-a");
    await cp(join(ROOT, "fixtures/consumer-a-sdk-v1/src"), join(consumer, "src"), {
      recursive: true,
    });
    await writeFile(
      join(consumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          module: "nodenext",
          moduleResolution: "nodenext",
          strict: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          types: [],
        },
        include: ["src/**/*.ts"],
      }),
    );
    const provider = join(ROOT, "fixtures/provider-acme/invariant");
    const changes = [
      ...(await loadReleaseStep(provider, "2026-03-01")).changes,
      ...(await loadPendingChanges(provider)),
    ];
    await writeFile(join(scratch, "changes.json"), JSON.stringify(changes));
    job = await jobFile("consumer-a", {
      language: "typescript",
      repo: "consumer-a",
      changes: "changes.json",
      sdk: ACME_SDK,
      from: "1.4.0",
    });

    // A monorepo of two copies of consumer A, one on each release of the
    // SDK, and a package that does not use it, as npm workspaces leave one.
    const mono = join(scratch, "mono");
    for (const name of ["billing", "legacy"]) {
      await cp(join(consumer, "src"), join(mono, "packages", name, "src"), {
        recursive: true,
      });
      await cp(
        join(consumer, "tsconfig.json"),
        join(mono, "packages", name, "tsconfig.json"),
      );
      await writeFile(
        join(mono, "packages", name, "package.json"),
        JSON.stringify({
          name: `@shop/${name}`,
          dependencies: { "@acme/sdk-v1": "^1.3.0" },
        }),
      );
    }
    await mkdir(join(mono, "packages/docs"), { recursive: true });
    await writeFile(
      join(mono, "packages/docs/package.json"),
      JSON.stringify({ name: "@shop/docs", dependencies: {} }),
    );
    await writeFile(
      join(mono, "package.json"),
      JSON.stringify({ name: "shop", private: true, workspaces: ["packages/*"] }),
    );
    await writeFile(
      join(mono, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "shop" },
          "node_modules/@acme/sdk-v1": { version: "1.4.0" },
          "packages/legacy/node_modules/@acme/sdk-v1": { version: "1.3.0" },
        },
      }),
    );
  }, 120_000);

  afterAll(async () => {
    if (registry) await new Promise((resolve) => registry.server.close(resolve));
  });

  it("fetches both releases from the registry and says what it would change", async () => {
    const out = join(scratch, "outcome.json");
    const before = await readFile(join(consumer, "src/billing.ts"), "utf8");
    const { stdout } = await run(process.execPath, [MAIN, "migrate", job, "--out", out], {
      env: {
        ...process.env,
        npm_config_registry: registry.url,
        npm_config_cache: join(scratch, "npm-cache"),
      },
      maxBuffer: 16 * 1024 * 1024,
    });
    const outcome = JSON.parse(await readFile(out, "utf8")) as MigrationOutcome;
    expect(Object.keys(outcome.files).sort()).toEqual([
      "src/billing.test.ts",
      "src/billing.ts",
    ]);
    expect(outcome.files["src/billing.ts"]).toMatch(/\.payments\./);
    expect(outcome.edits).toBeGreaterThan(0);
    expect(outcome.manual.some((site) => site.reason.includes("succeeded"))).toBe(true);
    expect(stdout).toContain("ran in: this process, with no sandbox");
    expect(stdout).toContain("written: nothing");
    // A dry run is a dry run.
    expect(await readFile(join(consumer, "src/billing.ts"), "utf8")).toBe(before);
  }, 180_000);

  it("migrates a monorepo package by package, each from its own release, into one result", async () => {
    const path = await jobFile("mono", {
      language: "typescript",
      repo: "mono",
      changes: "changes.json",
      sdk: ACME_SDK,
    });
    const out = join(scratch, "mono-outcome.json");
    const { stdout } = await run(
      process.execPath,
      [MAIN, "migrate", path, "--out", out],
      {
        env: {
          ...process.env,
          npm_config_registry: registry.url,
          npm_config_cache: join(scratch, "npm-cache"),
        },
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const outcome = JSON.parse(await readFile(out, "utf8")) as MigrationOutcome;
    expect(Object.keys(outcome.files).sort()).toEqual([
      "packages/billing/src/billing.test.ts",
      "packages/billing/src/billing.ts",
      "packages/legacy/src/billing.test.ts",
      "packages/legacy/src/billing.ts",
    ]);
    expect(outcome.files["packages/legacy/src/billing.ts"]).toMatch(/\.payments\./);
    expect(
      outcome.packages?.map((pkg) => [pkg.dir, pkg.status, pkg.from, pkg.fromSource]),
    ).toEqual([
      [".", "skipped", undefined, undefined],
      ["packages/billing", "migrated", "1.4.0", "package-lock.json"],
      ["packages/docs", "skipped", undefined, undefined],
      ["packages/legacy", "migrated", "1.3.0", "package-lock.json"],
    ]);
    expect(outcome.edits).toBe(
      (outcome.packages ?? []).reduce((sum, pkg) => sum + pkg.edits, 0),
    );
    expect(stdout).toContain("@acme/sdk-v1 -> @acme/sdk-v3 3.0.0");
    expect(stdout).toMatch(
      /packages\/legacy \(1\.3\.0, from package-lock\.json\): \d+ edits in 2 files/,
    );
    expect(stdout).toContain(
      "packages/docs: skipped, it does not depend on @acme/sdk-v1",
    );
  }, 300_000);

  it("migrates a monorepo from a provider's published release, with no account and no key", async () => {
    const changes = JSON.parse(await readFile(join(scratch, "changes.json"), "utf8"));
    const provider = generateSigningKey();
    const path = await jobFile("mono-released", {
      language: "typescript",
      repo: "mono",
      release: {
        provider: "acme.example",
        api: "acme-payments",
        service: "https://bundles.test",
      },
      sdk: ACME_SDK,
    });
    const job = await readJob(path, {
      discovery: {
        fetch: providerNetwork(
          provider.publicKeyPem,
          published(changes, provider.privateKeyPem),
        ).fetch,
      },
    });
    const { plans } = await planPackages(job);
    const saved = { ...process.env };
    process.env["npm_config_registry"] = registry.url;
    process.env["npm_config_cache"] = join(scratch, "npm-cache");
    const runner = inProcess();
    try {
      const { outcome } = await migrateRepository(job, plans, async (each) => ({
        outcome: await runner.run(each),
      }));
      expect(outcome.release?.steps.map((step) => step.to)).toEqual(["next"]);
      expect(
        outcome.packages
          ?.filter((pkg) => pkg.status === "migrated")
          .map((pkg) => [pkg.dir, pkg.from]),
      ).toEqual([
        ["packages/billing", "1.4.0"],
        ["packages/legacy", "1.3.0"],
      ]);
      expect(outcome.files["packages/billing/src/billing.ts"]).toMatch(/\.payments\./);
    } finally {
      await runner.close();
      process.env = saved;
    }
  }, 300_000);
});

const required = process.env["INVARIANT_REQUIRE_SANDBOX"] === "1";
const runtime = await detectRuntime();
const online = await lookup("registry.npmjs.org").then(
  () => true,
  () => false,
);
const hasGo = await run("go", ["version"]).then(
  () => true,
  () => false,
);
const offline = online ? "" : " (skipped: the registries cannot be reached from here)";

/**
 * Python and Go, end to end against the real registries: each job fetches
 * two releases of a small real package and reads a consumer against both,
 * with the analysis offline, as it is in a sandbox. There are no Changes;
 * what is proved is the fetch, the layout it leaves, and the analysis
 * finding its releases there without the network.
 */
describe("invariant migrate, for Python and Go", () => {
  it.skipIf(!online)(
    `fetches wheels from PyPI and checks the consumer against both${offline}`,
    async () => {
      const consumer = join(scratch, "py-consumer");
      await mkdir(consumer, { recursive: true });
      await writeFile(
        join(consumer, "app.py"),
        'import idna\n\nprint(idna.encode("example.com"))\n',
      );
      const path = await jobFile("py", {
        language: "python",
        repo: "py-consumer",
        changes: [],
        sdk: {
          package: "idna",
          upgradeTo: { package: "idna", version: "3.7" },
          types: {},
        },
        from: "3.6",
      });
      const out = join(scratch, "py-outcome.json");
      await run(process.execPath, [MAIN, "migrate", path, "--out", out]);
      expect(JSON.parse(await readFile(out, "utf8"))).toMatchObject({
        language: "python",
        files: {},
        edits: 0,
        diagnostics: { before: 0, after: 0 },
      });
    },
    300_000,
  );

  const noGo = hasGo ? offline : " (skipped: there is no Go toolchain here)";
  it.skipIf(noGo !== "")(
    `fetches modules through the Go proxy and reads the consumer offline${noGo}`,
    async () => {
      const consumer = join(scratch, "go-consumer");
      await mkdir(consumer, { recursive: true });
      const { stdout } = await run(
        "go",
        ["mod", "download", "-json", "github.com/google/uuid@v1.5.0"],
        {
          env: {
            ...process.env,
            GOMODCACHE: join(scratch, "go-sums"),
            GOFLAGS: "-modcacherw",
          },
        },
      );
      const sums = JSON.parse(stdout) as { Sum: string; GoModSum: string };
      await writeFile(
        join(consumer, "go.mod"),
        "module example.com/consumer\n\ngo 1.22\n\nrequire github.com/google/uuid v1.5.0\n",
      );
      await writeFile(
        join(consumer, "go.sum"),
        `github.com/google/uuid v1.5.0 ${sums.Sum}\ngithub.com/google/uuid v1.5.0/go.mod ${sums.GoModSum}\n`,
      );
      await writeFile(
        join(consumer, "main.go"),
        'package main\n\nimport "github.com/google/uuid"\n\nfunc main() { println(uuid.NewString()) }\n',
      );
      const path = await jobFile("go", {
        language: "go",
        repo: "go-consumer",
        changes: [],
        sdk: {
          module: { path: "github.com/google/uuid" },
          upgradeTo: { path: "github.com/google/uuid", version: "v1.6.0" },
          types: {},
        },
        from: "v1.5.0",
      });
      const out = join(scratch, "go-outcome.json");
      await run(process.execPath, [MAIN, "migrate", path, "--out", out], {
        maxBuffer: 16 * 1024 * 1024,
      });
      const outcome = JSON.parse(await readFile(out, "utf8")) as MigrationOutcome;
      expect(outcome).toMatchObject({ language: "go", edits: 0, manual: [] });
      expect(outcome.diagnostics).toEqual({ before: 0, after: 0 });
      // Checked against the new release, go.mod and go.sum move to it.
      expect(outcome.files["go.mod"]).toContain("github.com/google/uuid v1.6.0");
    },
    600_000,
  );

  it.skipIf(!online)(
    `migrates a Python monorepo per pyproject.toml, each from the release it pins${offline}`,
    async () => {
      const mono = join(scratch, "py-mono");
      for (const [name, pinned] of [
        ["api", "3.6"],
        ["worker", "3.7"],
      ] as const) {
        await mkdir(join(mono, name), { recursive: true });
        await writeFile(
          join(mono, name, "pyproject.toml"),
          `[project]\nname = "${name}"\nversion = "0.1.0"\ndependencies = ["idna==${pinned}"]\n`,
        );
        await writeFile(
          join(mono, name, "app.py"),
          'import idna\n\nprint(idna.encode("example.com"))\n',
        );
      }
      const path = await jobFile("py-mono", {
        language: "python",
        repo: "py-mono",
        changes: [],
        sdk: {
          package: "idna",
          upgradeTo: { package: "idna", version: "3.7" },
          types: {},
        },
      });
      const out = join(scratch, "py-mono-outcome.json");
      await run(process.execPath, [MAIN, "migrate", path, "--out", out], {
        maxBuffer: 16 * 1024 * 1024,
      });
      const outcome = JSON.parse(await readFile(out, "utf8")) as MigrationOutcome;
      expect(outcome.packages?.map((pkg) => [pkg.dir, pkg.status, pkg.from])).toEqual([
        ["api", "unchanged", "3.6"],
        ["worker", "unchanged", "3.7"],
      ]);
      expect(outcome.diagnostics).toEqual({ before: 0, after: 0 });
    },
    600_000,
  );

  it.skipIf(noGo !== "")(
    `migrates the modules of a go.work, each from the release its go.mod requires${noGo}`,
    async () => {
      const mono = join(scratch, "go-mono");
      const sums: string[] = [];
      for (const version of ["v1.4.0", "v1.5.0"]) {
        const { stdout } = await run(
          "go",
          ["mod", "download", "-json", `github.com/google/uuid@${version}`],
          {
            env: {
              ...process.env,
              GOMODCACHE: join(scratch, "go-sums"),
              GOFLAGS: "-modcacherw",
            },
          },
        );
        const sum = JSON.parse(stdout) as { Sum: string; GoModSum: string };
        sums.push(
          `github.com/google/uuid ${version} ${sum.Sum}\ngithub.com/google/uuid ${version}/go.mod ${sum.GoModSum}\n`,
        );
      }
      for (const [index, [name, version]] of (
        [
          ["orders", "v1.4.0"],
          ["refunds", "v1.5.0"],
        ] as const
      ).entries()) {
        await mkdir(join(mono, name), { recursive: true });
        await writeFile(
          join(mono, name, "go.mod"),
          `module example.com/${name}\n\ngo 1.22\n\nrequire github.com/google/uuid ${version}\n`,
        );
        await writeFile(join(mono, name, "go.sum"), sums[index] ?? "");
        await writeFile(
          join(mono, name, "main.go"),
          'package main\n\nimport "github.com/google/uuid"\n\nfunc main() { println(uuid.NewString()) }\n',
        );
      }
      await writeFile(
        join(mono, "go.work"),
        "go 1.22\n\nuse (\n\t./orders\n\t./refunds\n)\n",
      );
      const path = await jobFile("go-mono", {
        language: "go",
        repo: "go-mono",
        changes: [],
        sdk: {
          module: { path: "github.com/google/uuid" },
          upgradeTo: { path: "github.com/google/uuid", version: "v1.6.0" },
          types: {},
        },
      });
      const out = join(scratch, "go-mono-outcome.json");
      await run(process.execPath, [MAIN, "migrate", path, "--out", out], {
        maxBuffer: 16 * 1024 * 1024,
      });
      const outcome = JSON.parse(await readFile(out, "utf8")) as MigrationOutcome;
      expect(outcome.packages?.map((pkg) => [pkg.dir, pkg.from, pkg.fromSource])).toEqual(
        [
          ["orders", "v1.4.0", "orders/go.mod"],
          ["refunds", "v1.5.0", "refunds/go.mod"],
        ],
      );
      // Each module moves to the new release in its own go.mod, in one result.
      expect(outcome.files["orders/go.mod"]).toContain("github.com/google/uuid v1.6.0");
      expect(outcome.files["refunds/go.mod"]).toContain("github.com/google/uuid v1.6.0");
      expect(outcome.diagnostics).toEqual({ before: 0, after: 0 });
    },
    900_000,
  );
});
if (required && (!runtime || !online)) {
  throw new Error(
    "INVARIANT_REQUIRE_SANDBOX is set, and there is no runtime or no registry",
  );
}
const why = !runtime
  ? " (skipped: neither docker nor podman is running here)"
  : !online
    ? " (skipped: the registries cannot be reached from here)"
    : "";

describe("invariant migrate --sandbox oci-rootless", () => {
  it.skipIf(why !== "")(
    `fetches through the egress proxy and analyses with no network${why}`,
    async () => {
      const consumer = join(scratch, "tiny");
      await mkdir(join(consumer, "src"), { recursive: true });
      await writeFile(
        join(consumer, "src/check.ts"),
        'import invariant from "tiny-invariant";\n\nexport function check(value: unknown): void {\n  invariant(value, "a value");\n}\n',
      );
      await writeFile(join(consumer, "package.json"), JSON.stringify({ type: "module" }));
      await writeFile(
        join(consumer, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            module: "nodenext",
            moduleResolution: "nodenext",
            strict: true,
            noEmit: true,
            types: [],
          },
          include: ["src/**/*.ts"],
        }),
      );
      const path = await jobFile("tiny", {
        language: "typescript",
        repo: "tiny",
        changes: [],
        sdk: {
          package: "tiny-invariant",
          upgradeTo: { package: "tiny-invariant", version: "1.3.3" },
          types: {},
          accessors: [],
        },
        from: "1.3.1",
      });
      const out = join(scratch, "tiny-outcome.json");
      const { stdout } = await run(
        process.execPath,
        [MAIN, "migrate", path, "--sandbox", "oci-rootless", "--out", out],
        { maxBuffer: 16 * 1024 * 1024 },
      );
      const outcome = JSON.parse(await readFile(out, "utf8")) as MigrationOutcome;
      expect(outcome).toMatchObject({
        language: "typescript",
        files: {},
        manual: [],
        edits: 0,
        diagnostics: { before: 0, after: 0 },
      });
      expect(stdout).toMatch(/ran in: oci-rootless \(fetch [\d.]+s, analyse [\d.]+s\)/);
    },
    300_000,
  );
});
