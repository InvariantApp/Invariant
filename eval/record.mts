/**
 * Records fresh judge answers into the cache. A deliberate act, run by hand.
 *
 *   node --import tsx eval/record.mts [--judges rules,jev,s2,chain] [--prune]
 *
 * Each judge is recorded where its key is: Jev's is kept on the machine that
 * records it, and S2's only in the proving workflow's `judges` job, so a run
 * names the judges it records and the rest are read from the cache. The
 * escalation chain calls both, so it is recorded only where both keys are.
 *
 * `--prune` deletes every recorded answer that no judge read here keys on:
 * answers to questions no longer asked, or asked under wording or a model
 * that is no longer the judge's. Rules, Jev and S2 are always read; the
 * chain only where it is recorded, so a prune without both keys drops its
 * answers, which no measurement reads.
 */

import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bySource,
  byTag,
  calibration,
  loadCorpus,
  outcomesOf,
  ownership,
  renderMetrics,
  renderVerdict,
  runJudge,
  summarize,
} from "@invariant-app/eval";
import {
  ANTHROPIC_PRICING,
  EscalatingJudge,
  HybridJudge,
  JevJudge,
  type Judge,
  RulesJudge,
  S2Judge,
} from "@invariant-app/proposer";

const CORPUS = fileURLToPath(new URL("corpus", import.meta.url));
const CACHE = fileURLToPath(new URL("cache", import.meta.url));

const cases = await loadCorpus(CORPUS);
console.log(`corpus: ${cases.length} cases\n`);

const flag = process.argv.indexOf("--judges");
const named = new Set(
  flag === -1
    ? ["rules", "jev", "s2", "chain"]
    : (process.argv[flag + 1] ?? "").split(",").map((name) => name.trim()),
);
const prune = process.argv.includes("--prune");

const rules = new RulesJudge();
const jev = new JevJudge();
// Labelled here rather than by id: a chain of judges reports under its own name.
// A judge not named is still read, from the cache alone, so its numbers print.
const judges: { label: string; judge: Judge; record: boolean }[] = [
  { label: "rules", judge: rules, record: named.has("rules") },
  { label: "jev", judge: jev, record: named.has("jev") },
];
// S2 only with a key, and only once its pinned model is confirmed to exist.
// The escalation chain is recorded beside it, because that is what drafts.
if (process.env["ANTHROPIC_API_KEY"] && (named.has("s2") || named.has("chain"))) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { anthropicMessages, verifiedModel } = await import("./models.mts");
  const client = new Anthropic();
  const s2 = new S2Judge({
    client: anthropicMessages(client),
    model: await verifiedModel(client),
    pricing: ANTHROPIC_PRICING,
  });
  judges.push({ label: "s2", judge: s2, record: named.has("s2") });
  if (process.env["TYPESAFE_API_KEY"] && named.has("chain")) {
    judges.push({
      label: "rules+jev, escalating to s2 below 0.9",
      judge: new EscalatingJudge(new HybridJudge(rules, jev), s2, { threshold: 0.9 }),
      record: true,
    });
  } else {
    console.log(
      "TYPESAFE_API_KEY is not set here: the escalation chain is not recorded.\n",
    );
  }
} else {
  // Read from the cache, so its numbers still print.
  const offline = {
    messages: {
      create: () => Promise.reject(new Error("S2 is read from recorded answers here")),
    },
  };
  judges.push({ label: "s2", judge: new S2Judge({ client: offline }), record: false });
  console.log("S2 is not recorded here: its answers are read from the cache.\n");
}

const kept = new Set<string>();
for (const { label, judge, record } of judges) {
  const run = await runJudge(judge, cases, { cacheDir: CACHE, record });
  for (const file of run.files) kept.add(file);
  if (run.missing.length > 0) {
    console.log(`${label}: ${run.missing.length} cases have no recorded answer`);
  }
  for (const failure of run.failures)
    console.log(`${label}: a request failed: ${failure}`);
  const outcomes = outcomesOf(cases, run.results);
  const metrics = summarize(outcomes);
  console.log(renderMetrics(label, metrics));
  console.log(`  (${run.fromCache} cached, ${run.recorded} newly recorded)`);
  console.log(renderVerdict(ownership(judge.id, metrics)));
  console.log("  by where the cases came from:");
  for (const [source, m] of bySource(outcomes)) {
    console.log(
      `    ${source.padEnd(28)} ${m.answered}/${m.total} answered, ${(m.selectiveAccuracy * 100).toFixed(0)}% right`,
    );
  }
  console.log("  by tag:");
  for (const [tag, m] of byTag(outcomes)) {
    console.log(
      `    ${tag.padEnd(14)} ${m.answered}/${m.total} answered, ${(m.selectiveAccuracy * 100).toFixed(0)}% right`,
    );
  }
  const wrong = outcomes.filter((outcome) => !outcome.abstained && !outcome.correct);
  if (wrong.length > 0) {
    // Named, because these are the next round of work. A number alone cannot
    // be argued with and cannot be fixed.
    console.log("  answered and wrong:");
    for (const outcome of wrong) {
      console.log(
        `    ${outcome.caseId} (conf ${outcome.confidence.toFixed(2)}${outcome.source ? ", mined" : ""}): ` +
          `said ${outcome.actual ?? "nothing"}, expected ${outcome.expected ?? "nothing"}`,
      );
    }
  }
  if (judge.id !== "rules") {
    // The threshold is only a mechanism if the errors are all below it. This is
    // the line that says whether it is one.
    for (const floor of [0.6, 0.8]) {
      const gated = summarize(outcomes, floor);
      console.log(
        `  at confidence >= ${floor}: ${gated.answered}/${gated.total} answered ` +
          `(${(gated.coverage * 100).toFixed(1)}% coverage), ` +
          `${(gated.selectiveAccuracy * 100).toFixed(1)}% right, ${gated.confidentlyWrong} wrong`,
      );
      const minedGated = summarize(
        outcomes.filter((outcome) => outcome.source?.startsWith("mined:")),
        floor,
      );
      console.log(
        `    of which mined: ${minedGated.answered}/${minedGated.total} answered, ` +
          `${(minedGated.selectiveAccuracy * 100).toFixed(1)}% right, ${minedGated.confidentlyWrong} wrong`,
      );
    }
    console.log("  calibration:");
    for (const bin of calibration(outcomes)) {
      if (bin.answered === 0) continue;
      console.log(
        `    conf >= ${bin.lowerBound.toFixed(1)}: ${bin.answered} answered, ${(bin.accuracy * 100).toFixed(0)}% right`,
      );
    }
  }
  console.log();
}

if (prune) {
  const stale = (await readdir(CACHE))
    .map((name) => join(CACHE, name))
    .filter((path) => !kept.has(path));
  await Promise.all(stale.map((path) => unlink(path)));
  console.log(`pruned ${stale.length} recorded answers no judge or case keys on`);
}
