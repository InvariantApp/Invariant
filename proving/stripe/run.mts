/**
 * Rig B: Stripe's own SDK suites, against Stripe's own mock, across Stripe's
 * own specification history.
 *
 * Nothing on either side was written here. stripe-mock is Stripe's release
 * binary, given `-spec` and `-fixtures` from the same stripe/openapi commit,
 * and the clients are stripe-node's and stripe-python's test suites,
 * unmodified, at the release pinned to the old commit's API version. For each
 * pair of consecutive commits they run three times:
 *
 *   a. against the mock on the old commit, which is the SDK's own contract.
 *      Whatever goes wrong here is the suite's or the mock's, and is the
 *      baseline everything else is counted over.
 *   b. against the mock on the new commit, with nothing in between. A pair
 *      where the old SDK meets nothing wrong here proves nothing about an
 *      adapter, and is reported as vacuous.
 *   c. against the mock on the new commit, through the proxy running the
 *      program `invariant check` compiled for the pair. The Changes are the
 *      proposer's drafts, with every decision they leave open answered by the
 *      auto-provider, each answer labelled synthetic; or, where a pair has
 *      Changes committed under `changes/<from>..<to>/`, those.
 *
 * Suite-green is recorded, and is not the measure: the mock's answers are
 * canned and the SDKs are leniently typed, so a suite passes through a great
 * deal. What is counted is every exchange the SDK made, seen by a recording
 * forwarder in front of whatever it called: a 400 from the mock, which means
 * the new specification refused what the old SDK sent, and an answer that the
 * old specification does not allow, judged by rig C's oracle, which shares no
 * code with the product. In arm c a second forwarder sits between the proxy
 * and the mock, so the mock's own 400s are counted where the mock gave them
 * and every answer the proxy changed is known.
 *
 * Heavy: a Stripe-sized document through the gate, a mock and two suites per
 * arm. It runs in CI, one job per pair, with no secrets and no token, because
 * it executes code this project did not write.
 *
 * Usage:
 *   node --import tsx proving/stripe/run.mts [--pair f4ac6d9..3881db8]
 *     [--suites node,python] [--no-gate] [--workers 2]
 *   node --import tsx proving/stripe/run.mts --report <results.json>...
 *
 * `--no-gate` runs arms a and b alone, for trying the harness without the
 * gate, which on documents this size needs up to 4 GB of its own.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  Agent,
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { ROOT } from "../corpus/manifest.mts";
import { readJunit } from "../servers/pairs.ts";
import { Oracle } from "../traffic/oracle.mts";
import {
  type ArmTally,
  type Commit,
  differs,
  type Exchange,
  place,
  programSites,
  render,
  type StripeGate,
  type StripePair,
  type StripeResults,
  tally,
  templateMatcher,
} from "./summary.ts";

const run = promisify(execFile);

interface PinnedCommit {
  commit: string;
  apiVersion: string;
  spec: string;
  fixtures: string;
}

interface SdkRelease {
  tag: string;
  commit: string;
}

interface Manifest {
  stripeMock: {
    version: string;
    assets: Record<string, { url: string; sha256: string }>;
  };
  commits: PinnedCommit[];
  sdks: Record<string, { repo: string; releases: Record<string, SdkRelease> }>;
}

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};

const CACHE = join(ROOT, ".cache/stripe");
/** Where the SDK calls in every arm: a recording forwarder, whatever is behind it. */
const SUITE_PORT = 12_111;
const MOCK_PORT = 12_121;
const PROXY_PORT = 12_131;
const INNER_PORT = 12_141;
/** Carried from the outer forwarder to the inner one, so the two sides of the proxy pair up. */
const EXCHANGE_HEADER = "x-proving-exchange";
/**
 * The heap the gate is given on a pair. Stripe's documents are about the
 * largest a provider publishes, and the gate has to fit a CI runner on them.
 */
const GATE_HEAP_MB = 4096;
/** How long one suite may run before it is stopped, with everything it started. */
const SUITE_MINUTES = 30;

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

/** A step that reaches a package index or a download host, tried again after a pause. */
async function patiently<T>(step: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await step();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await sleep(attempt * 15_000);
    }
  }
}

/** A file by URL, kept only when its SHA-256 is the one pinned. */
async function pinned(url: string, sha256: string, path: string): Promise<string> {
  if (existsSync(path)) {
    const held = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    if (held === sha256) return path;
  }
  const body = await patiently(async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  });
  const actual = createHash("sha256").update(body).digest("hex");
  if (actual !== sha256) {
    throw new Error(`${url} has SHA-256 ${actual}, not the pinned ${sha256}`);
  }
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, body);
  return path;
}

/** The mock's release binary for this machine, verified and unpacked. */
async function stripeMock(manifest: Manifest): Promise<string> {
  const platform = `${process.platform}-${process.arch}`;
  const asset = manifest.stripeMock.assets[platform];
  if (!asset) throw new Error(`stripe-mock is not pinned for ${platform}`);
  const dir = join(CACHE, "stripe-mock", manifest.stripeMock.version);
  const binary = join(dir, "stripe-mock");
  const archive = await pinned(asset.url, asset.sha256, join(dir, "stripe-mock.tar.gz"));
  if (!existsSync(binary)) await sh("tar", ["-xzf", archive, "-C", dir]);
  return binary;
}

/** The commit's specification and fixtures, both from that commit. */
async function documentsOf(
  commit: PinnedCommit,
): Promise<{ spec: string; fixtures: string }> {
  const base = `https://raw.githubusercontent.com/stripe/openapi/${commit.commit}/openapi`;
  const dir = join(CACHE, "openapi", commit.commit);
  const [spec, fixtures] = await Promise.all([
    pinned(`${base}/spec3.sdk.json`, commit.spec, join(dir, "spec3.sdk.json")),
    pinned(`${base}/fixtures3.json`, commit.fixtures, join(dir, "fixtures3.json")),
  ]);
  return { spec, fixtures };
}

/** A repository's files at one commit, fetched by the tag that names it. */
async function checkout(repo: string, release: SdkRelease, dir: string): Promise<string> {
  if (existsSync(join(dir, ".git"))) {
    const head = (await sh("git", ["rev-parse", "HEAD"], { cwd: dir })).trim();
    if (head === release.commit) return dir;
    await rm(dir, { recursive: true, force: true });
  }
  await mkdir(dir, { recursive: true });
  const git = (...argv: string[]) => sh("git", argv, { cwd: dir });
  await git("init", "-q");
  await git("remote", "add", "origin", `https://github.com/${repo}.git`);
  await patiently(() =>
    git("fetch", "-q", "--depth", "1", "origin", `refs/tags/${release.tag}`),
  );
  await git("checkout", "-q", "FETCH_HEAD");
  const head = (await git("rev-parse", "HEAD")).trim();
  if (head !== release.commit) {
    throw new Error(
      `${repo} ${release.tag} is ${head}, not the pinned ${release.commit}`,
    );
  }
  return dir;
}

/** How each SDK's suite is installed and run, as its own repository runs it. */
interface Suite {
  name: string;
  /** The checked-out suite, installed. */
  prepare(src: string): Promise<void>;
  /** The command that runs it, writing a JUnit report to `report`. */
  command(src: string, report: string): string[];
  env(port: number): Record<string, string>;
}

/**
 * How many processes each suite runs its tests in. Unset, each suite takes
 * its own default, one per core, as its CI does; a laptop under a memory cap
 * asks for fewer.
 */
const WORKERS = option("workers");

const YARN = ["npx", "--yes", "yarn@1.22.22"];

const SUITES: Record<string, Suite> = {
  // stripe-node's CI: `yarn`, then `tsc -p tsconfig.cjs.json && mocha`. Its
  // suite reaches stripe-mock through STRIPE_MOCK_HOST and STRIPE_MOCK_PORT.
  // Mocha's own xunit reporter writes the report; nothing else is changed.
  node: {
    name: "node",
    async prepare(src) {
      const [yarn, ...rest] = YARN as [string, ...string[]];
      await patiently(() =>
        sh(yarn, [...rest, "install", "--frozen-lockfile", "--ignore-engines"], {
          cwd: src,
          // The suite is checked out under this repository, whose own
          // package.json names pnpm, and yarn would otherwise read that as
          // the suite's package manager and refuse.
          env: { ...process.env, SKIP_YARN_COREPACK_CHECK: "1" },
        }),
      );
      await sh(join(src, "node_modules/.bin/tsc"), ["-p", "tsconfig.cjs.json"], {
        cwd: src,
      });
    },
    command(src, report) {
      return [
        join(src, "node_modules/.bin/mocha"),
        ...(WORKERS ? ["--jobs", WORKERS] : []),
        "--reporter",
        "xunit",
        "--reporter-option",
        `output=${report}`,
      ];
    },
    env(port) {
      return { STRIPE_MOCK_HOST: "127.0.0.1", STRIPE_MOCK_PORT: String(port) };
    },
  },
  // stripe-python's CI: its test requirements into a virtual environment and
  // `pytest`, which reads STRIPE_MOCK_PORT and calls localhost.
  python: {
    name: "python",
    async prepare(src) {
      const env = join(src, ".venv");
      if (!existsSync(join(env, "bin", "python"))) {
        await sh("uv", ["venv", "--quiet", "--python", "3.12", env], { cwd: src });
      }
      await patiently(() =>
        sh(
          "uv",
          [
            "pip",
            "install",
            "--quiet",
            "--python",
            join(env, "bin", "python"),
            "-e",
            ".",
            "-r",
            "deps/test-requirements.txt",
          ],
          { cwd: src },
        ),
      );
    },
    command(src, report) {
      return [
        join(src, ".venv", "bin", "python"),
        "-m",
        "pytest",
        "-q",
        "-p",
        "no:cacheprovider",
        ...(WORKERS ? ["-n", WORKERS] : []),
        `--junitxml=${report}`,
      ];
    },
    env(port) {
      return { STRIPE_MOCK_PORT: String(port) };
    },
  },
};

/** Each suite named, checked out at the release pinned to `apiVersion`, and installed. */
async function suitesFor(
  manifest: Manifest,
  apiVersion: string,
  names: string[],
): Promise<{ suite: Suite; src: string; tag: string }[]> {
  const out: { suite: Suite; src: string; tag: string }[] = [];
  for (const name of names) {
    const sdk = manifest.sdks[name];
    const suite = SUITES[name];
    const release = sdk?.releases[apiVersion];
    if (!sdk || !suite || !release) {
      throw new Error(`no ${name} release is pinned to ${apiVersion}`);
    }
    const src = await checkout(sdk.repo, release, join(CACHE, "sdks", name, release.tag));
    const marker = join(src, ".proving-installed");
    if (!existsSync(marker)) {
      log(`  installing ${name} ${release.tag}`);
      await suite.prepare(src);
      await writeFile(marker, "", "utf8");
    }
    out.push({ suite, src, tag: release.tag });
  }
  return out;
}

/** Runs one suite to its report; a failing suite exits non-zero, which is fine. */
async function runSuite(
  entry: { suite: Suite; src: string },
  report: string,
): Promise<{
  outcomes: Record<string, "passed" | "failed" | "skipped">;
  error?: string;
}> {
  await rm(report, { force: true });
  const [command, ...rest] = entry.suite.command(entry.src, report) as [
    string,
    ...string[],
  ];
  const timedOut = await new Promise<boolean>((done) => {
    const child = spawn(command, rest, {
      cwd: entry.src,
      env: { ...process.env, ...entry.suite.env(SUITE_PORT) },
      stdio: ["ignore", "ignore", "inherit"],
      detached: true,
    });
    const timer = setTimeout(() => {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
      done(true);
    }, SUITE_MINUTES * 60_000);
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
  const { outcomes } = readJunit(await readFile(report, "utf8"));
  return { outcomes };
}

async function waitFor(url: string, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2_000) });
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`${what} did not answer at ${url} within ${timeoutMs / 1000}s`);
}

async function startMock(
  binary: string,
  documents: { spec: string; fixtures: string },
): Promise<ChildProcess> {
  const mock = spawn(
    binary,
    [
      "-http-addr",
      `127.0.0.1:${MOCK_PORT}`,
      "-spec",
      documents.spec,
      "-fixtures",
      documents.fixtures,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  await waitFor(`http://127.0.0.1:${MOCK_PORT}/`, "stripe-mock", 120_000);
  return mock;
}

async function startProxy(
  program: unknown,
  oldLabel: string,
  work: string,
): Promise<ChildProcess> {
  const programPath = join(work, "program.json");
  const configPath = join(work, "sidecar.json");
  await writeFile(programPath, JSON.stringify(program), "utf8");
  await writeFile(
    configPath,
    JSON.stringify({
      program: programPath,
      upstream: `http://127.0.0.1:${INNER_PORT}`,
      listen: { port: PROXY_PORT, host: "127.0.0.1" },
      // Stripe-Version is the contract label, which each SDK release sends
      // on every request: the old commit's API version.
      identity: [
        { kind: "header", name: "Stripe-Version" },
        { kind: "default", label: oldLabel },
      ],
      maxBodyBytes: 32 * 1024 * 1024,
    }),
    "utf8",
  );
  const proxy = spawn(
    process.execPath,
    ["--import", "tsx", join(ROOT, "packages/sidecar/src/cli.ts"), configPath],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  await waitFor(`http://127.0.0.1:${PROXY_PORT}/__invariant/health`, "the proxy", 60_000);
  return proxy;
}

function decoded(body: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? "").toLowerCase()) {
    case "gzip":
      return gunzipSync(body);
    case "deflate":
      return inflateSync(body);
    case "br":
      return brotliDecompressSync(body);
    default:
      return body;
  }
}

interface Recorder {
  exchanges: Exchange[];
  close(): Promise<void>;
}

/**
 * A forwarder that writes down every exchange and changes nothing. It
 * listens on 127.0.0.1 and ::1 both, because stripe-python calls `localhost`
 * and a resolver may give either.
 *
 * `outer` numbers each request and sends the number on, so the forwarder on
 * the far side of the proxy files its copy under the same one.
 */
async function record(port: number, target: number, outer: boolean): Promise<Recorder> {
  const exchanges: Exchange[] = [];
  const agent = new Agent({ keepAlive: true });
  let next = 0;
  const handler = (incoming: IncomingMessage, outgoing: ServerResponse) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const headers: IncomingHttpHeaders = { ...incoming.headers };
      let seq: number;
      if (outer) {
        seq = next++;
        headers[EXCHANGE_HEADER] = String(seq);
      } else {
        const carried = headers[EXCHANGE_HEADER];
        // A request the proxy made up itself carries no number, and pairs with nothing.
        seq = typeof carried === "string" ? Number(carried) : -1 - next++;
        delete headers[EXCHANGE_HEADER];
      }
      const url = new URL(incoming.url ?? "/", "http://recorder");
      const forward = httpRequest(
        {
          host: "127.0.0.1",
          port: target,
          method: incoming.method,
          path: incoming.url,
          headers,
          agent,
        },
        (answer) => {
          const parts: Buffer[] = [];
          answer.on("data", (chunk: Buffer) => parts.push(chunk));
          answer.on("end", () => {
            const raw = Buffer.concat(parts);
            let body: unknown;
            if (
              /json/i.test(String(answer.headers["content-type"] ?? "")) &&
              raw.length > 0
            ) {
              try {
                body = JSON.parse(
                  decoded(
                    raw,
                    answer.headers["content-encoding"] as string | undefined,
                  ).toString("utf8"),
                );
              } catch {
                body = undefined;
              }
            }
            const contract = answer.headers["invariant-contract"];
            const version = incoming.headers["stripe-version"];
            exchanges.push({
              seq,
              method: (incoming.method ?? "GET").toUpperCase(),
              path: url.pathname,
              status: answer.statusCode ?? 0,
              ...(body === undefined ? {} : { body }),
              ...(typeof contract === "string" ? { contract } : {}),
              ...(typeof version === "string" ? { version } : {}),
            });
            outgoing.writeHead(answer.statusCode ?? 502, answer.rawHeaders);
            outgoing.end(raw);
          });
        },
      );
      forward.on("error", (error) => {
        exchanges.push({
          seq,
          method: (incoming.method ?? "GET").toUpperCase(),
          path: url.pathname,
          status: 502,
        });
        outgoing.writeHead(502, { "content-type": "text/plain" });
        outgoing.end(`the recorder could not reach its target: ${error.message}`);
      });
      forward.end(Buffer.concat(chunks));
    });
  };
  const servers: Server[] = [];
  for (const host of ["127.0.0.1", "::1"]) {
    const server = createServer(handler);
    const listening = await new Promise<boolean>((done) => {
      server.once("error", () => done(false));
      server.listen(port, host, () => done(true));
    });
    if (listening) servers.push(server);
    else if (host === "127.0.0.1")
      throw new Error(`the recorder could not listen on ${port}`);
  }
  return {
    exchanges,
    async close() {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((done) => {
              server.closeAllConnections();
              server.close(() => done());
            }),
        ),
      );
      agent.destroy();
    },
  };
}

/** What an arm's exchanges and suites come to, judged against the old contract. */
function tallyArm(
  suites: Record<
    string,
    { outcomes: Record<string, "passed" | "failed" | "skipped">; error?: string }
  >,
  outer: readonly Exchange[],
  mockSide: readonly Exchange[],
  oracle: Oracle,
  match: (method: string, path: string) => string | undefined,
  pinned: string,
): ArmTally {
  const outcomes: ArmTally["outcomes"] = {};
  const counts: ArmTally["suites"] = {};
  for (const [name, result] of Object.entries(suites)) {
    let passed = 0;
    let failed = 0;
    for (const [id, outcome] of Object.entries(result.outcomes)) {
      outcomes[`${name}::${id}`] = outcome;
      if (outcome === "passed") passed += 1;
      if (outcome === "failed") failed += 1;
    }
    counts[name] = { passed, failed, ...(result.error ? { error: result.error } : {}) };
  }
  const siteOf = (exchange: Exchange) => {
    const template = match(exchange.method, exchange.path);
    return { template, site: `${exchange.method} ${template ?? exchange.path}` };
  };
  // A test that asks for another API version on purpose is asking about a
  // contract the pair does not hold, which the proxy refuses by name and the
  // mock answers regardless. Set aside in every arm alike, and counted.
  const other = new Set(
    outer
      .filter((exchange) => exchange.version !== undefined && exchange.version !== pinned)
      .map((exchange) => exchange.seq),
  );
  const mock400: Record<string, number> = {};
  for (const exchange of mockSide) {
    if (other.has(exchange.seq)) continue;
    if (exchange.status !== 400) continue;
    const { site } = siteOf(exchange);
    mock400[site] = (mock400[site] ?? 0) + 1;
  }
  const violations: Record<string, number> = {};
  let unjudged = 0;
  for (const exchange of outer) {
    if (other.has(exchange.seq)) continue;
    const { template, site } = siteOf(exchange);
    if (template === undefined || exchange.body === undefined) {
      unjudged += 1;
      continue;
    }
    const found = oracle.response(
      { method: exchange.method, path: template },
      exchange.status,
      exchange.body,
    );
    if (found === undefined) {
      unjudged += 1;
      continue;
    }
    for (const violation of found) {
      const key = `${site} ${exchange.status} ${place(violation.pointer)}: ${violation.message}`;
      violations[key] = (violations[key] ?? 0) + 1;
    }
  }
  return {
    outcomes,
    suites: counts,
    exchanges: outer.length,
    mock400,
    violations,
    unjudged,
    otherVersion: other.size,
  };
}

const none = (error: string): ArmTally => ({
  outcomes: {},
  suites: {},
  exchanges: 0,
  mock400: {},
  violations: {},
  unjudged: 0,
  error,
});

async function runPair(
  manifest: Manifest,
  fromPin: PinnedCommit,
  toPin: PinnedCommit,
  suiteNames: string[],
  gated: boolean,
): Promise<StripePair> {
  const id = `${fromPin.commit.slice(0, 7)}..${toPin.commit.slice(0, 7)}`;
  const work = join(CACHE, "pairs", id);
  await mkdir(work, { recursive: true });
  const from: Commit = {
    commit: fromPin.commit,
    apiVersion: fromPin.apiVersion,
    label: fromPin.apiVersion,
  };
  // Two commits of one API version are two contracts all the same.
  const to: Commit = {
    commit: toPin.commit,
    apiVersion: toPin.apiVersion,
    label:
      toPin.apiVersion === fromPin.apiVersion
        ? `${toPin.apiVersion}+${toPin.commit.slice(0, 7)}`
        : toPin.apiVersion,
  };
  log(`stripe/openapi ${id} (${from.apiVersion} -> ${to.apiVersion})`);

  const [binary, oldDocs, newDocs] = await Promise.all([
    stripeMock(manifest),
    documentsOf(fromPin),
    documentsOf(toPin),
  ]);
  let suites: Awaited<ReturnType<typeof suitesFor>>;
  try {
    suites = await suitesFor(manifest, fromPin.apiVersion, suiteNames);
  } catch (error) {
    // Reported as a pair that could not run, beside the ones that could.
    const why = `the suites could not be installed: ${error instanceof Error ? error.message : String(error)}`;
    return {
      from,
      to,
      sdks: {},
      gate: {
        result: "block",
        drafted: 0,
        decided: 0,
        unexplained: [],
        unservable: [why],
      },
      arms: { a: none(why), b: none(why), c: none(why) },
      programSites: 0,
      adapted: { exchanges: 0, sites: [] },
    };
  }
  const sdks = Object.fromEntries(suites.map((entry) => [entry.suite.name, entry.tag]));

  const oldDocument = JSON.parse(await readFile(oldDocs.spec, "utf8")) as Record<
    string,
    unknown
  >;
  const oracle = new Oracle(oldDocument as never);
  const match = templateMatcher(
    Object.keys((oldDocument["paths"] ?? {}) as Record<string, unknown>),
  );

  const arm = async (
    label: string,
    documents: { spec: string; fixtures: string },
    program?: unknown,
  ): Promise<{ tally: ArmTally; outer: Exchange[]; inner: Exchange[] }> => {
    log(`  arm ${label}: ${program ? "through the proxy to " : ""}stripe-mock`);
    const started: ChildProcess[] = [];
    const recorders: Recorder[] = [];
    try {
      started.push(await startMock(binary, documents));
      let inner: Recorder | undefined;
      if (program) {
        inner = await record(INNER_PORT, MOCK_PORT, false);
        recorders.push(inner);
        started.push(await startProxy(program, from.label, work));
      }
      const outer = await record(SUITE_PORT, program ? PROXY_PORT : MOCK_PORT, true);
      recorders.push(outer);
      const results: Record<
        string,
        { outcomes: Record<string, "passed" | "failed" | "skipped">; error?: string }
      > = {};
      for (const entry of suites) {
        log(`    ${entry.suite.name} ${entry.tag}`);
        results[entry.suite.name] = await runSuite(
          entry,
          join(work, `${label}-${entry.suite.name}.xml`),
        );
      }
      const innerExchanges = inner?.exchanges ?? outer.exchanges;
      return {
        tally: tallyArm(
          results,
          outer.exchanges,
          innerExchanges,
          oracle,
          match,
          from.apiVersion,
        ),
        outer: [...outer.exchanges],
        inner: [...(inner?.exchanges ?? [])],
      };
    } catch (error) {
      return {
        tally: none(error instanceof Error ? error.message : String(error)),
        outer: [],
        inner: [],
      };
    } finally {
      await Promise.all(recorders.map((recorder) => recorder.close()));
      for (const child of started.reverse()) child.kill("SIGTERM");
      await sleep(500);
    }
  };

  const a = (await arm("a", oldDocs)).tally;
  const b = (await arm("b", newDocs)).tally;

  let gate: StripeGate;
  let c: ArmTally;
  let sites: string[] = [];
  let adapted = { exchanges: 0, sites: [] as string[] };
  if (!gated) {
    gate = {
      result: "block",
      drafted: 0,
      decided: 0,
      unexplained: [],
      unservable: ["not checked (--no-gate)"],
    };
    c = none("the gate was not run");
  } else {
    try {
      log("  the gate: checking the pair's Changes");
      const began = Date.now();
      const checked = await gateApart(
        from,
        to,
        { from: oldDocs.spec, to: newDocs.spec },
        work,
      );
      log(
        `  the gate says ${checked.gate.result} after ${Math.round((Date.now() - began) / 1000)}s ` +
          `(${checked.gate.drafted} drafted, ${checked.gate.decided} answered synthetically)`,
      );
      gate = checked.gate;
      if (checked.program) {
        sites = programSites(checked.program, from.label);
        const ran = await arm("c", newDocs, checked.program);
        c = ran.tally;
        const inner = new Map(ran.inner.map((exchange) => [exchange.seq, exchange]));
        const touched = new Set<string>();
        let count = 0;
        for (const exchange of ran.outer) {
          const behind = inner.get(exchange.seq);
          // An answer the proxy gave itself, or one it changed on the way back.
          if (behind === undefined || differs(behind, exchange)) {
            count += 1;
            touched.add(
              `${exchange.method} ${match(exchange.method, exchange.path) ?? exchange.path}`,
            );
          }
        }
        adapted = { exchanges: count, sites: [...touched].sort() };
      } else {
        c = none("the gate blocks the pair, so there is no program to run");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      gate = {
        result: "block",
        drafted: 0,
        decided: 0,
        unexplained: [],
        unservable: [message],
      };
      c = none(message);
    }
  }
  return {
    from,
    to,
    sdks,
    gate,
    arms: { a, b, c },
    programSites: sites.length,
    adapted,
  };
}

/**
 * The gate in a process of its own (see gate.mts), held to the 4 GB a
 * provider's CI runner can give it. A pair whose documents need more is
 * recorded as blocked, with the reason, rather than taking the arms that
 * already ran down with it.
 */
async function gateApart(
  from: Commit,
  to: Commit,
  documents: { from: string; to: string },
  work: string,
): Promise<{ gate: StripeGate; program: unknown }> {
  const input = join(work, "gate-input.json");
  const output = join(work, "gate-output.json");
  await rm(output, { force: true });
  await writeFile(input, JSON.stringify({ from, to, documents, work }), "utf8");
  const child = spawn(
    process.execPath,
    [
      `--max-old-space-size=${GATE_HEAP_MB}`,
      "--import",
      "tsx",
      join(ROOT, "proving/stripe/gate.mts"),
      input,
      output,
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  const [code, signal] = (await once(child, "exit")) as [number | null, string | null];
  if (code !== 0) {
    throw new Error(
      code === 134 || signal === "SIGABRT"
        ? `the gate ran out of its ${GATE_HEAP_MB / 1024} GB heap on this pair's documents`
        : `the gate exited with ${code ?? signal}`,
    );
  }
  return JSON.parse(await readFile(output, "utf8")) as {
    gate: StripeGate;
    program: unknown;
  };
}

async function readManifest(): Promise<Manifest> {
  return JSON.parse(
    await readFile(join(ROOT, "proving/stripe/manifest.json"), "utf8"),
  ) as Manifest;
}

const reportInputs = args.includes("--report")
  ? args.slice(args.indexOf("--report") + 1).filter((arg) => !arg.startsWith("--"))
  : undefined;

if (process.argv[1]?.endsWith("run.mts") && reportInputs) {
  // The pairs ran as separate jobs; this is the one report they add up to,
  // in the order of the history rather than the order the jobs finished.
  const manifest = await readManifest();
  const order = manifest.commits.map((commit) => commit.commit);
  const pairs: StripePair[] = [];
  let stripeMockVersion = manifest.stripeMock.version;
  for (const input of reportInputs) {
    const read = JSON.parse(await readFile(input, "utf8")) as StripeResults;
    stripeMockVersion = read.stripeMock;
    pairs.push(...read.pairs);
  }
  pairs.sort((x, y) => order.indexOf(x.from.commit) - order.indexOf(y.from.commit));
  const results: StripeResults = { stripeMock: stripeMockVersion, pairs };
  await writeFile(
    join(ROOT, "proving/stripe/results.json"),
    `${JSON.stringify(results, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(ROOT, "proving/stripe/REPORT.md"), render(results), "utf8");
  log(`${pairs.length} pairs, report written`);
} else if (process.argv[1]?.endsWith("run.mts")) {
  const manifest = await readManifest();
  const wanted = option("pair");
  const suiteNames = (option("suites") ?? "node,python").split(",").filter(Boolean);
  const gated = !args.includes("--no-gate");
  const pairs: [PinnedCommit, PinnedCommit][] = [];
  for (let index = 1; index < manifest.commits.length; index += 1) {
    const from = manifest.commits[index - 1] as PinnedCommit;
    const to = manifest.commits[index] as PinnedCommit;
    const id = `${from.commit.slice(0, 7)}..${to.commit.slice(0, 7)}`;
    if (wanted === undefined || wanted === id) pairs.push([from, to]);
  }
  if (pairs.length === 0) throw new Error(`no pair ${wanted} in the manifest`);

  const results: StripeResults = { stripeMock: manifest.stripeMock.version, pairs: [] };
  for (const [from, to] of pairs) {
    results.pairs.push(await runPair(manifest, from, to, suiteNames, gated));
  }
  const partial = wanted !== undefined || option("suites") !== undefined || !gated;
  const out = partial
    ? join(CACHE, `results-${wanted ?? "all"}.json`)
    : join(ROOT, "proving/stripe/results.json");
  await mkdir(CACHE, { recursive: true });
  await writeFile(out, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  const report = render(results);
  log(`\n${report}`);
  if (!partial) await writeFile(join(ROOT, "proving/stripe/REPORT.md"), report, "utf8");
  log(`results in ${out}`);
  const counted = tally(results);
  // Only what the adapter made worse fails the run: violations it did not
  // serve are the measurement, and are reported rather than raised.
  const worse = results.pairs.filter((pair) => {
    if (pair.arms.c.error) return false;
    const cKeys = Object.keys(pair.arms.c.violations).filter(
      (key) => !(key in pair.arms.b.violations) && !(key in pair.arms.a.violations),
    );
    const c400 = Object.keys(pair.arms.c.mock400).filter(
      (key) => !(key in pair.arms.b.mock400) && !(key in pair.arms.a.mock400),
    );
    return cKeys.length > 0 || c400.length > 0;
  });
  if (worse.length > 0) {
    log(
      `the adapter made ${worse.length} of ${counted.pairs} pairs worse than no adapter at all`,
    );
    process.exit(1);
  }
}
