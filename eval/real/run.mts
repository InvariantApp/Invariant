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
import { type PairResult, type RealSummary, summarizeReal } from "@invariant/eval";

/**
 * What each unexplained kind actually means for this system.
 *
 * A ranked list of check ids is a list. A ranked list with a diagnosis beside
 * each one is a to-do list, and the whole point of running real documents is
 * to produce the second.
 */
const DIAGNOSIS: Record<string, string> = {
  "api-path-removed-without-deprecation":
    "an endpoint genuinely gone, not moved. No op covers removing a whole operation; `remove` works on fields. **Missing op.**",
  "response-body-type-changed":
    "a response schema replaced wholesale, often with an empty one. Not expressible and probably should not be: it is a rewrite, not a rename.",
  "request-parameter-enum-value-removed":
    "allowed values narrowed on a query or path parameter. `enumMap` could express it, but the proposer only reads `components.schemas` and never looks at parameters. **Reachable, not wired up.**",
  "request-parameter-removed":
    "a query or path parameter dropped. Same cause: parameters are invisible to the proposer. **Reachable, not wired up.**",
  "request-parameter-property-enum-value-removed":
    "as above, one level in. **Reachable, not wired up.**",
  "response-property-enum-value-added":
    "a new value a client switching exhaustively would not know. `enumMap` cannot help, since there is nothing to map it back to; this is a `behavior` change or an accepted break.",
  "response-property-enum-value-removed":
    "a value a client may still be storing. `enumMap` can express it once someone says what it became, which is exactly the question the model is asked.",
  "request-property-removed":
    "a field dropped from a request. `remove` expresses it; the rules judge abstains on removals by design, so this needs the model or a person.",
  "response-required-property-added":
    "a new required field in a response. `add` expresses it, given a value for callers who predate it, which is not in the document.",
  "response-required-property-removed":
    "a required response field gone. `remove` with a restore value expresses it; again the value is not in the document.",
  "new-required-request-property":
    "a new required request field. `add` with a default expresses it, and the default is a decision rather than a fact.",
  "request-property-type-changed":
    "`cast` covers the scalar cases. Anything structural is out of scope on purpose.",
  "response-property-type-changed":
    "a response field whose declared type moved. `cast` covers the scalar cases once someone says the two are the same field, which is the alignment question.",
  "response-property-became-optional":
    "a field a caller relied on may now be absent. Expressible only by supplying a value, which is a judgement.",
  "request-property-became-required":
    "a caller who omitted it will now be refused. `add` with a default expresses it.",
};

const ROOT = new URL("../../", import.meta.url).pathname;
/**
 * Two indexes, deliberately kept apart until they are read.
 *
 * `pairs.json` is APIs.guru: published version bumps, mostly Azure and Google.
 * `pairs-git.json` is the specification each provider publishes in its own
 * repository, sampled at successive commits. The second is where the providers
 * people actually integrate against live, and the report keeps the two
 * distinguishable because they are different kinds of evidence.
 */
const INDEXES = [
  join(ROOT, "eval/real/pairs.json"),
  join(ROOT, "eval/real/pairs-git.json"),
];
const resultsFor = (mode: string) =>
  join(
    ROOT,
    mode === "rules" ? "eval/real/results.json" : `eval/real/results-${mode}.json`,
  );
const reportFor = (mode: string) =>
  join(ROOT, mode === "rules" ? "eval/real/REPORT.md" : `eval/real/REPORT-${mode}.md`);

interface Pair {
  api: string;
  title: string;
  provider?: string;
  source?: string;
  fromVersion: string;
  toVersion: string;
  fromFile: string;
  toFile: string;
}

const mode = process.argv[2] ?? "rules";

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
const HEAP_MB = Number(process.env["REAL_HEAP_MB"] ?? 1536);
/** Kept low on purpose: several differs at once is how a small box dies. */
const CONCURRENCY = Number(process.env["REAL_CONCURRENCY"] ?? 2);

const WORKER = join(ROOT, "eval/real/worker.mts");

interface Pair {
  api: string;
  title: string;
  provider?: string;
  source?: string;
  fromVersion: string;
  toVersion: string;
  fromFile: string;
  toFile: string;
}

type WorkerResult = PairResult & {
  elapsedMs?: number;
  asked?: number;
  provider?: string;
  source?: string;
};

/**
 * Runs one pair in its own process, and never throws.
 *
 * A pair that exceeds its budget comes back as a result saying so. That is the
 * whole point of the isolation: on the largest providers this is not a rare
 * accident but a thing that happens, and a run that dies on it tells you
 * nothing about the other several hundred.
 */
function analyseIsolated(pair: Pair): Promise<WorkerResult> {
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
        pair.fromVersion,
        pair.toVersion,
        pair.fromFile,
        pair.toFile,
      ],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );

    const stopped = (error: string): WorkerResult => ({
      api: pair.api,
      fromVersion: pair.fromVersion,
      toVersion: pair.toVersion,
      reached: "budget",
      error,
      deltas: 0,
      breakingBefore: 0,
      breakingAligned: 0,
      breakingAfter: 0,
      drafts: 0,
      unresolved: 0,
      compileIssues: [],
      wild: [],
      holes: [],
      elapsedMs: PAIR_TIMEOUT_MS,
    });

    let out = "";
    let err = "";
    let settled = false;
    const done = (result: WorkerResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(
        stopped(
          `Stopped after ${PAIR_TIMEOUT_MS} ms. The difference between these two ` +
            "versions is larger than one pair's budget.",
        ),
      );
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

const pairs: Pair[] = [];
for (const index of INDEXES) {
  try {
    pairs.push(...(JSON.parse(await readFile(index, "utf8")) as Pair[]));
  } catch {
    // An index that is not there yet is not an error: each fetcher is run
    // separately and either half is a usable corpus on its own.
  }
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
    const pair = pairs[index] as Pair;
    const result = await analyseIsolated(pair);
    results.push({
      ...result,
      provider: pair.provider ?? (pair.api.split(":")[0] as string),
      source: pair.source ?? "guru",
    });
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
await writeFile(reportFor(mode), report, "utf8");
console.log(`\nwritten to ${reportFor(mode).replace(`${ROOT}`, "")}`);

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function render(
  summary: RealSummary,
  all: readonly PairResult[],
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
    "drafting, compiling and the closure check. Generated by `pnpm real`.",
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
    const why = DIAGNOSIS[entry.kind] ?? "not yet diagnosed";
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
