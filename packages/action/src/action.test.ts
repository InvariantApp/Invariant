/**
 * The action, on a simulated runner: a real repository set up by `init`, a
 * pull request that breaks something, the files GitHub provides, and a
 * recorded GitHub API.
 *
 * The action it replaces called `npx @invariant/cli`, which could not have
 * run, and installed a Go toolchain first. What is proved here is what a
 * provider sees: the verdict, the comment, the annotations on the file that
 * caused it, and a fork's read-only token not turning a verdict into an error.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMENT_MARKER, init } from "@invariant/cli";
import { oasdiffAvailable, oasdiffBinary } from "@invariant/diff";
import { afterEach, describe, expect, it } from "vitest";
import { type Env, runAction } from "./index.ts";

const FIXTURE = new URL("../../../fixtures/provider-acme/", import.meta.url).pathname;
const hasOasdiff = await oasdiffAvailable();
// Resolved once, before any run: the action points OASDIFF_BIN at whatever it
// used, and a test must not inherit that from the one before it.
const OASDIFF = oasdiffBinary();
const ORIGINAL = process.env["OASDIFF_BIN"];

let scratch: string | undefined;
afterEach(async () => {
  if (ORIGINAL === undefined) delete process.env["OASDIFF_BIN"];
  else process.env["OASDIFF_BIN"] = ORIGINAL;
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

interface Call {
  method: string;
  url: string;
  body?: string;
}

/** A GitHub API that records what it was asked and answers as scripted. */
function github(existing: { id: number; body: string }[] | "forbidden") {
  const calls: Call[] = [];
  const send = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? "GET", url: String(url) };
    if (typeof init?.body === "string") call.body = init.body;
    calls.push(call);
    if (existing === "forbidden") return new Response("{}", { status: 403 });
    if (call.method === "GET") return Response.json(existing);
    return Response.json({ id: 99 }, { status: call.method === "POST" ? 201 : 200 });
  }) as typeof fetch;
  return { send, calls };
}

/** A repository whose pull request removes a response field every caller reads. */
async function brokenPullRequest(): Promise<{ workspace: string; env: Env }> {
  scratch = await mkdtemp(join(tmpdir(), "invariant-action-"));
  const workspace = join(scratch, "repo");
  const runner = join(scratch, "runner");
  await mkdir(join(workspace, "api"), { recursive: true });
  await mkdir(runner, { recursive: true });

  const spec = await readFile(join(FIXTURE, "openapi/head.json"), "utf8");
  await writeFile(join(workspace, "api/openapi.json"), spec, "utf8");
  await init({ root: workspace, label: "2026-09-01", ci: "none" });

  const document = JSON.parse(spec);
  delete document.components.schemas.Payment.properties.currency;
  document.components.schemas.Payment.required =
    document.components.schemas.Payment.required.filter(
      (name: string) => name !== "currency",
    );
  await writeFile(
    join(workspace, "api/openapi.json"),
    JSON.stringify(document, null, 2),
    "utf8",
  );

  const event = join(runner, "event.json");
  await writeFile(event, JSON.stringify({ pull_request: { number: 42 } }), "utf8");
  await writeFile(join(runner, "summary.md"), "", "utf8");
  await writeFile(join(runner, "output"), "", "utf8");

  return {
    workspace,
    env: {
      GITHUB_WORKSPACE: workspace,
      GITHUB_EVENT_PATH: event,
      GITHUB_REPOSITORY: "acme/payments-api",
      GITHUB_API_URL: "https://api.github.test",
      GITHUB_STEP_SUMMARY: join(runner, "summary.md"),
      GITHUB_OUTPUT: join(runner, "output"),
      RUNNER_TEMP: runner,
      INPUT_TOKEN: "ghs_test",
      OASDIFF_BIN: OASDIFF,
    },
  };
}

describe.skipIf(!hasOasdiff)("the GitHub Action", () => {
  it("blocks the pull request and says why, in every place a reviewer looks", async () => {
    const { env, workspace } = await brokenPullRequest();
    const { send, calls } = github([]);
    const lines: string[] = [];

    const result = await runAction(env, { fetch: send, log: (line) => lines.push(line) });

    expect(result.exitCode).toBe(1);
    expect(result.comment).toBe("created");

    const posted = calls.find((call) => call.method === "POST");
    expect(posted?.url).toBe(
      "https://api.github.test/repos/acme/payments-api/issues/42/comments",
    );
    const body = JSON.parse(posted?.body ?? "{}").body as string;
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(body).toContain("## Not safe to merge");
    expect(body).toContain("currency");

    // Beside the operation that caused it, in the pull request's diff view.
    const written = await readFile(join(workspace, "api/openapi.json"), "utf8");
    const annotated = lines.filter((line) =>
      line.startsWith("::error file=api/openapi.json,"),
    );
    expect(annotated.length).toBeGreaterThan(0);
    for (const line of annotated.filter((entry) => entry.includes("line="))) {
      const at = Number(/line=(\d+)/.exec(line)?.[1]);
      expect(written.split("\n")[at - 1]).toMatch(/^\s*"\/v1\//);
    }
    expect(annotated.some((line) => line.includes("line="))).toBe(true);

    expect(await readFile(env["GITHUB_OUTPUT"] as string, "utf8")).toContain(
      "result=block",
    );
    expect(await readFile(env["GITHUB_STEP_SUMMARY"] as string, "utf8")).toContain(
      "Not safe to merge",
    );
  });

  it("edits its own comment on the next push instead of adding another", async () => {
    const { env } = await brokenPullRequest();
    const { send, calls } = github([
      { id: 1, body: "a reviewer's own comment" },
      { id: 7, body: `${COMMENT_MARKER}\n\nthe last run` },
    ]);

    const result = await runAction(env, { fetch: send, log: () => {} });
    expect(result.comment).toBe("updated");
    const patched = calls.find((call) => call.method === "PATCH");
    expect(patched?.url).toBe(
      "https://api.github.test/repos/acme/payments-api/issues/comments/7",
    );
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("still gives its verdict when a fork's token cannot comment", async () => {
    const { env } = await brokenPullRequest();
    const { send } = github("forbidden");
    const lines: string[] = [];

    const result = await runAction(env, { fetch: send, log: (line) => lines.push(line) });
    expect(result.exitCode).toBe(1);
    expect(result.comment).toBe("not-permitted");
    expect(
      lines.some((line) => line.startsWith("::notice title=Comment not written")),
    ).toBe(true);
  });

  it("passes and comments nothing when asked not to", async () => {
    const { workspace, env } = await brokenPullRequest();
    await writeFile(
      join(workspace, "api/openapi.json"),
      await readFile(join(FIXTURE, "openapi/head.json"), "utf8"),
      "utf8",
    );
    const { send, calls } = github([]);
    const result = await runAction(
      { ...env, INPUT_COMMENT: "false" },
      { fetch: send, log: () => {} },
    );
    expect(result.exitCode).toBe(0);
    expect(result.report.result).toBe("pass");
    expect(calls).toEqual([]);
  });

  /**
   * The file GitHub actually runs, rather than the source it was built from.
   * Run with no comment, so no API is reached, and read back through the same
   * output file a workflow reads.
   */
  it("runs as the bundled file GitHub executes", async () => {
    const { env } = await brokenPullRequest();
    const bundle = new URL("../bundle/main.js", import.meta.url).pathname;
    const outcome = await new Promise<{ code: number | null; stdout: string }>((done) => {
      const child = spawn(process.execPath, [bundle], {
        env: {
          PATH: process.env["PATH"],
          ...env,
          INPUT_COMMENT: "false",
        } as NodeJS.ProcessEnv,
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.on("close", (code) => done({ code, stdout }));
    });

    expect(outcome.code).toBe(1);
    expect(outcome.stdout).toContain("::error file=api/openapi.json,");
    expect(await readFile(env["GITHUB_OUTPUT"] as string, "utf8")).toContain(
      "result=block",
    );
  });
});
