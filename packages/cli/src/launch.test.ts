/**
 * Historical builds stood up from where a provider actually keeps them: an
 * environment already running, or the commit the contract was released from.
 * Starting every old contract from the current code by an environment switch
 * works only for a repository written for that, which is a fixture's.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chainProgram } from "@invariant-app/compiler";
import type { OpenApiDocument } from "@invariant-app/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BuildConfig, BuildSource } from "./config.ts";
import { launchBuild } from "./launch.ts";

const build = (contracts: [string, BuildSource][]): BuildConfig => ({
  command: "node",
  args: ["server.mjs"],
  headEnv: {},
  headSource: undefined,
  proxy: false,
  baseEnv: {},
  base: undefined,
  healthPath: "/__health",
  readyTimeoutMs: 30_000,
  startPer: "scenario",
  contracts: new Map(contracts),
});

/** A server that says which version of it is running. */
const server = (version: string) => `import { createServer } from "node:http";
createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ version: ${JSON.stringify(version)}, contract: process.env.CONTRACT ?? null }));
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

describe("a build that is already running", () => {
  let running: Server;
  let url: string;
  beforeAll(async () => {
    running = createServer((request, response) => {
      response.end(request.url === "/__health" ? "ok" : `seen ${request.url}`);
    });
    await new Promise<void>((resolve) => running.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(running.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => running.close(() => resolve())));

  it("is reached where it is, and never stopped", async () => {
    const target = await launchBuild("2026-01-01", {
      build: build([["2026-01-01", { kind: "url", url }]]),
      cwd: tmpdir(),
    });
    const response = await target.fetch(new Request("http://x/v1/items?page=2"));
    expect(await response.text()).toBe("seen /v1/items?page=2");
    await target.close();
    // Still answering: closing a target it did not start does nothing.
    expect((await fetch(`${url}/__health`)).ok).toBe(true);
  });

  it("says which one did not answer", async () => {
    await expect(
      launchBuild("2026-01-01", {
        build: build([["2026-01-01", { kind: "url", url: "http://127.0.0.1:9" }]]),
        cwd: tmpdir(),
        timeoutMs: 300,
      }),
    ).rejects.toThrow(/2026-01-01: http:\/\/127\.0\.0\.1:9/);
  });
});

describe("a build from the commit a contract was released from", () => {
  let repository: string;
  let released: string;
  beforeAll(() => {
    repository = mkdtempSync(join(tmpdir(), "invariant-repo-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    writeFileSync(join(repository, "server.mjs"), server("released"));
    git("add", ".");
    git("commit", "-qm", "released");
    released = git("rev-parse", "HEAD");
    writeFileSync(join(repository, "server.mjs"), server("current"));
    git("commit", "-qam", "current");
  });

  it("runs the released code, not the current code, with the contract filled in", async () => {
    const target = await launchBuild("2026-01-01", {
      build: build([
        [
          "2026-01-01",
          {
            kind: "worktree",
            ref: released,
            install: { command: "node", args: ["-e", "0"] },
            command: "node",
            args: ["server.mjs"],
            env: { CONTRACT: `\${contract}` },
          },
        ],
      ]),
      cwd: repository,
    });
    try {
      const response = await target.fetch(new Request("http://x/anything"));
      expect(await response.json()).toEqual({
        version: "released",
        contract: "2026-01-01",
      });
    } finally {
      await target.close();
    }
    const head = await launchBuild("head", { build: build([]), cwd: repository });
    try {
      const response = await head.fetch(new Request("http://x/anything"));
      expect(await response.json()).toMatchObject({ version: "current" });
    } finally {
      await head.close();
    }
  });

  it("says what went wrong when the commit does not exist", async () => {
    await expect(
      launchBuild("2025-01-01", {
        build: build([
          [
            "2025-01-01",
            {
              kind: "worktree",
              ref: "no-such-ref",
              install: undefined,
              command: "node",
              args: ["server.mjs"],
              env: {},
            },
          ],
        ]),
        cwd: repository,
      }),
    ).rejects.toThrow(/could not check out no-such-ref/);
  });
});

describe("a released build started from the current code", () => {
  let repository: string;
  beforeAll(() => {
    repository = mkdtempSync(join(tmpdir(), "invariant-base-"));
    writeFileSync(join(repository, "server.mjs"), server("head"));
    writeFileSync(join(repository, "legacy.mjs"), server("started as a released build"));
  });
  afterAll(() => rmSync(repository, { recursive: true, force: true }));

  it("is started with build.base.command, and the current build with the head's", async () => {
    const config: BuildConfig = {
      ...build([]),
      base: { command: "node", args: ["legacy.mjs"] },
      baseEnv: { CONTRACT: `\${contract}` },
    };
    const old = await launchBuild("2026-01-01", { build: config, cwd: repository });
    try {
      expect(await (await old.fetch(new Request("http://x/"))).json()).toEqual({
        version: "started as a released build",
        contract: "2026-01-01",
      });
    } finally {
      await old.close();
    }
    const head = await launchBuild("head", { build: config, cwd: repository });
    try {
      expect(await (await head.fetch(new Request("http://x/"))).json()).toMatchObject({
        version: "head",
      });
    } finally {
      await head.close();
    }
  });
});

describe("the current build behind the proxy", () => {
  const item = (field: string) => ({
    openapi: "3.1.0",
    info: { title: "items", version: "1" },
    paths: {
      "/item": {
        get: {
          operationId: "getItem",
          responses: {
            "200": {
              description: "the item",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Item" },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Item: {
          type: "object",
          required: [field],
          properties: { [field]: { type: "string" } },
        },
      },
    },
  });

  let repository: string;
  beforeAll(() => {
    repository = mkdtempSync(join(tmpdir(), "invariant-proxied-"));
    writeFileSync(
      join(repository, "server.mjs"),
      `import { createServer } from "node:http";
createServer((request, response) => {
  // As NetBox's server does: a body with no length is refused.
  if (request.method === "POST" && request.headers["content-length"] === undefined) {
    response.statusCode = 411;
    response.end();
    return;
  }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(request.url === "/__health" ? {} : { title: "a kettle" }));
}).listen(Number(process.env.PORT), "127.0.0.1");
`,
    );
  });
  afterAll(() => rmSync(repository, { recursive: true, force: true }));

  it("runs the program this check compiled, so an old caller is answered in its own shape", async () => {
    const { program } = chainProgram(
      "items",
      "2026-06-01",
      "sha256:0",
      [
        {
          label: "2026-06-01",
          parent: "2026-01-01",
          from: item("name") as OpenApiDocument,
          to: item("title") as OpenApiDocument,
          changes: [
            {
              irVersion: 1,
              id: "chg_name_became_title",
              summary: "An item's name is now its title.",
              scopes: [{ schema: "#/components/schemas/Item" }],
              ops: [{ op: "move", from: "/name", to: "/title" }],
            },
          ],
        },
      ],
      { identity: [{ kind: "default", label: "2026-01-01" }] },
    );
    const config: BuildConfig = { ...build([]), proxy: true };

    const bare = await launchBuild("head", {
      build: { ...config, proxy: false },
      cwd: repository,
    });
    try {
      expect(await (await bare.fetch(new Request("http://x/item"))).json()).toEqual({
        title: "a kettle",
      });
    } finally {
      await bare.close();
    }

    const proxied = await launchBuild("head", {
      build: config,
      cwd: repository,
      program,
    });
    try {
      expect(await (await proxied.fetch(new Request("http://x/item"))).json()).toEqual({
        name: "a kettle",
      });
      // Sent with its length, as a caller's request reaches the proxy.
      const posted = await proxied.fetch(
        new Request("http://x/item", { method: "POST", body: "{}" }),
      );
      expect(posted.status).toBe(200);
    } finally {
      await proxied.close();
    }
  });

  it("refuses to compare without a program to run", async () => {
    await expect(
      launchBuild("head", { build: { ...build([]), proxy: true }, cwd: repository }),
    ).rejects.toThrow(/compiled no program/);
  });
});
