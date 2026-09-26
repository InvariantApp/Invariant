/**
 * L11: the proxy under a steady load for a day, while everything around it
 * goes wrong.
 *
 * One proxy process, the sidecar exactly as a provider runs it, fronts the
 * fixture provider's current contract and serves its two released ones from
 * the committed program. A caller in this process sends a stated number of
 * requests a second under all three contracts, and the upstream, also here,
 * stalls, resets, cuts bodies short, dribbles them, answers late and answers
 * with more than the proxy buffers, as each request asks; the caller sends
 * slow and oversized bodies of its own. Meanwhile the kill switch is flipped,
 * the program is replaced (and now and then replaced with one that does not
 * load), and the proxy is stopped and started again.
 *
 * Every response is judged by the independent oracle (Ajv, proving/traffic)
 * against the contract the caller named: a success against its schema, and
 * anything else against the contract's own error, since that is all an old
 * caller can read. Every body the proxy sends upstream is judged against the
 * current contract. The proxy's memory and sockets are sampled throughout.
 *
 * Cheap on purpose, so it can run for 14 hours on a laptop or any machine:
 * 50 requests a second, one proxy, one driver. It writes a checkpoint as it
 * goes and `results.json` at the end; `--record` also writes the results the
 * scoreboard reads.
 *
 *   node --import tsx proving/soak/soak.mts [--hours 24 | --minutes 10] [--rps 50]
 *     [--seed 1] [--out .cache/soak/<start>] [--record]
 *     [--modes normal,stall,...] [--calm]
 *
 * `--modes` narrows what goes wrong upstream to the modes named, and
 * `--calm` leaves the kill switch, the program and the process alone: both
 * for finding which disturbance a failure needs.
 *
 * Exits non-zero when a response fails its contract, a request goes
 * unanswered outside a restart, the proxy crashes or a socket is left open,
 * whatever the run's length.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { Agent, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Oracle } from "../traffic/oracle.mts";
import {
  BUDGET,
  CHAOS_HEADER,
  CONTRACTS,
  type Contract,
  FLAG_STATES,
  judge,
  MODE_WEIGHTS,
  type Mode,
  type Planned,
  percentile,
  plan,
  type RssSample,
  random,
  round,
  rssTrend,
  type SoakResults,
  scheduleFor,
  VERSION_HEADER,
} from "./plan.ts";
import { startUpstream } from "./upstream.ts";

const ROOT = join(import.meta.dirname, "../..");
const ACME = join(ROOT, "fixtures/provider-acme");
const SIDECAR = join(ROOT, "packages/sidecar/src/cli.ts");
const MAX_BODY_BYTES = 256 * 1024;
const UPSTREAM_TIMEOUT_MS = 2_000;
const CLIENT_TIMEOUT_MS = 30_000;
const SAMPLE_MS = 10_000;
const SAMPLE_LIMIT = 50;
const IN_FLIGHT_LIMIT = 1_000;

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const minutes = option("minutes");
const durationMs =
  minutes !== undefined
    ? Number(minutes) * 60_000
    : Number(option("hours") ?? BUDGET.hours) * 3_600_000;
const rps = Number(option("rps") ?? BUDGET.rps);
const seed = Number(option("seed") ?? 1);
const started = new Date();
const out =
  option("out") ?? join(ROOT, ".cache/soak", started.toISOString().replace(/[:.]/g, "-"));
const schedule = scheduleFor(durationMs);
const modes = (option("modes")?.split(",") ?? Object.keys(MODE_WEIGHTS)) as Mode[];
/** No flips, reloads or restarts: the load and the upstream's chaos alone. */
const calm = args.includes("--calm");

function log(message: string): void {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

/** Written whole or not at all, so a checkpoint read mid-run is never half one. */
async function writeAtomically(path: string, text: string): Promise<void> {
  await writeFile(`${path}.tmp`, text, "utf8");
  await rename(`${path}.tmp`, path);
}

/**
 * The contract a caller named, with every status it does not describe judged
 * as its own error: a proxy's 502 or 413 is only readable to an old caller if
 * it is shaped the way that caller's contract shapes errors.
 */
async function oracleFor(file: string): Promise<Oracle> {
  const document = JSON.parse(await readFile(join(ACME, "openapi", file), "utf8"));
  const paths = document.paths as Record<
    string,
    Record<string, { responses: Record<string, unknown> }>
  >;
  for (const item of Object.values(paths)) {
    for (const operation of Object.values(item)) {
      operation.responses.default ??= { $ref: "#/components/responses/BadRequest" };
    }
  }
  return new Oracle(document);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** The proxy's resident memory in MB, from the operating system. */
function rssOf(pid: number): number | undefined {
  try {
    if (existsSync(`/proc/${pid}/status`)) {
      const kb = /VmRSS:\s+(\d+) kB/.exec(
        readFileSync(`/proc/${pid}/status`, "utf8"),
      )?.[1];
      return kb === undefined ? undefined : Number(kb) / 1024;
    }
    const kb = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
      encoding: "utf8",
    });
    return Number(kb.trim()) / 1024;
  } catch {
    return undefined;
  }
}

/** Sockets the proxy holds open, where the platform says. */
function socketsOf(pid: number): number | undefined {
  try {
    if (existsSync(`/proc/${pid}/fd`)) {
      let count = 0;
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        try {
          if (readlinkSync(`/proc/${pid}/fd/${fd}`).startsWith("socket:")) count += 1;
        } catch {
          // Closed between listing and reading.
        }
      }
      return count;
    }
    const listed = execFileSync("lsof", ["-a", "-i", "-n", "-P", "-p", String(pid)], {
      encoding: "utf8",
    });
    return Math.max(0, listed.trim().split("\n").length - 1);
  } catch {
    return undefined;
  }
}

function healthy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const call = httpRequest(
      { host: "127.0.0.1", port, path: "/__invariant/health", agent: false },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    call.on("error", () => resolve(false));
    call.setTimeout(2_000, () => call.destroy());
    call.end();
  });
}

interface Exchange {
  status?: number;
  headers?: IncomingHttpHeaders;
  text?: string;
  error?: string;
  ms: number;
}

const agent = new Agent({ keepAlive: true, maxSockets: 256 });

function send(port: number, planned: Planned, sequence: number): Promise<Exchange> {
  const began = performance.now();
  return new Promise((resolve) => {
    let settled = false;
    const done = (exchange: Omit<Exchange, "ms">) => {
      if (settled) return;
      settled = true;
      resolve({ ...exchange, ms: performance.now() - began });
    };
    let body: string | undefined;
    if (planned.body) {
      body = JSON.stringify(
        planned.mode === "bloated"
          ? { ...planned.body, description: "y".repeat(MAX_BODY_BYTES + 1024) }
          : planned.body,
      );
    }
    const headers: Record<string, string> = {
      [VERSION_HEADER]: planned.contract,
      [CHAOS_HEADER]: planned.mode,
      "soak-request": String(sequence),
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(body));
    }
    const call = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: planned.operation.method,
        path: planned.operation.path,
        headers,
        agent,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          done({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.on("aborted", () => done({ error: "the response was cut short" }));
        response.on("error", (error: NodeJS.ErrnoException) =>
          done({ error: error.code ?? error.message }),
        );
      },
    );
    call.setTimeout(CLIENT_TIMEOUT_MS, () => call.destroy(new Error("no answer in 30s")));
    call.on("error", (error: NodeJS.ErrnoException) =>
      done({ error: error.code ?? error.message }),
    );
    if (body === undefined) {
      call.end();
    } else if (planned.mode === "trickle") {
      const bytes = Buffer.from(body);
      const size = Math.ceil(bytes.length / 5);
      let sent = 0;
      const next = () => {
        if (call.destroyed) return;
        const piece = bytes.subarray(sent, sent + size);
        sent += piece.length;
        if (sent >= bytes.length) call.end(piece);
        else {
          call.write(piece);
          setTimeout(next, 150);
        }
      };
      next();
    } else {
      call.end(body);
    }
  });
}

const count = (map: Record<string, number>, key: string) => {
  map[key] = (map[key] ?? 0) + 1;
};

async function main(): Promise<void> {
  await mkdir(out, { recursive: true });
  const oracles: Record<Contract, Oracle> = {
    [CONTRACTS.oldest]: await oracleFor(`${CONTRACTS.oldest}.json`),
    [CONTRACTS.previous]: await oracleFor(`${CONTRACTS.previous}.json`),
    [CONTRACTS.current]: await oracleFor("head.json"),
  };
  const upstream = await startUpstream({
    oracle: oracles[CONTRACTS.current],
    maxBodyBytes: MAX_BODY_BYTES,
  });

  // The committed program, and the same program written out differently,
  // which a reload has to read and build afresh; now and then one that does
  // not load at all, which the proxy has to refuse while it keeps serving.
  const programText = await readFile(
    join(ACME, "invariant/compiled/program.json"),
    "utf8",
  );
  const programs = [programText, `${JSON.stringify(JSON.parse(programText), null, 1)}\n`];
  const broken = programText.slice(0, Math.floor(programText.length / 3));
  const programPath = join(out, "program.json");
  const flagsPath = join(out, "flags.json");
  const configPath = join(out, "sidecar.json");
  await writeFile(programPath, programs[0] as string, "utf8");
  await writeFile(flagsPath, "{}\n", "utf8");
  const port = await freePort();
  await writeFile(
    configPath,
    JSON.stringify(
      {
        program: programPath,
        upstream: upstream.url,
        listen: { port, host: "127.0.0.1" },
        maxBodyBytes: MAX_BODY_BYTES,
        upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
        flags: { file: flagsPath },
      },
      null,
      2,
    ),
    "utf8",
  );

  const proxyLog = join(out, "proxy.log");
  let proxy: ChildProcess | undefined;
  let incarnation = 0;
  let incarnationStarted = 0;
  let stopping = false;
  let restarting = false;
  let crashes = 0;
  const runStart = Date.now();

  const startProxy = async (): Promise<void> => {
    const logFd = openSync(proxyLog, "a");
    const child = spawn(process.execPath, ["--import", "tsx", SIDECAR, configPath], {
      cwd: ROOT,
      // Refusals are logged a line each on stdout; the proxy's own account
      // of reloads and failures is on stderr, which is kept.
      stdio: ["ignore", "ignore", logFd],
    });
    closeSync(logFd);
    proxy = child;
    incarnation += 1;
    incarnationStarted = Date.now();
    child.on("exit", (code, signal) => {
      if (proxy !== child || stopping || restarting) return;
      crashes += 1;
      log(`the proxy exited on its own (${code ?? signal}); starting it again`);
      proxy = undefined;
      restarting = true;
      void startProxy().finally(() => {
        restarting = false;
      });
    });
    const deadline = Date.now() + 60_000;
    while (!(await healthy(port))) {
      if (Date.now() > deadline) throw new Error("the proxy did not come up within 60s");
      await sleep(200);
    }
  };

  const stopProxy = async (): Promise<void> => {
    const child = proxy;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const inTime = await Promise.race([
      exited.then(() => true),
      sleep(40_000).then(() => false),
    ]);
    if (!inTime) {
      log("the proxy did not finish within 40s of SIGTERM; killing it");
      child.kill("SIGKILL");
      await exited;
    }
  };

  await startProxy();
  await sleep(1_000);
  const baselineSockets = socketsOf(proxy?.pid ?? 0);
  log(
    `soak: ${round(durationMs / 3_600_000, 3)} hours at ${rps} requests a second, proxy on port ${port}, writing to ${out}`,
  );

  // What happened, counted.
  const outcomes: Record<string, number> = {};
  const violations: string[] = [];
  let violationCount = 0;
  const transport = {
    duringRestart: 0,
    streamedCut: 0,
    otherwise: 0,
    samples: [] as string[],
  };
  let issued = 0;
  let completed = 0;
  let shed = 0;
  let inFlight = 0;
  let flips = 0;
  let reloads = 0;
  let brokenReloads = 0;
  let restarts = 0;
  /** When each restart began and ended, since the run started. */
  const windows: [number, number][] = [];
  let latencies: number[] = [];
  const rss: RssSample[] = [];
  let maxRss = 0;
  let maxSockets = 0;
  const next = random(seed);

  const violation = (planned: Planned, status: number | undefined, what: string) => {
    violationCount += 1;
    if (violations.length < SAMPLE_LIMIT) {
      violations.push(
        `${planned.contract} ${planned.operation.method} ${planned.operation.path} (${planned.mode}) ${status ?? "-"}: ${what}`.slice(
          0,
          600,
        ),
      );
    }
  };

  const judgeExchange = (
    planned: Planned,
    exchange: Exchange,
    sent: { at: number; restarting: boolean },
  ) => {
    completed += 1;
    if (exchange.error !== undefined) {
      // A body the upstream cut short reaches the caller cut short wherever
      // the proxy streams it, which it does for anything it has nothing to
      // translate: a current caller's answer, or an error no Change touches.
      const streamed = planned.mode === "cut";
      // Sent to a proxy on its way down, or answered while it was.
      const sentDuring = windows.some(
        ([from, to]) => sent.at >= from - 1_000 && sent.at <= to,
      );
      if (restarting || sent.restarting || sentDuring) {
        transport.duringRestart += 1;
      } else if (streamed) transport.streamedCut += 1;
      else {
        transport.otherwise += 1;
        if (transport.samples.length < SAMPLE_LIMIT) {
          transport.samples.push(
            `${planned.contract} ${planned.operation.method} ${planned.operation.path} (${planned.mode}), sent at ${round(sent.at / 1000, 1)}s: ${exchange.error}`,
          );
        }
      }
      count(
        outcomes,
        `${planned.contract} ${planned.mode} ${restarting ? "restart" : "transport"}`,
      );
      return;
    }
    const status = exchange.status as number;
    let body: unknown;
    try {
      body = JSON.parse(exchange.text ?? "");
    } catch {
      violation(
        planned,
        status,
        `the body is not JSON: ${(exchange.text ?? "").slice(0, 120)}`,
      );
      return;
    }
    const found = oracles[planned.contract].response(
      {
        method: planned.operation.method.toLowerCase(),
        path: planned.operation.template,
      },
      status,
      body,
    );
    if (found === undefined) {
      violation(planned, status, "the contract describes no such answer");
    } else if (found.length > 0) {
      violation(
        planned,
        status,
        found.map((entry) => `${entry.pointer} ${entry.message}`).join("; "),
      );
    }
    const code =
      status >= 400
        ? String(
            (body as { error?: { code?: unknown } } | null)?.error?.code ?? "upstream",
          )
        : "ok";
    count(outcomes, `${planned.contract} ${planned.mode} ${status} ${code}`);
    if (planned.mode === "normal" && status < 400) latencies.push(exchange.ms);
  };

  // The caller: an open loop at the stated rate, so a slow proxy meets more
  // requests, not fewer.
  const issue = () => {
    const due = Math.floor(((Date.now() - runStart) / 1000) * rps);
    while (issued < due) {
      issued += 1;
      const sequence = issued;
      const planned = plan(next, sequence, modes);
      if (inFlight >= IN_FLIGHT_LIMIT) {
        shed += 1;
        continue;
      }
      inFlight += 1;
      const sent = { at: Date.now() - runStart, restarting };
      void send(port, planned, sequence).then((exchange) => {
        inFlight -= 1;
        judgeExchange(planned, exchange, sent);
      });
    }
  };

  const sample = () => {
    const pid = proxy?.pid;
    if (!pid || restarting) return;
    const mb = rssOf(pid);
    const sockets = socketsOf(pid);
    if (mb !== undefined) {
      maxRss = Math.max(maxRss, mb);
      rss.push({
        at: Date.now() - runStart,
        incarnation,
        age: Date.now() - incarnationStarted,
        rssMb: round(mb, 2),
      });
    }
    if (sockets !== undefined) maxSockets = Math.max(maxSockets, sockets);
    void appendFile(
      join(out, "samples.jsonl"),
      `${JSON.stringify({ at: Date.now() - runStart, incarnation, rssMb: mb, sockets, inFlight, upstreamOpen: upstream.stats.open(), stalled: upstream.stats.stalled() })}\n`,
    );
  };

  const flip = async () => {
    flips += 1;
    const state = FLAG_STATES[flips % FLAG_STATES.length];
    await writeAtomically(flagsPath, `${JSON.stringify(state)}\n`);
  };

  let reloading: Promise<void> = Promise.resolve();
  const reload = async () => {
    // Not in the middle of a deploy, which ships its own program.
    if (restarting) return;
    reloads += 1;
    // Every fourth replacement does not load; the next one mends it.
    if (reloads % 4 === 0) {
      brokenReloads += 1;
      await writeFile(programPath, broken, "utf8");
    } else {
      await writeFile(programPath, programs[reloads % 2] as string, "utf8");
      // Half by the file changing, half by SIGHUP as well.
      if (reloads % 2 === 1) proxy?.kill("SIGHUP");
    }
  };

  const restart = async () => {
    restarts += 1;
    restarting = true;
    const began = Date.now() - runStart;
    log(`restarting the proxy at ${round((Date.now() - runStart) / 1000, 1)}s`);
    try {
      // A restart is a deploy, and a deploy ships a program that loads: the
      // proxy refuses to start on one that does not, as it should, which the
      // first ten-minute run found when a restart fell between a broken
      // replacement and its mend.
      await reloading;
      await writeFile(programPath, programs[reloads % 2] as string, "utf8");
      await stopProxy();
      await startProxy();
      // Connections the old process closed may still surface as errors.
      await sleep(1_000);
    } finally {
      restarting = false;
      windows.push([began, Date.now() - runStart]);
      log(`the proxy is back at ${round((Date.now() - runStart) / 1000, 1)}s`);
    }
  };

  const snapshot = () => {
    const elapsedMs = Date.now() - runStart;
    const trend = rssTrend(rss, schedule.warmupMs);
    return {
      startedAt: started.toISOString(),
      at: new Date().toISOString(),
      elapsedHours: round(elapsedMs / 3_600_000, 4),
      rps: { stated: rps, achieved: round(issued / (elapsedMs / 1000), 2) },
      requests: { issued, completed, shed, inFlight },
      violations: violationCount,
      transport: { ...transport, samples: undefined },
      upstream: {
        requests: upstream.stats.requests,
        requestViolations: upstream.stats.requestViolations,
        maxOpen: upstream.stats.maxOpen,
      },
      disturbances: { flagFlips: flips, reloads, brokenReloads, restarts, crashes },
      rss: { nowMb: rss.at(-1)?.rssMb, maxMb: round(maxRss, 1), trend },
      sockets: { baseline: baselineSockets, max: maxSockets },
      latencyMs: {
        p50: round(percentile(latencies, 50) ?? 0, 1),
        p99: round(percentile(latencies, 99) ?? 0, 1),
      },
    };
  };

  const checkpoint = async () => {
    const state = snapshot();
    latencies = [];
    await writeAtomically(
      join(out, "checkpoint.json"),
      `${JSON.stringify(state, null, 2)}\n`,
    );
    await appendFile(join(out, "checkpoints.jsonl"), `${JSON.stringify(state)}\n`);
    log(
      `${state.elapsedHours} h: ${issued} sent, ${violationCount} violations, rss ${state.rss.nowMb} MB (max ${state.rss.maxMb}), sockets max ${maxSockets}, ${flips} flips, ${reloads} reloads, ${restarts} restarts, p99 ${state.latencyMs.p99} ms`,
    );
  };

  const timers = [
    setInterval(issue, 10),
    setInterval(sample, SAMPLE_MS),
    setInterval(() => void checkpoint(), schedule.checkpointMs),
    ...(calm
      ? []
      : [
          setInterval(() => void flip(), schedule.flipMs),
          setInterval(() => {
            reloading = reload();
          }, schedule.reloadMs),
        ]),
  ];
  let nextRestart = calm ? Number.POSITIVE_INFINITY : runStart + schedule.restartMs;
  while (Date.now() - runStart < durationMs) {
    await sleep(1_000);
    if (Date.now() >= nextRestart && Date.now() - runStart < durationMs - 60_000) {
      nextRestart += schedule.restartMs;
      await restart();
    }
  }
  for (const timer of timers) clearInterval(timer);
  const elapsedMs = Date.now() - runStart;

  // Drain: everything in flight answered, the caller's idle connections
  // closed, and time for the proxy's own to the upstream to lapse. What the
  // proxy still holds past that, beyond what it held before any traffic, is
  // leaked.
  const drainDeadline = Date.now() + CLIENT_TIMEOUT_MS + 5_000;
  while (inFlight > 0 && Date.now() < drainDeadline) await sleep(200);
  // A good program and no switches, so the last state is the one it began in.
  await writeFile(programPath, programs[0] as string, "utf8");
  await writeFile(flagsPath, "{}\n", "utf8");
  agent.destroy();
  await sleep(7_000);
  const finals: number[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = socketsOf(proxy?.pid ?? 0);
    if (now !== undefined) finals.push(now);
    await sleep(2_000);
  }
  const finalSockets = finals.length > 0 ? Math.min(...finals) : undefined;
  const leaked =
    finalSockets === undefined || baselineSockets === undefined
      ? undefined
      : Math.max(0, finalSockets - baselineSockets);
  const upstreamLeftOpen = upstream.stats.open();
  sample();

  stopping = true;
  await stopProxy();
  await upstream.close();

  const log_ = existsSync(proxyLog) ? await readFile(proxyLog, "utf8") : "";
  const served = (log_.match(/serving a new program/g) ?? []).length;
  const kept = (log_.match(/kept the running program/g) ?? []).length;
  const trend = rssTrend(rss, schedule.warmupMs);
  const hours = elapsedMs / 3_600_000;
  const achieved = issued / (elapsedMs / 1000);
  const verdict = judge({
    hours,
    rps: { stated: rps, achieved },
    violations: violationCount + upstream.stats.requestViolations,
    unanswered: transport.otherwise,
    crashes,
    rss: { maxMb: maxRss, trend },
    sockets: { leaked: leaked === undefined ? undefined : leaked + upstreamLeftOpen },
  });
  const results: SoakResults = {
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    hours: round(hours, 4),
    seed,
    schedule,
    rps: { stated: rps, achieved: round(achieved, 2) },
    requests: { issued, completed, shed },
    violations: {
      responses: violationCount,
      requests: upstream.stats.requestViolations,
      samples: [...violations, ...upstream.stats.samples].slice(0, SAMPLE_LIMIT),
    },
    transport,
    outcomes: Object.fromEntries(Object.entries(outcomes).sort()),
    disturbances: {
      flagFlips: flips,
      reloads: { written: reloads, broken: brokenReloads, served, kept },
      restarts,
      crashes,
    },
    rss: { maxMb: round(maxRss, 1), trend, samples: rss.length },
    sockets: {
      baseline: baselineSockets,
      max: maxSockets,
      final: finalSockets,
      leaked,
      upstreamLeftOpen,
    },
    verdict,
  };
  const text = `${JSON.stringify(results, null, 2)}\n`;
  await writeFile(join(out, "results.json"), text, "utf8");
  if (args.includes("--record")) {
    await writeFile(join(ROOT, "proving/soak/results.json"), text, "utf8");
  }
  for (const criterion of verdict.criteria) {
    log(`${criterion.met ? "met    " : "NOT MET"} ${criterion.name}: ${criterion.value}`);
  }
  log(`results in ${join(out, "results.json")}`);
  const failed =
    violationCount + upstream.stats.requestViolations > 0 ||
    transport.otherwise > 0 ||
    crashes > 0 ||
    (leaked ?? 0) + upstreamLeftOpen > 0;
  process.exit(failed ? 1 : 0);
}

await main();
