/**
 * Runs every collected pair and writes down what happened.
 *
 * The report is meant to be read when it is bad. A run where everything passes
 * would mean the corpus is too easy, so the sections are ordered by what is
 * most useful when something is wrong: what stopped, then what could not be
 * explained, then what the wild actually contains.
 *
 * Results are written incrementally. A run over hundreds of megabytes of
 * specifications should not lose three hundred results because the three
 * hundred and first document was malformed.
 */
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogueEntry } from "@invariant/diff";
import { type PairResult, type RealSummary, summarizeReal } from "@invariant/eval";
import { DIAGNOSIS } from "./diagnosis.mts";
import {
  type LocalPair,
  type ManifestPair,
  materializePair,
  readManifest,
  shardOf,
} from "./manifest.mts";
import { compareRuns } from "./regressions.mts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Arguments: an optional judge mode, then flags.
 *
 *   rules | hybrid | count        which judge drafts Changes (default rules)
 *   --shard <i>/<n>               run one CI shard of the providers
 *   --results <path>              where this run's results go
 *   --provider <name>             only this provider's pairs
 *   --report <results.json>...    render the report from shard results, and run nothing
 */
const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const shardArg = option("shard");
const shard = shardArg
  ? {
      index: Number(shardArg.split("/")[0]),
      count: Number(shardArg.split("/")[1]),
    }
  : undefined;
const reportInputs = args.includes("--report")
  ? args.slice(args.indexOf("--report") + 1).filter((arg) => !arg.startsWith("--"))
  : undefined;

const partial = shard !== undefined || option("provider") !== undefined;
const resultsFor = (mode: string) =>
  option("results") ??
  join(
    ROOT,
    // A partial run's results never overwrite the committed ones.
    partial
      ? `.cache/corpus/results-${mode}-${shardArg?.replace("/", "-of-") ?? option("provider")}.json`
      : mode === "rules"
        ? "proving/corpus/results.json"
        : `proving/corpus/results-${mode}.json`,
  );
const reportFor = (mode: string) =>
  join(
    ROOT,
    mode === "rules" ? "proving/corpus/REPORT.md" : `proving/corpus/REPORT-${mode}.md`,
  );

const mode = args[0] !== undefined && !args[0].startsWith("--") ? args[0] : "rules";

/**
 * How much a single pair may consume before it is stopped.
 *
 * Both bounds were set by measurement rather than taste. Two 13 MB GitHub
 * specifications a day apart complete in three seconds; two 7.6 MB Stripe
 * specifications a month apart reached 3.1 GB resident and nearly six minutes
 * of processor time without finishing, and took the machine down with them.
 * The cost follows the size of the difference, not the size of the files.
 */
const PAIR_TIMEOUT_MS = Number(process.env["REAL_PAIR_TIMEOUT_MS"] ?? 180_000);
/**
 * Deliberately small. The worker holds two parsed documents; the differ it
 * spawns can want twenty times as much. When the ceiling is reached the system
 * kills the largest process, and that has to be the differ rather than the
 * worker, or the result is "the worker died" instead of "this pair is too
 * expensive, try the reduced path".
 */
const HEAP_MB = Number(process.env["REAL_HEAP_MB"] ?? 512);
/** Kept low on purpose: several differs at once is how a small box dies. */
const CONCURRENCY = Number(process.env["REAL_CONCURRENCY"] ?? 2);

const WORKER = join(ROOT, "proving/corpus/worker.mts");

/**
 * Every worker still running, so none is left behind.
 *
 * A worker owns a Go subprocess that can hold a gigabyte. If this process goes
 * away without tidying up, that subprocess keeps running and the next thing to
 * ask for memory is the thing that gets killed.
 */
const live = new Set<number>();
function reapAll(): void {
  for (const pid of live) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  live.clear();
}
process.on("exit", reapAll);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    reapAll();
    process.exit(1);
  });
}

type WorkerResult = PairResult & {
  elapsedMs?: number;
  asked?: number;
  provider?: string;
  source?: string;
};

/** The stages a worker reports, in the order it runs them. */
const STAGE_ORDER = ["load", "diff", "propose", "align", "compile", "closure"] as const;

/** The stage timings a worker streamed before it was stopped. */
function stagesIn(out: string): Record<string, number> {
  const stageMs: Record<string, number> = {};
  for (const match of out.matchAll(/__STAGE__(\w+) (\d+)/g)) {
    stageMs[match[1] as string] = Number(match[2]);
  }
  return stageMs;
}

/**
 * Runs one pair in its own process, and never throws.
 *
 * A pair that exceeds its budget comes back as a result saying so. That is the
 * whole point of the isolation: on the largest providers this is not a rare
 * accident but a thing that happens, and a run that dies on it tells you
 * nothing about the other several hundred.
 */
function analyseIsolated(pair: LocalPair): Promise<WorkerResult> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${HEAP_MB}`,
        "--import",
        "tsx",
        WORKER,
        mode,
        pair.api,
        pair.from.label,
        pair.to.label,
        pair.fromPath,
        pair.toPath,
      ],
      {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process group, so killing it kills the differ it spawned.
        // Without this a worker stopped on timeout leaves an orphaned Go
        // process holding a gigabyte, and a long run accumulates them until
        // the machine has none left. One outlived the run that started it.
        detached: true,
      },
    );

    const stopped = (error: string): WorkerResult => ({
      api: pair.api,
      fromVersion: pair.from.label,
      toVersion: pair.to.label,
      reached: "budget",
      error,
      deltas: 0,
      breakingBefore: 0,
      breakingAligned: 0,
      breakingAfter: 0,
      drafts: 0,
      unresolved: 0,
      impasses: 0,
      compileIssues: [],
      // These two are the tallies the summary walks. Leaving them off produced
      // a result that looked fine in the file and crashed the report after 686
      // pairs had already been computed.
      breakingKinds: {},
      unexplainedKinds: {},
      elapsedMs: PAIR_TIMEOUT_MS,
    });

    if (child.pid !== undefined) live.add(child.pid);

    let out = "";
    let err = "";
    let settled = false;
    const done = (result: WorkerResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.pid !== undefined) live.delete(child.pid);
      resolve(result);
    };

    /** Kills the worker and every process it started. */
    const killTree = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone, which is the outcome being asked for.
      }
    };

    const timer = setTimeout(() => {
      killTree();
      const stageMs = stagesIn(out);
      const spent = Object.values(stageMs).reduce((sum, ms) => sum + ms, 0);
      const running = STAGE_ORDER.find((stage) => !(stage in stageMs)) ?? "closure";
      done({
        ...stopped(
          `Stopped after ${PAIR_TIMEOUT_MS} ms, in \`${running}\` ` +
            `(${Math.round((PAIR_TIMEOUT_MS - spent) / 1000)}s there). The difference ` +
            "between these two versions is larger than one pair's budget.",
        ),
        stageMs,
      });
    }, PAIR_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });

    child.on("error", (error) =>
      done(stopped(`Could not start the worker: ${error.message}`)),
    );

    child.on("close", (code, signal) => {
      const marker = out.lastIndexOf("__PAIR__");
      if (marker >= 0) {
        try {
          done(JSON.parse(out.slice(marker + "__PAIR__".length).trim()) as WorkerResult);
          return;
        } catch {
          // Fall through to the stopped path below.
        }
      }
      // No result line means the process died before it could write one, which
      // on this path is almost always the heap ceiling or the system killer.
      done(
        stopped(
          signal === "SIGKILL" || code === null
            ? "The worker was killed, which on this path means it ran out of memory."
            : `The worker exited with ${String(code)}.\n${err.trim().slice(0, 300)}`,
        ),
      );
    });
  });
}

// One provider at a time, for looking at a failure locally without running
// the several hundred pairs around it.
const onlyProvider = option("provider");
const pairs = shardOf((await readManifest()).pairs, shard).filter(
  (pair) => onlyProvider === undefined || pair.provider === onlyProvider,
);

if (reportInputs) {
  // Rendering only: the shards ran on separate runners, and this is the one
  // report their results add up to.
  const merged: WorkerResult[] = [];
  for (const input of reportInputs) {
    merged.push(...(JSON.parse(await readFile(input, "utf8")) as WorkerResult[]));
  }
  // Compared with the run recorded in the repository before either is
  // replaced, so a nightly run that made anything worse fails, names the
  // pairs, and records nothing.
  const recorded = JSON.parse(
    await readFile(resultsFor(mode), "utf8").catch(() => "[]"),
  ) as PairResult[];
  const { regressions, notes } = compareRuns(recorded, merged);
  const report = render(summarizeReal(merged), merged, mode);
  await writeFile(reportFor(mode), report, "utf8");
  await writeFile(resultsFor(mode), `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  console.log(
    `${merged.length} results from ${reportInputs.length} shards, report written`,
  );
  for (const note of notes) console.log(`note: ${note}`);
  if (regressions.length > 0) {
    console.error(`\n${regressions.length} regressions since the recorded run:`);
    for (const regression of regressions) console.error(`  ${regression}`);
    process.exit(1);
  }
  process.exit(0);
}

const results: WorkerResult[] = [];

console.log(
  `${pairs.length} pairs, judge: ${mode}, ${CONCURRENCY} at a time, ` +
    `${PAIR_TIMEOUT_MS / 1000}s and ${HEAP_MB} MB each\n`,
);

let next = 0;
let finished = 0;
async function drain(): Promise<void> {
  while (next < pairs.length) {
    const index = next;
    next += 1;
    const pair = pairs[index] as ManifestPair;
    let result: WorkerResult;
    try {
      result = await analyseIsolated(await materializePair(pair));
    } catch (error) {
      // A specification that cannot be fetched, or no longer hashes to what
      // was pinned, is reported as such rather than measured as something else.
      result = {
        api: pair.api,
        fromVersion: pair.from.label,
        toVersion: pair.to.label,
        reached: "load",
        error: error instanceof Error ? error.message : String(error),
        deltas: 0,
        breakingBefore: 0,
        breakingAligned: 0,
        breakingAfter: 0,
        drafts: 0,
        unresolved: 0,
        impasses: 0,
        compileIssues: [],
        breakingKinds: {},
        unexplainedKinds: {},
        elapsedMs: 0,
      };
    }
    results.push({ ...result, provider: pair.provider, source: pair.source });
    finished += 1;
    process.stdout.write(
      result.reached === "done" ? "." : result.reached === "budget" ? "B" : "!",
    );
    if (finished % 50 === 0) process.stdout.write(` ${finished}/${pairs.length}\n`);
    await writeFile(resultsFor(mode), `${JSON.stringify(results, null, 2)}\n`, "utf8");
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => drain()));

if (mode === "count") {
  const asked = results.reduce((sum, result) => sum + (result.asked ?? 0), 0);
  console.log(`\n\n${asked} alignment questions would be asked.`);
  console.log(`at roughly $0.000054 each, about $${(asked * 0.000054).toFixed(2)}.`);
  process.exit(0);
}

// The rules-only run is the baseline every other judge is measured against,
// so a hybrid run reads it back rather than asking the reader to hold two
// reports side by side.
let baseline: RealSummary | undefined;
if (mode !== "rules") {
  try {
    baseline = summarizeReal(
      JSON.parse(await readFile(resultsFor("rules"), "utf8")) as PairResult[],
    );
  } catch {
    baseline = undefined;
  }
}

const summary = summarizeReal(results);
const report = render(summary, results, mode, baseline);
console.log(`\n\n${report}`);
// Only a run over the whole corpus is the report. A shard or one provider's
// pairs is a partial result, and writing it over the report would make a
// seven-pair run look like the measurement of the corpus.
if (!partial) {
  await writeFile(reportFor(mode), report, "utf8");
  console.log(`\nwritten to ${reportFor(mode).replace(`${ROOT}`, "")}`);
} else {
  console.log(`\npartial run: results in ${resultsFor(mode)}, report left as it was`);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function render(
  summary: RealSummary,
  all: readonly WorkerResult[],
  judgeMode: string,
  baseline?: RealSummary,
): string {
  const lines: string[] = [];
  const drafted =
    judgeMode === "hybrid"
      ? "by deterministic rules first, with Jev asked only what spelling could not settle"
      : "by deterministic rules alone, with no model asked anything";

  lines.push(`# Real APIs${judgeMode === "rules" ? "" : ` (${judgeMode})`}`, "");
  lines.push(
    "Consecutive published versions of real APIs, run through loading, diffing,",
    "drafting, compiling and the closure check. Generated by `pnpm proving:corpus`.",
    "",
    "Nothing here was written for this project, which is the point. Every number",
    "measured anywhere else in this repository came from a fixture built for it",
    "or a corpus written for it.",
    "",
  );

  lines.push("## Did the pipeline survive", "");
  lines.push(`- ${summary.pairs} version pairs`);
  lines.push(
    `- ${summary.completed} ran every stage (${percent(summary.completed / summary.pairs)})`,
  );
  for (const [stage, count] of Object.entries(summary.stoppedAt)) {
    if (stage === "done" || count === 0) continue;
    lines.push(`- ${count} stopped after \`${stage}\``);
  }
  lines.push(`- median ${summary.medianMs} ms per pair`, "");

  if (summary.errors.length > 0) {
    lines.push("### What stopped them", "");
    lines.push("| Count | Error |", "|---|---|");
    for (const entry of summary.errors.slice(0, 15)) {
      lines.push(`| ${entry.count} | \`${entry.error}\` |`);
    }
    lines.push("");
  }

  lines.push("## What real API changes look like", "");
  lines.push(
    `Of the ${summary.pairs} pairs, ${summary.additiveOnly} were purely additive:`,
    "the new version broke nothing. That is itself worth knowing, because it is",
    "the case this system should stay out of the way of.",
    "",
    `A raw diff of the rest finds ${summary.breakingBefore} breaking deltas.`,
    `Lining the endpoints up first finds ${summary.breakingAligned}.`,
    "",
  );
  if (summary.revealed > 0) {
    lines.push(
      `**${summary.revealed} of those are only visible after lining up.** Most real APIs`,
      "put the version in the URL, so bumping it moves every endpoint at once. A diff",
      "with no notion of that reports the old paths as removed and stops: it cannot",
      "see inside operations it thinks no longer exist. Applying the route change",
      "first makes them comparable, and what surfaces is breakage the provider would",
      "not otherwise have been told about.",
      "",
    );
  }
  lines.push("| Breaking change | Times | Pairs |", "|---|---|---|");
  for (const entry of summary.wild.slice(0, 25)) {
    lines.push(`| \`${entry.kind}\` | ${entry.count} | ${entry.pairs} |`);
  }
  lines.push("");

  const byProvider = new Map<
    string,
    {
      pairs: number;
      done: number;
      budget: number;
      aligned: number;
      after: number;
      drafts: number;
    }
  >();
  for (const result of all) {
    const key = result.provider ?? "unknown";
    const row = byProvider.get(key) ?? {
      pairs: 0,
      done: 0,
      budget: 0,
      aligned: 0,
      after: 0,
      drafts: 0,
    };
    row.pairs += 1;
    if (result.reached === "done") row.done += 1;
    if (result.reached === "budget") row.budget += 1;
    row.aligned += result.breakingAligned;
    row.after += result.breakingAfter;
    row.drafts += result.drafts;
    byProvider.set(key, row);
  }

  lines.push("## Who the providers are", "");
  lines.push(
    "The first corpus came from APIs.guru, which has a ceiling worth stating:",
    "of 2529 APIs only 13 providers publish more than one version, and Azure is",
    "four fifths of the pairs. A result measured only there is a result about",
    "Azure's house style.",
    "",
    "The rest come from the document each provider publishes in its own",
    "repository, read at successive commits. That is the same API moving in",
    "place, which is what this system is actually for.",
    "",
    "| Provider | Pairs | Completed | Over budget | Aligned breaking | Unexplained | Drafted |",
    "|---|---|---|---|---|---|---|",
  );
  for (const [provider, row] of [...byProvider].sort((a, b) => b[1].pairs - a[1].pairs)) {
    lines.push(
      `| ${provider} | ${row.pairs} | ${row.done} | ${row.budget} | ${row.aligned} | ${row.after} | ${row.drafts} |`,
    );
  }
  lines.push("");

  const reduced = all.filter((r) => r.mode !== undefined && r.mode !== "changelog");
  if (reduced.length > 0) {
    lines.push("## Pairs compared at reduced fidelity", "");
    lines.push(
      `${reduced.length} pairs could not be compared in full. Their counts below`,
      "are upper bounds rather than measurements, and they are listed here so no",
      "number from them is read as though it were measured the same way as the",
      "rest.",
      "",
      "The full changelog could not be computed for these, so a breaking-only",
      "comparison was used instead. For the largest it also had to stop merging",
      "`allOf` before comparing, which no longer collapses composition and so",
      "reports a superset. Every comparison of one pair uses the same rung, or",
      "the residual and the total would not be subtractable.",
      "",
      "| API | Step | Rung | Aligned breaking |",
      "|---|---|---|---|",
    );
    for (const result of reduced.slice(0, 20)) {
      lines.push(
        `| ${result.api} | ${result.fromVersion} to ${result.toVersion} | \`${result.mode}\` | ${result.breakingAligned} |`,
      );
    }
    lines.push("");
  }

  const overBudget = all.filter((result) => result.reached === "budget");
  if (overBudget.length > 0) {
    lines.push("## Pairs that cost more than they were given", "");
    lines.push(
      `${overBudget.length} of ${all.length} pairs were stopped rather than finished.`,
      "",
      "This is a real limit, not a crash. The differ's cost tracks the size of",
      "the difference rather than the size of the documents: two 13 MB GitHub",
      "specifications a day apart diff in three seconds, while two 7.6 MB Stripe",
      "specifications a month apart reached 3.1 GB resident and nearly six",
      "minutes of processor time without finishing.",
      "",
      "It matters because the gate shells out to the same differ on every pull",
      "request. A provider large enough to be worth having is a provider whose",
      "release could exhaust its own CI machine, so the call is now bounded and",
      "says which bound it hit.",
      "",
      "| API | Step | Why |",
      "|---|---|---|",
    );
    for (const result of overBudget.slice(0, 20)) {
      const why = (result.error ?? "").split("\n")[0]?.slice(0, 120) ?? "";
      lines.push(
        `| ${result.api} | ${result.fromVersion} to ${result.toVersion} | ${why} |`,
      );
    }
    lines.push("");
  }

  const decisions = all.reduce((sum, r) => sum + (r.decisions ?? 0), 0);
  const withDecisions = all.filter((r) => (r.decisions ?? 0) > 0).length;
  const grownDeltas = all.reduce(
    (sum, r) => sum + (r.unexplainedKinds?.["response-property-enum-value-added"] ?? 0),
    0,
  );
  if (decisions > 0) {
    lines.push("## Changes waiting on one decision", "");
    lines.push(
      `${decisions} response fields across ${withDecisions} pairs gained a value`,
      "their old contract never named. That is the largest category of real",
      "breaking change there is, and it was described here as inexpressible until",
      "it turned out not to be: `enumMap` takes a `fold` saying which existing",
      "value an old caller should be shown instead, and the runtime applies it on",
      "the way out.",
      "",
      "What is genuinely not derivable is *which* existing value, because that is",
      "a judgement about meaning rather than a fact about either document. So the",
      "proposer writes the Change out with one placeholder per new value and lists",
      "the values available to fold onto. The release stays blocked until somebody",
      "fills it in, which is the right place for the cost to sit: the provider",
      "makes the change and the caller pays for it.",
      "",
      `The ratio is the useful number: ${grownDeltas} breaking deltas of this kind`,
      `come from ${decisions} fields, about ${Math.round(grownDeltas / Math.max(1, decisions))}`,
      "to one. A schema field that a hundred operations reference produces a",
      "hundred deltas and still only needs deciding once, so a count of deltas",
      "badly overstates how much work this is. Stripe is the extreme: 61,517",
      "breaking deltas of this kind across 15 fields.",
      "",
    );
  }

  lines.push("## What we could not explain", "");
  lines.push(`${summary.drafts} Changes were drafted, ${drafted}.`, "");

  if (baseline) {
    lines.push(
      `The rules-only baseline drafted ${baseline.drafts} and left`,
      `${baseline.breakingAfter} unexplained. Asking the model moved that to`,
      `${summary.breakingAfter}.`,
      "",
      "A category rising rather than falling is not a regression. Aligning a",
      "removed field to its successor explains the removal and leaves whatever",
      "else differs about that field, so one unexplained removal becomes one",
      "unexplained type or vocabulary change. That is a more specific statement",
      "of the same problem, and a more useful one.",
      "",
      "| Category | Rules only | With the model |",
      "|---|---|---|",
    );
    const kinds = new Set([
      ...summary.holes.slice(0, 12).map((hole) => hole.kind),
      ...baseline.holes.slice(0, 12).map((hole) => hole.kind),
    ]);
    const before = new Map(baseline.holes.map((hole) => [hole.kind, hole.count]));
    const after = new Map(summary.holes.map((hole) => [hole.kind, hole.count]));
    for (const kind of [...kinds].sort(
      (a, b) => (after.get(b) ?? 0) - (after.get(a) ?? 0),
    )) {
      lines.push(`| \`${kind}\` | ${before.get(kind) ?? 0} | ${after.get(kind) ?? 0} |`);
    }
    lines.push("");
  }

  lines.push(
    "The table below is the to-do list, and it is ordered by how often real",
    "companies actually do each thing. Three categories in it are already",
    "reachable with ops that exist and are simply not wired up.",
    "",
  );
  lines.push("| Unexplained | Times | Pairs | What it would take |", "|---|---|---|---|");
  for (const entry of summary.holes.slice(0, 20)) {
    const why = DIAGNOSIS[entry.kind] ?? catalogueEntry(entry.kind).sentence;
    lines.push(`| \`${entry.kind}\` | ${entry.count} | ${entry.pairs} | ${why} |`);
  }
  lines.push("");

  const compileFailures = all.filter((result) => result.compileIssues.length > 0);
  if (compileFailures.length > 0) {
    lines.push("## Drafts that would not compile", "");
    lines.push(
      "A draft that does not apply to the document it was drafted from is a bug",
      "here, not a hard case. These are the highest priority in the report.",
      "",
    );
    for (const result of compileFailures.slice(0, 20)) {
      lines.push(`- **${result.api}** ${result.fromVersion} to ${result.toVersion}`);
      for (const issue of result.compileIssues.slice(0, 3)) lines.push(`  - ${issue}`);
    }
    lines.push("");
  }

  const worst = [...all]
    .filter((result) => result.breakingAfter > 0)
    .sort((a, b) => b.breakingAfter - a.breakingAfter)
    .slice(0, 15);
  if (worst.length > 0) {
    lines.push("## The hardest pairs", "");
    lines.push(
      "| API | Versions | Raw | Aligned | Unexplained | Drafted |",
      "|---|---|---|---|---|---|",
    );
    for (const result of worst) {
      lines.push(
        `| ${result.api} | ${result.fromVersion} to ${result.toVersion} | ` +
          `${result.breakingBefore} | ${result.breakingAligned} | ` +
          `${result.breakingAfter} | ${result.drafts} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}
