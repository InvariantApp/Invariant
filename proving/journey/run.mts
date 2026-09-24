/**
 * L9, the journey a provider takes on their first day, timed: from nothing
 * to a pull request whose check blocks a breaking change.
 *
 *   1. clone the scratch provider (an API and nothing else of ours);
 *   2. `npm install @invariant-app/cli` from the public registry;
 *   3. `npx @invariant-app/cli init`, which must end in a passing first check
 *      and write exactly the workflow the scratch repository already runs;
 *   4. push that as a base branch, and a head branch that removes a field;
 *   5. open the pull request and wait for the check GitHub runs on it to
 *      conclude, which must be a failure: the release is blocked.
 *
 * The clock runs from step 1 to the check's conclusion. The branches and the
 * pull request are removed afterwards whatever happened.
 *
 *   GH_TOKEN=<installation token> node --import tsx proving/journey/run.mts --out result.json
 *
 * With the Go toolchain off the PATH, as on a provider's laptop.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const REPO = process.env["JOURNEY_REPO"] ?? "InvariantApp/l9-provider";
const TOKEN = process.env["GH_TOKEN"];
const WINDOWS = process.platform === "win32";
/** A check that has not concluded by then has failed the journey. */
const DEADLINE_MS = 20 * 60_000;
const out = process.argv[process.argv.indexOf("--out") + 1];
if (!TOKEN)
  throw new Error("GH_TOKEN must hold a token that can push to the scratch repository");
if (!out || process.argv.indexOf("--out") === -1)
  throw new Error("usage: run.mts --out <file>");

export interface JourneyResult {
  os: string;
  runner: string | undefined;
  at: string;
  /** From the clone to the check's conclusion. */
  seconds: number;
  /** Each step's end, in seconds from the start. */
  steps: Record<string, number>;
  conclusion: string | undefined;
  ok: boolean;
  problem?: string;
}

const started = Date.now();
const steps: Record<string, number> = {};
const mark = (name: string) => {
  steps[name] = Math.round((Date.now() - started) / 100) / 10;
  process.stdout.write(`[${steps[name]}s] ${name}\n`);
};

const env: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: (process.env["PATH"] ?? "")
    .split(delimiter)
    .filter((entry) => !/[\\/]go[\\/]bin$|[\\/]go$/.test(entry))
    .join(delimiter),
  NO_COLOR: "1",
};
delete env["OASDIFF_BIN"];

async function sh(cwd: string, command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run(command, args, {
      cwd,
      env,
      // npm and npx are `.cmd` shims on Windows, which only a shell runs; a
      // shell joins arguments unquoted, so nothing else is given one: a
      // commit message would reach git as one path per word.
      shell: WINDOWS && (command === "npm" || command === "npx"),
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    // The token is in the clone URL; it never reaches a message.
    const text = `${failure.stdout ?? ""}${failure.stderr ?? ""}`.replaceAll(
      TOKEN as string,
      "***",
    );
    throw new Error(`${command} ${args[0]} failed:\n${text}`);
  }
}

async function github<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok && response.status !== 404 && response.status !== 422) {
    throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

const tag = `${process.env["GITHUB_RUN_ID"] ?? `local-${Date.now()}`}-${process.env["GITHUB_RUN_ATTEMPT"] ?? "1"}-${process.env["JOURNEY_INDEX"] ?? "0"}-${process.platform}`;
const base = `l9/${tag}/base`;
const head = `l9/${tag}/head`;
const work = await mkdtemp(join(tmpdir(), "invariant-journey-"));
let pull: number | undefined;
const result: JourneyResult = {
  os: process.platform,
  runner: process.env["RUNNER_OS"],
  at: new Date().toISOString(),
  seconds: 0,
  steps,
  conclusion: undefined,
  ok: false,
};

try {
  const repo = join(work, "provider");
  await sh(work, "git", [
    "clone",
    "--depth",
    "1",
    `https://x-access-token:${TOKEN}@github.com/${REPO}.git`,
    repo,
  ]);
  await sh(repo, "git", ["config", "user.name", "invariant-journey"]);
  await sh(repo, "git", ["config", "user.email", "journey@users.noreply.github.com"]);
  mark("cloned");

  await sh(repo, "npm", ["install", "--no-audit", "--no-fund", "@invariant-app/cli"]);
  mark("installed from npm");

  const today = new Date().toISOString().slice(0, 10);
  const first = await sh(repo, "npx", ["@invariant-app/cli", "init", "--label", today]);
  if (!first.includes("First check: PASS"))
    throw new Error(`init did not pass:\n${first}`);
  // The scratch repository runs the workflow init writes, byte for byte: a
  // journey that passed on some other workflow would prove nothing.
  const changed = await sh(repo, "git", ["status", "--porcelain", "--", ".github"]);
  if (changed.trim() !== "") {
    throw new Error(
      `init wrote a workflow other than the one the scratch repository runs:\n${changed}`,
    );
  }
  mark("init passed");

  await sh(repo, "git", ["checkout", "-q", "-b", base]);
  await sh(repo, "git", ["add", "-A"]);
  await sh(repo, "git", ["commit", "-qm", "Adopt Invariant"]);
  await sh(repo, "git", ["push", "-q", "origin", base]);

  await sh(repo, "git", ["checkout", "-q", "-b", head]);
  const specPath = join(repo, "api/openapi.json");
  const spec = JSON.parse(await readFile(specPath, "utf8"));
  delete spec.components.schemas.Payment.properties.currency;
  spec.components.schemas.Payment.required =
    spec.components.schemas.Payment.required.filter(
      (name: string) => name !== "currency",
    );
  await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  await sh(repo, "git", ["commit", "-qam", "Drop currency from Payment"]);
  await sh(repo, "git", ["push", "-q", "origin", head]);
  const sha = (await sh(repo, "git", ["rev-parse", "HEAD"])).trim();
  mark("pushed");

  const opened = await github<{ number: number }>("POST", `/repos/${REPO}/pulls`, {
    title: `L9 journey ${tag}`,
    head,
    base,
    body: "Opened and closed by the L9 journey in InvariantApp/Invariant.",
  });
  pull = opened.number;
  mark("pull request opened");

  for (;;) {
    const runs = await github<{
      check_runs: { name: string; status: string; conclusion: string | null }[];
    }>("GET", `/repos/${REPO}/commits/${sha}/check-runs?check_name=check`);
    const check = runs.check_runs[0];
    // When a runner took the check up: what comes before it is GitHub's
    // queue, not the product, and the report can tell the two apart.
    if (check !== undefined && check.status !== "queued" && !("check started" in steps)) {
      mark("check started");
    }
    if (check?.status === "completed") {
      result.conclusion = check.conclusion ?? undefined;
      break;
    }
    if (Date.now() - started > DEADLINE_MS)
      throw new Error("the check did not conclude in time");
    await sleep(5_000);
  }
  mark("check concluded");
  result.seconds = steps["check concluded"] as number;
  result.ok = result.conclusion === "failure";
  if (!result.ok)
    result.problem = `the check concluded ${result.conclusion}, not failure`;
} catch (error) {
  result.problem = String(error).replaceAll(TOKEN, "***");
  result.seconds = Math.round((Date.now() - started) / 100) / 10;
} finally {
  if (pull !== undefined) {
    await github("PATCH", `/repos/${REPO}/pulls/${pull}`, { state: "closed" }).catch(
      () => undefined,
    );
  }
  for (const branch of [head, base]) {
    await github("DELETE", `/repos/${REPO}/git/refs/heads/${branch}`).catch(
      () => undefined,
    );
  }
  await rm(work, { recursive: true, force: true }).catch(() => undefined);
}

await writeFile(out, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(result)}\n`);
if (!result.ok) process.exit(1);
