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
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  analysePair,
  type PairResult,
  type RealSummary,
  summarizeReal,
} from "@invariant/eval";
import type { AlignmentQuestion, Judge, JudgeResult } from "@invariant/proposer";
import { HybridJudge, JevJudge, RulesJudge } from "@invariant/proposer";

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
const INDEX = join(ROOT, "eval/real/pairs.json");
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
  fromVersion: string;
  toVersion: string;
  fromFile: string;
  toFile: string;
}

/**
 * Counts what would be asked, and answers nothing.
 *
 * Running a model across sixty real specifications is worth doing and worth
 * knowing the size of first. This is the dry run: same pipeline, same
 * questions, no requests.
 */
class CountingJudge implements Judge {
  readonly id = "rules" as const;
  readonly fingerprint = "counting:v1";
  asked = 0;

  align(questions: readonly AlignmentQuestion[]): Promise<JudgeResult[]> {
    this.asked += questions.length;
    return Promise.resolve(
      questions.map(() => ({
        answer: {
          successor: null,
          confidence: 0,
          scores: {},
          stated: false,
          abstained: true,
        },
        judge: "rules" as const,
        model: undefined,
        latencyMs: 0,
        inputTokens: 0,
        costUsd: 0,
      })),
    );
  }
}

const mode = process.argv[2] ?? "rules";
const counter = new CountingJudge();
const judge: Judge =
  mode === "hybrid"
    ? new HybridJudge(new RulesJudge(), new JevJudge())
    : mode === "count"
      ? counter
      : new RulesJudge();

const pairs = JSON.parse(await readFile(INDEX, "utf8")) as Pair[];
const results: PairResult[] = [];

console.log(`${pairs.length} pairs, judge: ${mode}\n`);

for (const [index, pair] of pairs.entries()) {
  const result = await analysePair(
    {
      api: pair.api,
      fromVersion: pair.fromVersion,
      toVersion: pair.toVersion,
      fromPath: pair.fromFile,
      toPath: pair.toFile,
    },
    { judge },
  );
  results.push(result);

  const mark = result.reached === "done" ? "." : "!";
  process.stdout.write(mark);
  if ((index + 1) % 50 === 0) process.stdout.write(` ${index + 1}\n`);

  await writeFile(resultsFor(mode), `${JSON.stringify(results, null, 2)}\n`, "utf8");
}

if (mode === "count") {
  console.log(`\n\n${counter.asked} alignment questions would be asked.`);
  console.log(
    `at roughly $0.000054 each, about $${(counter.asked * 0.000054).toFixed(2)}.`,
  );
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
