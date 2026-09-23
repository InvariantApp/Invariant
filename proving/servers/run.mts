/**
 * Rig D: real open-source API servers, across their own breaking releases.
 *
 * Nothing here was written for this project: the server is the project's own
 * released image, and the client is the old release's own client or API
 * suite, unmodified. It is run three times:
 *
 *   a. against the old server. A test that fails here says nothing about the
 *      adapter, and is left out.
 *   b. against the new server. A test that passed in (a) and fails here is one
 *      the release broke, and is what the adapter has to fix. A pair where
 *      nothing breaks proves nothing, and is reported as vacuous.
 *   c. against the new server, through the proxy running the program the
 *      product compiles for the release. A broken test that passes here was
 *      served. A test that passed in (b) and fails here is one the adapter
 *      broke, and fails the run.
 *
 * The program comes from the product the way a provider gets one: a
 * repository with an `invariant.yaml` naming the two releases' documents, the
 * Changes in `invariant/changes`, and `invariant check`, which compiles a
 * program only when the gate passes. The Changes are the ones committed under
 * `changes/<project>/<from>..<to>/`, which `--propose` drafts with the
 * product's own proposer and a person then completes, as a provider would.
 * A pair with none committed gets whatever the proposer drafts on the spot.
 *
 * Every server starts fresh for its arm, so no arm inherits another's state.
 * Heavy: Docker, each suite's toolchain and several minutes per arm. It runs
 * in CI, one job per release pair, with no secrets, because it executes code this
 * project did not write.
 *
 * Usage:
 *   node --import tsx proving/servers/run.mts --project qdrant [--pair v1.13.0:v1.14.0]
 *     [--select <expression the suite's own filter takes>]
 *   node --import tsx proving/servers/run.mts --project qdrant --pair v1.13.0:v1.14.0 --propose
 *   node --import tsx proving/servers/run.mts --project qdrant --pair v1.13.0:v1.14.0 --gate
 *   node --import tsx proving/servers/run.mts --report <results.json>...
 *
 * `--propose` and `--gate` need no Docker: they read the two documents, from
 * the repository at the pinned commits or, for a project whose document is
 * only served, from a previous run's dump in `.cache/servers`.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import {
  type CheckReport,
  check,
  loadConfig,
  renderProposals,
  renderReport,
  runPropose,
} from "@invariant-app/cli";
import { ROOT } from "../corpus/manifest.mts";
import {
  type ArmResult,
  compareArms,
  expand,
  type GateSummary,
  type PairResult,
  readJunit,
  render,
  type Skipped,
} from "./pairs.ts";

export type { PairResult } from "./pairs.ts";

const run = promisify(execFile);

interface Release {
  commit: string;
  digest: string;
  /** The commit of the suite's own repository that belongs to this release, when the suite lives elsewhere. */
  suite?: string;
  /** The tag of that commit, for a host that will not fetch a commit by itself. */
  suiteRef?: string;
  /** The SHA-256 of the document attached to the release, for a project that publishes it that way. */
  specSha256?: string;
}

/** A command, as an argument vector with `{placeholders}`. */
type Command = string[];

interface Project {
  name: string;
  language: string;
  /** Why the suite is run as it is, where that departs from the project's own CI. */
  notes?: string;
  repo: string;
  image: string;
  server: {
    /** The port the server listens on inside its container. */
    port: number;
    /** A path that answers 200 once the server is ready. */
    ready: string;
    readySeconds?: number;
    env?: Record<string, string>;
    /**
     * A compose file beside this manifest, for a server that needs others
     * (a database, a cache). It is given IMAGE, PORT and CONTAINER, and must
     * name the API's own container CONTAINER.
     */
    compose?: string;
    /**
     * Run on the host once the server answers, before anything else: an
     * administrator to sign in as, a token to call with. A step that names
     * `capture` keeps what it printed, trimmed, as `{<capture>}`.
     */
    setup?: { run: Command; capture?: string }[];
    /**
     * Credentials the server is started with, made when the pair runs and
     * never written down: random bytes, as hex, or the value the suite itself
     * calls with, read from its own source by the pattern's first group. Each
     * is `{<name>}` wherever a placeholder is read, and an environment variable
     * of that name for a compose file.
     */
    secrets?: Record<string, { random: number } | { suite: string; pattern: string }>;
  };
  /**
   * Where the release's OpenAPI document comes from: its repository at the
   * tag, a file attached to its GitHub release (checked against the release's
   * `specSha256`), or the running server.
   */
  spec:
    | { path: string }
    | { asset: string }
    | { served: string; headers?: Record<string, string> };
  suite: {
    /** The suite's repository, when it is not the server's. */
    repo?: string;
    /** The paths of the suite's repository to check out. */
    sparse: string[];
    dir: string;
    /**
     * Run once per release in the suite's directory. `{work}` is a directory
     * of the release's own, and a virtual environment made at `{env}` is put
     * on PATH.
     */
    install: Command[];
    /** Writes a JUnit report to `{report}`. */
    run: Command;
    /** Appended to `run` when `--select` is given. */
    select?: Command;
    env: Record<string, string>;
    timeoutMinutes?: number;
  };
  releases: Record<string, Release>;
  pairs: [string, string][];
}

interface Manifest {
  projects: Project[];
  skipped: Skipped[];
}

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};

const CACHE = join(ROOT, ".cache/servers");
const RECORDED = join(ROOT, "proving/servers/changes");
/**
 * Where the suite calls, in every arm: the server itself in arms a and b, the
 * proxy in arm c, with the server behind it. A suite, or a server configured
 * with its own address, sees the same URL whichever arm it is in.
 */
const SUITE_PORT = 16_333;
const BEHIND_PORT = 16_334;

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

/**
 * A step that reaches a package index, tried again after a pause when it
 * fails. Qdrant 1.18's suite once failed to install because the index said a
 * pinned release did not exist, which a minute later it did.
 */
async function patiently<T>(step: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await step();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await sleep(attempt * 20_000);
    }
  }
}

/** A repository's files at one commit, only the paths asked for. */
async function checkout(
  repo: string,
  commit: string,
  sparse: string[],
  dir: string,
  ref?: string,
): Promise<string> {
  if (existsSync(join(dir, ".git"))) {
    const head = (await sh("git", ["rev-parse", "HEAD"], { cwd: dir })).trim();
    if (head === commit) return dir;
    await rm(dir, { recursive: true, force: true });
  }
  await mkdir(dir, { recursive: true });
  const git = (...argv: string[]) => sh("git", argv, { cwd: dir });
  const url = repo.includes("://") ? repo : `https://github.com/${repo}.git`;
  await git("init", "-q");
  await git("remote", "add", "origin", url);
  // A file is named as its directory would be, and cone mode takes the
  // directory whole; non-cone patterns take exactly what is listed. Nothing
  // listed means the whole repository, which a client library installs from.
  if (sparse.length > 0) {
    await git("sparse-checkout", "set", "--no-cone", ...sparse.map((path) => `/${path}`));
  }
  // By the commit where the host serves one, or by the tag that names it
  // where it only serves refs; either way the commit is checked below.
  await git("fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", ref ?? commit);
  await git("checkout", "-q", "FETCH_HEAD");
  const head = (await git("rev-parse", "HEAD")).trim();
  if (head !== commit) throw new Error(`${repo} checked out ${head}, not ${commit}`);
  return dir;
}

function releaseOf(project: Project, tag: string): Release {
  const release = project.releases[tag];
  if (!release) throw new Error(`${project.name} does not pin ${tag}`);
  return release;
}

/** The release's own document: from its repository, its release page, or as the running server served it. */
async function specOf(project: Project, tag: string): Promise<string> {
  if ("asset" in project.spec) {
    const path = join(CACHE, project.name, tag, project.spec.asset);
    const expected = releaseOf(project, tag).specSha256;
    if (!expected) throw new Error(`${project.name} ${tag} pins no specSha256`);
    if (!existsSync(path)) {
      const url = `https://github.com/${project.repo}/releases/download/${tag}/${project.spec.asset}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url} answered ${response.status}`);
      const body = Buffer.from(await response.arrayBuffer());
      const actual = createHash("sha256").update(body).digest("hex");
      if (actual !== expected) {
        throw new Error(`${url} has SHA-256 ${actual}, not the pinned ${expected}`);
      }
      await mkdir(join(CACHE, project.name, tag), { recursive: true });
      await writeFile(path, body);
    }
    return path;
  }
  if ("path" in project.spec) {
    const src = await checkout(
      project.repo,
      releaseOf(project, tag).commit,
      [project.spec.path],
      join(CACHE, project.name, tag, "spec-src"),
    );
    return join(src, project.spec.path);
  }
  const dumped = join(CACHE, project.name, tag, "spec.json");
  if (!existsSync(dumped)) {
    throw new Error(
      `${project.name} ${tag} serves its document, and no run has dumped it into ${dumped} yet`,
    );
  }
  return dumped;
}

/** The suite of the release, checked out and installed exactly as it pins itself. */
async function suiteOf(
  project: Project,
  tag: string,
): Promise<{ dir: string; env: string }> {
  const release = releaseOf(project, tag);
  const repo = project.suite.repo ?? project.repo;
  const commit = project.suite.repo ? release.suite : release.commit;
  if (!commit) throw new Error(`${project.name} ${tag} pins no commit of ${repo}`);
  const src = await checkout(
    repo,
    commit,
    project.suite.sparse,
    join(CACHE, project.name, tag, "suite"),
    project.suite.repo ? release.suiteRef : undefined,
  );
  const dir = join(src, project.suite.dir);
  const work = join(CACHE, project.name, tag);
  const env = join(work, "env");
  const marker = join(work, "installed");
  if (existsSync(marker)) return { dir, env };
  await rm(env, { recursive: true, force: true });
  for (const command of project.suite.install) {
    const [program, ...rest] = command.map((part) => expand(part, { env, work })) as [
      string,
      ...string[],
    ];
    await patiently(() => sh(program, rest, { cwd: dir, env: suiteEnv(env, dir) }));
  }
  await writeFile(marker, "", "utf8");
  return { dir, env };
}

/** The credentials a pair's servers are started with, made for this run alone. */
async function secretsOf(
  project: Project,
  suite: { dir: string },
): Promise<Record<string, string>> {
  const made: Record<string, string> = {};
  for (const [name, source] of Object.entries(project.server.secrets ?? {})) {
    if ("random" in source) {
      made[name] = randomBytes(source.random).toString("hex");
      continue;
    }
    const text = await readFile(join(suite.dir, source.suite), "utf8");
    const found = new RegExp(source.pattern).exec(text)?.[1];
    if (!found) {
      throw new Error(
        `${source.suite} has nothing matching ${source.pattern} for ${name}`,
      );
    }
    made[name] = found;
  }
  return made;
}

/** The environment a suite's commands run in: its own tools first on PATH. */
function suiteEnv(env: string, dir: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env };
  const paths = [join(dir, "node_modules", ".bin"), join(env, "bin")];
  if (existsSync(join(env, "bin", "python"))) out["VIRTUAL_ENV"] = env;
  out["PATH"] = [...paths, process.env["PATH"] ?? ""].join(":");
  return out;
}

async function waitFor(url: string, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const up = await fetch(url).then(
      (response) => response.ok,
      () => false,
    );
    if (up) return;
    await sleep(1000);
  }
  throw new Error(`${what} did not answer ${url} within ${timeoutMs / 1000}s`);
}

const containerOf = (project: Project) => `invariant-proving-${project.name}`;

function composeArgs(project: Project): string[] {
  return [
    "compose",
    "-f",
    join(ROOT, "proving/servers", project.server.compose ?? ""),
    "-p",
    containerOf(project),
  ];
}

/**
 * A fresh server for one arm, answering on `port`, set up as its manifest
 * says. Returns what the setup captured, with the server's own `{url}`.
 */
async function startServer(
  project: Project,
  tag: string,
  port: number,
  secrets: Record<string, string>,
): Promise<Record<string, string>> {
  const release = releaseOf(project, tag);
  const image = `${project.image}@${release.digest}`;
  const container = containerOf(project);
  await stopServer(project);
  if (project.server.compose) {
    await sh("docker", [...composeArgs(project), "up", "-d", "--quiet-pull"], {
      env: {
        ...process.env,
        ...secrets,
        IMAGE: image,
        PORT: String(port),
        CONTAINER: container,
      },
    });
  } else {
    const env = Object.entries(project.server.env ?? {}).flatMap(([name, value]) => [
      "-e",
      `${name}=${expand(value, secrets)}`,
    ]);
    await sh("docker", [
      "run",
      "-d",
      "--name",
      container,
      "-p",
      `127.0.0.1:${port}:${project.server.port}`,
      ...env,
      image,
    ]);
  }
  const url = `http://127.0.0.1:${port}`;
  const vars: Record<string, string> = { ...secrets, url, container };
  try {
    await waitFor(
      `${url}${project.server.ready}`,
      `${project.name} ${tag}`,
      (project.server.readySeconds ?? 180) * 1000,
    );
    for (const step of project.server.setup ?? []) {
      const [program, ...rest] = step.run.map((part) => expand(part, vars)) as [
        string,
        ...string[],
      ];
      const printed = await sh(program, rest);
      if (step.capture) vars[step.capture] = printed.trim();
    }
  } catch (error) {
    // What the server said on its way down is the only account of why.
    const logs = await sh("docker", ["logs", "--tail", "40", container]).catch(() => "");
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${logs.slice(-2000)}`,
    );
  }
  return vars;
}

async function stopServer(project: Project): Promise<void> {
  if (project.server.compose) {
    await sh("docker", [...composeArgs(project), "down", "-v", "--remove-orphans"], {
      env: { ...process.env, IMAGE: "none", PORT: "0", CONTAINER: containerOf(project) },
    }).catch(() => "");
  } else {
    await sh("docker", ["rm", "-f", "-v", containerOf(project)]).catch(() => "");
  }
}

/** The document a running server serves, kept where `--propose` and `--gate` look for it. */
async function dumpSpec(
  project: Project,
  tag: string,
  vars: Record<string, string>,
): Promise<void> {
  if (!("served" in project.spec)) return;
  const headers = Object.fromEntries(
    Object.entries(project.spec.headers ?? {}).map(([name, value]) => [
      name,
      expand(value, vars),
    ]),
  );
  const response = await fetch(`${vars["url"]}${project.spec.served}`, { headers });
  if (!response.ok) {
    throw new Error(`${project.spec.served} answered ${response.status}`);
  }
  const path = join(CACHE, project.name, tag, "spec.json");
  await mkdir(join(CACHE, project.name, tag), { recursive: true });
  await writeFile(path, await response.text(), "utf8");
}

async function startProxy(
  program: unknown,
  label: string,
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
      listen: { port: SUITE_PORT, host: "127.0.0.1" },
      identity: [{ kind: "default", label }],
      maxBodyBytes: 32 * 1024 * 1024,
    }),
    "utf8",
  );
  const proxy = spawn(
    process.execPath,
    ["--import", "tsx", join(ROOT, "packages/sidecar/src/cli.ts"), configPath],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  await waitFor(`http://127.0.0.1:${SUITE_PORT}/__invariant/health`, "the proxy", 30_000);
  return proxy;
}

async function runSuite(
  project: Project,
  suite: { dir: string; env: string },
  vars: Record<string, string>,
  report: string,
): Promise<ArmResult> {
  const all = { ...vars, report, env: suite.env };
  const env = suiteEnv(suite.env, suite.dir);
  for (const [key, value] of Object.entries(project.suite.env)) {
    env[key] = expand(value, all);
  }
  const select = option("select");
  const [command, ...rest] = [
    ...project.suite.run,
    ...(select && project.suite.select ? project.suite.select : []),
  ].map((part) => expand(part, { ...all, ...(select ? { select } : {}) })) as [
    string,
    ...string[],
  ];
  await rm(report, { force: true });
  // A failing suite exits non-zero, which is the point of arm (b); what
  // matters is the report it leaves. One that runs past its time is stopped,
  // with everything it started.
  const timedOut = await new Promise<boolean>((done) => {
    const child = spawn(command, rest, {
      cwd: suite.dir,
      env,
      stdio: ["ignore", "ignore", "inherit"],
      detached: true,
    });
    const timer = setTimeout(
      () => {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        done(true);
      },
      (project.suite.timeoutMinutes ?? 30) * 60_000,
    );
    child.on("exit", () => {
      clearTimeout(timer);
      done(false);
    });
    child.on("error", () => {
      clearTimeout(timer);
      done(false);
    });
  });
  if (!existsSync(report)) {
    return {
      outcomes: {},
      error: timedOut ? "the suite ran out of time" : "the suite left no report",
    };
  }
  return readJunit(await readFile(report, "utf8"));
}

/**
 * A provider's repository for the release: the two documents, and the
 * Changes committed for it, or, when none are, the ones the proposer drafts.
 */
async function providerFor(
  project: Project,
  from: string,
  to: string,
  options: { draft: boolean },
): Promise<{ root: string; recorded: string; drafted: number }> {
  const [oldSpec, newSpec] = await Promise.all([
    specOf(project, from),
    specOf(project, to),
  ]);
  const root = join(CACHE, project.name, `${from}..${to}`, "provider");
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, "invariant", "changes"), { recursive: true });
  await mkdir(join(root, "specs"), { recursive: true });
  const extension = (path: string) => (/\.ya?ml$/.test(path) ? ".yaml" : ".json");
  await copyFile(oldSpec, join(root, "specs", `${from}${extension(oldSpec)}`));
  await copyFile(newSpec, join(root, "specs", `${to}${extension(newSpec)}`));
  await writeFile(
    join(root, "invariant.yaml"),
    [
      `api: ${project.name}`,
      "spec:",
      `  current: specs/${to}${extension(newSpec)}`,
      `  currentLabel: "${to}"`,
      "  released:",
      `    "${from}": specs/${from}${extension(oldSpec)}`,
      "identity:",
      "  - kind: default",
      `    label: "${from}"`,
      "",
    ].join("\n"),
    "utf8",
  );
  const recorded = join(RECORDED, project.name, `${from}..${to}`);
  let drafted = 0;
  if (existsSync(recorded)) {
    for (const name of await readdir(recorded)) {
      if (!/\.ya?ml$/.test(name)) continue;
      await copyFile(join(recorded, name), join(root, "invariant", "changes", name));
    }
  } else if (options.draft) {
    const config = await loadConfig(join(root, "invariant.yaml"));
    const proposed = await runPropose(config, { write: true, offline: true });
    drafted = proposed.written.length;
  }
  return { root, recorded, drafted };
}

function summarize(
  report: CheckReport,
  changesFrom: GateSummary["changesFrom"],
  drafted: number,
): GateSummary {
  const pending = report.steps[report.steps.length - 1];
  return {
    changesFrom,
    drafted,
    result: report.result,
    unexplained: pending?.unexplained ?? [],
    unservable: [
      ...(pending?.issues ?? []),
      ...(pending?.stale ?? []),
      ...report.unservable,
      ...report.problems,
      ...report.policy,
    ],
    accounted: pending?.accounted ?? 0,
  };
}

async function gateFor(
  project: Project,
  from: string,
  to: string,
): Promise<{ report: CheckReport; summary: GateSummary }> {
  const provider = await providerFor(project, from, to, { draft: true });
  const config = await loadConfig(join(provider.root, "invariant.yaml"));
  const report = await check(config);
  const changesFrom = existsSync(provider.recorded) ? "recorded" : "drafted";
  return { report, summary: summarize(report, changesFrom, provider.drafted) };
}

async function runPair(project: Project, from: string, to: string): Promise<PairResult> {
  const work = join(CACHE, project.name, `${from}..${to}`);
  await mkdir(work, { recursive: true });

  const failed = (error: unknown): ArmResult => ({
    outcomes: {},
    error: error instanceof Error ? error.message : String(error),
  });

  log(`${project.name} ${from} -> ${to}: installing the old release's suite`);
  let suite: { dir: string; env: string };
  let secrets: Record<string, string>;
  try {
    suite = await suiteOf(project, from);
    secrets = await secretsOf(project, suite);
  } catch (error) {
    // Reported as a pair that could not run, beside the ones that could.
    const none = failed(`the suite could not be installed: ${failed(error).error}`);
    return {
      project: project.name,
      language: project.language,
      from,
      to,
      changes: 0,
      gate: {
        changesFrom: "drafted",
        drafted: 0,
        result: "block",
        unexplained: [],
        unservable: ["not checked, since the suite could not be installed"],
        accounted: 0,
      },
      arms: { a: none, b: none, c: none },
      valid: 0,
      broken: [],
      served: [],
      regressions: [],
    };
  }

  const arm = async (
    label: string,
    tag: string,
    through?: { program: unknown },
  ): Promise<ArmResult> => {
    log(
      `  arm ${label}: ${through ? "through the proxy to " : ""}${project.name} ${tag}`,
    );
    let proxy: ChildProcess | undefined;
    try {
      const vars = await startServer(
        project,
        tag,
        through ? BEHIND_PORT : SUITE_PORT,
        secrets,
      );
      await dumpSpec(project, tag, vars);
      if (through) {
        proxy = await startProxy(through.program, from, vars["url"] ?? "", work);
        vars["url"] = `http://127.0.0.1:${SUITE_PORT}`;
      }
      return await runSuite(
        project,
        suite,
        { ...vars, spec: await specOf(project, from) },
        join(work, `${label}.xml`),
      );
    } catch (error) {
      return failed(error);
    } finally {
      proxy?.kill("SIGTERM");
      await stopServer(project);
    }
  };

  const a = await arm("a", from);
  const b = await arm("b", to);

  let gate: GateSummary;
  let c: ArmResult;
  let changes = 0;
  try {
    const checked = await gateFor(project, from, to);
    // The report a provider reads, kept beside the drafts it judged, so a
    // release too large to check on a laptop can still be answered from one.
    await writeFile(join(work, "gate.txt"), renderReport(checked.report), "utf8");
    gate = checked.summary;
    changes = checked.report.steps.at(-1)?.changes.length ?? 0;
    log(`  ${changes} Changes (${gate.changesFrom}), the gate says ${gate.result}`);
    c = checked.report.program
      ? await arm("c", to, { program: checked.report.program })
      : {
          outcomes: {},
          error: "the gate blocks the release, so there is no program to run",
        };
  } catch (error) {
    gate = {
      changesFrom: "drafted",
      drafted: 0,
      result: "block",
      unexplained: [],
      unservable: [error instanceof Error ? error.message : String(error)],
      accounted: 0,
    };
    c = failed(error);
  }

  const arms = { a, b, c };
  const compared = compareArms(arms);
  log(
    `  ${compared.valid} tests valid, ${compared.broken.length} broken by the release, ` +
      `${compared.served.length} served, ${compared.regressions.length} regressions`,
  );
  // Only what explains a result is kept of what the tests said.
  const keep = (armResult: ArmResult, ids: readonly string[]): ArmResult => {
    const messages = Object.fromEntries(
      ids
        .filter((id) => armResult.messages?.[id] !== undefined)
        .map((id) => [id, armResult.messages?.[id] as string]),
    );
    const { messages: _all, ...rest } = armResult;
    return Object.keys(messages).length > 0 ? { ...rest, messages } : rest;
  };
  const unserved = compared.broken.filter((id) => !compared.served.includes(id));
  return {
    project: project.name,
    language: project.language,
    from,
    to,
    changes,
    gate,
    arms: {
      a: keep(a, []),
      b: keep(b, compared.broken),
      c: keep(c, [...unserved, ...compared.regressions]),
    },
    ...compared,
  };
}

async function readManifest(): Promise<Manifest> {
  const manifest = JSON.parse(
    await readFile(join(ROOT, "proving/servers/projects.json"), "utf8"),
  ) as Partial<Manifest>;
  return { projects: manifest.projects ?? [], skipped: manifest.skipped ?? [] };
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
  const { skipped } = await readManifest();
  await writeFile(
    join(ROOT, "proving/servers/results.json"),
    `${JSON.stringify(merged, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(ROOT, "proving/servers/REPORT.md"),
    render(merged, skipped),
    "utf8",
  );
  log(
    `${merged.length} release pairs from ${reportInputs.length} projects, report written`,
  );
} else if (process.argv[1]?.endsWith("run.mts")) {
  const manifest = await readManifest();
  const wanted = option("project");
  const onlyPair = option("pair")?.split(":");
  const projects = manifest.projects.filter(
    (project) => wanted === undefined || project.name === wanted,
  );
  const pairsOf = (project: Project) =>
    project.pairs.filter(
      ([from, to]) => !onlyPair || (onlyPair[0] === from && onlyPair[1] === to),
    );

  if (args.includes("--propose") || args.includes("--gate")) {
    // What a provider would do at their desk: draft, read, answer, check.
    for (const project of projects) {
      for (const [from, to] of pairsOf(project)) {
        log(`${project.name} ${from} -> ${to}`);
        if (args.includes("--propose")) {
          const provider = await providerFor(project, from, to, { draft: false });
          const config = await loadConfig(join(provider.root, "invariant.yaml"));
          const proposed = await runPropose(config, { write: true, offline: true });
          await mkdir(provider.recorded, { recursive: true });
          for (const path of proposed.written) {
            const name = path.split("/").at(-1) as string;
            await copyFile(path, join(provider.recorded, name));
          }
          log(renderProposals(proposed));
          log(`wrote ${proposed.written.length} files into ${provider.recorded}`);
        } else {
          const { report } = await gateFor(project, from, to);
          log(renderReport(report));
        }
      }
    }
  } else {
    const results: PairResult[] = [];
    for (const project of projects) {
      for (const [from, to] of pairsOf(project)) {
        results.push(await runPair(project, from, to));
      }
    }
    const partial = wanted !== undefined || onlyPair !== undefined || option("select");
    const out = join(
      partial ? CACHE : join(ROOT, "proving/servers"),
      partial
        ? `results-${wanted ?? "all"}${onlyPair ? `-${onlyPair.join("..")}` : ""}.json`
        : "results.json",
    );
    await writeFile(out, `${JSON.stringify(results, null, 2)}\n`, "utf8");
    const report = render(results, partial ? [] : manifest.skipped);
    log(`\n${report}`);
    if (!partial)
      await writeFile(join(ROOT, "proving/servers/REPORT.md"), report, "utf8");
    if (results.some((result) => result.regressions.length > 0)) process.exit(1);
  }
}
