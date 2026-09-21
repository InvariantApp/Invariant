/**
 * Rig D: real open-source API servers, across their own breaking releases.
 *
 * Nothing here was written for this project: the server is the project's own
 * released image, and the client is the old release's own API suite, which
 * validates every response against the old release's specification. It is
 * run three times:
 *
 *   a. against the old server. A test that fails here says nothing about the
 *      adapter, and is left out.
 *   b. against the new server. A test that passed in (a) and fails here is one
 *      the release broke, and is what the adapter has to fix.
 *   c. against the new server, through the proxy running the program drafted
 *      for the release. A broken test that passes here was served. A test that
 *      passed in (b) and fails here is one the adapter broke, and fails the
 *      run.
 *
 * Every container starts fresh for its arm, so no arm inherits another's
 * state. Heavy: Docker, a Python toolchain and several minutes per arm. It
 * runs in CI, one job per project, with no secrets, because it executes code
 * this project did not write.
 *
 * Usage:
 *   node --import tsx proving/servers/run.mts --project qdrant [--pair v1.13.0:v1.14.0]
 *     [--select <pytest -k expression>]
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { loadContract } from "@invariant/contract";
import { ROOT } from "../corpus/manifest.mts";
import { draftProgram, NEW, OLD } from "../draft.mts";

const run = promisify(execFile);

interface Release {
  commit: string;
  digest: string;
}

interface Project {
  name: string;
  language: string;
  repo: string;
  image: string;
  containerPort: number;
  ready: string;
  spec: string;
  suite: {
    dir: string;
    sparse: string[];
    lock: "poetry";
    run: string[];
    env: Record<string, string>;
  };
  releases: Record<string, Release>;
  pairs: [string, string][];
}

export type Outcome = "passed" | "failed" | "skipped";

export interface ArmResult {
  outcomes: Record<string, Outcome>;
  /** Set when the arm could not run at all. */
  error?: string;
}

export interface PairResult {
  project: string;
  language: string;
  from: string;
  to: string;
  changes: number;
  /** Why the gate would block this release, if it would. */
  gateIssues: string[];
  arms: { a: ArmResult; b: ArmResult; c: ArmResult };
  /** Passed against the old server. */
  valid: number;
  /** Valid, and broken by the release: what the adapter has to fix. */
  broken: string[];
  /** Broken, and passing through the adapter. */
  served: string[];
  /** Passing without the adapter and failing through it. Must be empty. */
  regressions: string[];
}

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};

const CACHE = join(ROOT, ".cache/servers");
const SERVER_PORT = 16_333;
const PROXY_PORT = 16_340;

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function sh(
  command: string,
  argv: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const { stdout } = await run(command, argv, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

/** The release's own files at its pinned commit, and nothing else of the repository. */
async function checkout(
  project: Project,
  tag: string,
  release: Release,
): Promise<string> {
  const dir = join(CACHE, project.name, tag, "src");
  if (existsSync(join(dir, ".git"))) {
    const head = (await sh("git", ["rev-parse", "HEAD"], { cwd: dir })).trim();
    if (head === release.commit) return dir;
    await rm(dir, { recursive: true, force: true });
  }
  await mkdir(dir, { recursive: true });
  const git = (...argv: string[]) => sh("git", argv, { cwd: dir });
  await git("init", "-q");
  await git("remote", "add", "origin", `https://github.com/${project.repo}.git`);
  await git("sparse-checkout", "set", "--cone", ...project.suite.sparse);
  await git(
    "fetch",
    "-q",
    "--depth",
    "1",
    "--filter=blob:none",
    "origin",
    release.commit,
  );
  await git("checkout", "-q", "FETCH_HEAD");
  const head = (await git("rev-parse", "HEAD")).trim();
  if (head !== release.commit) {
    throw new Error(`${project.repo} ${tag} checked out ${head}, not ${release.commit}`);
  }
  return dir;
}

/**
 * The old release's suite, installed exactly as its lock file pins it, into a
 * virtual environment of its own.
 */
async function suiteEnvironment(
  project: Project,
  tag: string,
  src: string,
): Promise<string> {
  const venv = join(CACHE, project.name, tag, "venv");
  const python = join(venv, "bin", "python");
  if (existsSync(python)) return venv;
  const suite = join(src, project.suite.dir);
  const requirements = join(CACHE, project.name, tag, "requirements.txt");
  await sh(
    "uvx",
    [
      "--from",
      "poetry>=2,<3",
      "--with",
      "poetry-plugin-export",
      "poetry",
      "export",
      "--without-hashes",
      "--format",
      "requirements.txt",
      "--output",
      requirements,
    ],
    { cwd: suite },
  );
  await sh("uv", ["venv", "--quiet", "--python", "3.11", venv]);
  await sh("uv", ["pip", "install", "--quiet", "--python", python, "-r", requirements]);
  return venv;
}

async function waitFor(url: string, what: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const up = await fetch(url).then(
      (response) => response.ok,
      () => false,
    );
    if (up) return;
    await sleep(500);
  }
  throw new Error(`${what} did not answer ${url} within ${timeoutMs / 1000}s`);
}

/** A fresh server for one arm, answering on SERVER_PORT. */
async function startServer(
  project: Project,
  tag: string,
  release: Release,
): Promise<string> {
  const name = `invariant-proving-${project.name}`;
  await sh("docker", ["rm", "-f", name]).catch(() => "");
  await sh("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "-p",
    `127.0.0.1:${SERVER_PORT}:${project.containerPort}`,
    `${project.image}@${release.digest}`,
  ]);
  const url = `http://127.0.0.1:${SERVER_PORT}`;
  await waitFor(`${url}${project.ready}`, `${project.name} ${tag}`);
  return url;
}

async function stopServer(project: Project): Promise<void> {
  await sh("docker", ["rm", "-f", `invariant-proving-${project.name}`]).catch(() => "");
}

async function startProxy(
  program: unknown,
  upstream: string,
  work: string,
): Promise<ChildProcess> {
  const programPath = join(work, "program.json");
  const configPath = join(work, "sidecar.json");
  await writeFile(programPath, JSON.stringify(program), "utf8");
  await writeFile(
    configPath,
    JSON.stringify({
      program: programPath,
      upstream,
      listen: { port: PROXY_PORT, host: "127.0.0.1" },
      identity: [{ kind: "default", label: OLD }],
      maxBodyBytes: 32 * 1024 * 1024,
    }),
    "utf8",
  );
  const proxy = spawn(
    process.execPath,
    ["--import", "tsx", join(ROOT, "packages/sidecar/src/cli.ts"), configPath],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  await waitFor(`http://127.0.0.1:${PROXY_PORT}/__invariant/health`, "the proxy", 30_000);
  return proxy;
}

/** Test id to outcome, read from a JUnit report. */
export function readJunit(xml: string): Record<string, Outcome> {
  const outcomes: Record<string, Outcome> = {};
  const cases = xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g);
  for (const [, attributes = "", body = ""] of cases) {
    const attribute = (name: string) =>
      new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1] ?? "";
    const id = `${attribute("classname")}::${attribute("name")}`;
    outcomes[id] = /<(failure|error)\b/.test(body)
      ? "failed"
      : /<skipped\b/.test(body)
        ? "skipped"
        : "passed";
  }
  return outcomes;
}

async function runSuite(
  project: Project,
  venv: string,
  src: string,
  url: string,
  spec: string,
  report: string,
): Promise<ArmResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, VIRTUAL_ENV: venv };
  env["PATH"] = `${join(venv, "bin")}:${process.env["PATH"] ?? ""}`;
  for (const [key, value] of Object.entries(project.suite.env)) {
    env[key] = value.replace("{url}", url).replace("{spec}", spec);
  }
  const [command, ...rest] = project.suite.run as [string, ...string[]];
  const select = option("select");
  const argv = [...rest, "--junitxml", report, ...(select ? ["-k", select] : [])];
  await rm(report, { force: true });
  // A failing suite exits non-zero, which is the point of arm (b); what
  // matters is the report it leaves.
  await new Promise<void>((done) => {
    const child = spawn(join(venv, "bin", command), argv, {
      cwd: join(src, project.suite.dir),
      env,
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.on("exit", () => done());
  });
  if (!existsSync(report)) return { outcomes: {}, error: "the suite left no report" };
  return { outcomes: readJunit(await readFile(report, "utf8")) };
}

export function compareArms(arms: {
  a: ArmResult;
  b: ArmResult;
  c: ArmResult;
}): Pick<PairResult, "valid" | "broken" | "served" | "regressions"> {
  const valid = Object.keys(arms.a.outcomes).filter(
    (id) => arms.a.outcomes[id] === "passed",
  );
  const broken = valid.filter((id) => arms.b.outcomes[id] !== "passed");
  const served = broken.filter((id) => arms.c.outcomes[id] === "passed");
  const regressions = valid.filter(
    (id) => arms.b.outcomes[id] === "passed" && arms.c.outcomes[id] !== "passed",
  );
  return { valid: valid.length, broken, served, regressions };
}

async function runPair(project: Project, from: string, to: string): Promise<PairResult> {
  const old = project.releases[from];
  const next = project.releases[to];
  if (!old || !next) throw new Error(`${project.name} does not pin ${from} and ${to}`);
  const work = join(CACHE, project.name, `${from}-${to}`);
  await mkdir(work, { recursive: true });

  log(`${project.name} ${from} -> ${to}: checking out both releases`);
  const oldSrc = await checkout(project, from, old);
  const newSrc = await checkout(project, to, next);
  const oldSpec = join(oldSrc, project.spec);
  const newSpec = join(newSrc, project.spec);

  const drafted = await draftProgram(
    project.name,
    (await loadContract(oldSpec, OLD)).document,
    (await loadContract(newSpec, NEW)).document,
  );
  log(
    `  ${drafted.changes.length} Changes drafted, ${drafted.issues.length} gate issues`,
  );

  log("  installing the old release's suite");
  const venv = await suiteEnvironment(project, from, oldSrc);

  const arm = async (label: string, tag: string, release: Release, viaProxy: boolean) => {
    log(
      `  arm ${label}: ${viaProxy ? "through the proxy to " : ""}${project.name} ${tag}`,
    );
    const server = await startServer(project, tag, release);
    const proxy = viaProxy ? await startProxy(drafted.program, server, work) : undefined;
    try {
      const url = proxy ? `http://127.0.0.1:${PROXY_PORT}` : server;
      return await runSuite(
        project,
        venv,
        oldSrc,
        url,
        oldSpec,
        join(work, `${label}.xml`),
      );
    } catch (error) {
      return {
        outcomes: {},
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      proxy?.kill("SIGTERM");
      await stopServer(project);
    }
  };

  const arms = {
    a: await arm("a", from, old, false),
    b: await arm("b", to, next, false),
    c: await arm("c", to, next, true),
  };
  const compared = compareArms(arms);
  log(
    `  ${compared.valid} tests valid, ${compared.broken.length} broken by the release, ` +
      `${compared.served.length} served, ${compared.regressions.length} regressions`,
  );
  return {
    project: project.name,
    language: project.language,
    from,
    to,
    changes: drafted.changes.length,
    gateIssues: drafted.issues.map((issue) => issue.message),
    arms,
    ...compared,
  };
}

export function render(results: readonly PairResult[]): string {
  const lines = [
    "# Real servers",
    "",
    "Rig D. Each project's own released images, across a breaking release of",
    "their own, exercised by the old release's own API suite validating",
    "against the old specification. Generated by `pnpm proving:servers`.",
    "",
    "| Project | Release | Changes | Valid tests | Broken by the release | Served through the adapter | Regressions |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const result of results) {
    const failed = Object.entries(result.arms)
      .filter(([, arm]) => arm.error)
      .map(([name, arm]) => `arm ${name}: ${arm.error}`);
    lines.push(
      `| ${result.project} (${result.language}) | ${result.from} -> ${result.to} | ${result.changes}${result.gateIssues.length ? `, gate blocks (${result.gateIssues.length})` : ""} | ${result.valid} | ${result.broken.length} | ${result.served.length} | ${result.regressions.length}${failed.length ? `; ${failed.join("; ")}` : ""} |`,
    );
  }
  lines.push("");
  for (const result of results) {
    const unserved = result.broken.filter((id) => !result.served.includes(id));
    if (unserved.length === 0 && result.regressions.length === 0) continue;
    lines.push(`## ${result.project} ${result.from} -> ${result.to}`, "");
    if (result.regressions.length > 0) {
      lines.push("Passing without the adapter and failing through it:", "");
      for (const id of result.regressions) lines.push(`- \`${id}\``);
      lines.push("");
    }
    if (unserved.length > 0) {
      lines.push("Broken by the release and not yet served:", "");
      for (const id of unserved.slice(0, 40)) lines.push(`- \`${id}\``);
      if (unserved.length > 40) lines.push(`- and ${unserved.length - 40} more`);
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

const reportInputs = args.includes("--report")
  ? args.slice(args.indexOf("--report") + 1).filter((arg) => !arg.startsWith("--"))
  : undefined;

if (process.argv[1]?.endsWith("run.mts") && reportInputs) {
  // The projects ran as separate jobs; this is the one report they add up to.
  const merged: PairResult[] = [];
  for (const input of reportInputs) {
    merged.push(...(JSON.parse(await readFile(input, "utf8")) as PairResult[]));
  }
  await writeFile(
    join(ROOT, "proving/servers/results.json"),
    `${JSON.stringify(merged, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(ROOT, "proving/servers/REPORT.md"), render(merged), "utf8");
  log(
    `${merged.length} release pairs from ${reportInputs.length} projects, report written`,
  );
} else if (process.argv[1]?.endsWith("run.mts")) {
  const manifest = JSON.parse(
    await readFile(join(ROOT, "proving/servers/projects.json"), "utf8"),
  ) as { projects: Project[] };
  const wanted = option("project");
  const onlyPair = option("pair")?.split(":");
  const projects = manifest.projects.filter(
    (project) => wanted === undefined || project.name === wanted,
  );
  const results: PairResult[] = [];
  for (const project of projects) {
    for (const [from, to] of project.pairs) {
      if (onlyPair && (onlyPair[0] !== from || onlyPair[1] !== to)) continue;
      results.push(await runPair(project, from, to));
    }
  }
  const partial = wanted !== undefined || onlyPair !== undefined || option("select");
  const out = join(
    partial ? CACHE : join(ROOT, "proving/servers"),
    partial ? `results-${wanted ?? "all"}.json` : "results.json",
  );
  await writeFile(out, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  const report = render(results);
  log(`\n${report}`);
  if (!partial) await writeFile(join(ROOT, "proving/servers/REPORT.md"), report, "utf8");
  if (results.some((result) => result.regressions.length > 0)) process.exit(1);
}
