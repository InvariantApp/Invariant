/**
 * Historical builds stood up from where a provider actually keeps them: an
 * environment already running, or the commit the contract was released from.
 * Starting every old contract from the current code by an environment switch
 * works only for a repository written for that, which is a fixture's.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BuildConfig, BuildSource } from "./config.ts";
import { launchBuild } from "./launch.ts";

const build = (contracts: [string, BuildSource][]): BuildConfig => ({
  command: "node",
  args: ["server.mjs"],
  headEnv: {},
  baseEnv: {},
  healthPath: "/__health",
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
