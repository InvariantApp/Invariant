/**
 * Records fresh judge answers into the cache. A deliberate act, run by hand.
 */

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
} from "@invariant/eval";
import {
  EscalatingJudge,
  HybridJudge,
  JevJudge,
  type Judge,
  RulesJudge,
  S2Judge,
} from "@invariant/proposer";

const CORPUS = fileURLToPath(new URL("corpus", import.meta.url));
const CACHE = fileURLToPath(new URL("cache", import.meta.url));

const cases = await loadCorpus(CORPUS);
console.log(`corpus: ${cases.length} cases\n`);

const rules = new RulesJudge();
const jev = new JevJudge();
const judges: Judge[] = [rules, jev];
// S2 only with a key, and only once its pinned model is confirmed to exist.
// The escalation chain is recorded beside it, because that is what drafts.
if (process.env["ANTHROPIC_API_KEY"]) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { anthropicMessages, verifiedModel } = await import("./models.mts");
  const client = new Anthropic();
  const s2 = new S2Judge({
    client: anthropicMessages(client),
    model: await verifiedModel(client),
  });
  judges.push(
    s2,
    new EscalatingJudge(new HybridJudge(rules, jev), s2, { threshold: 0.9 }),
  );
} else {
  console.log("ANTHROPIC_API_KEY is not set: S2 is not recorded.\n");
}

for (const judge of judges) {
  const run = await runJudge(judge, cases, { cacheDir: CACHE, record: true });
  const outcomes = outcomesOf(cases, run.results);
  const metrics = summarize(outcomes);
  console.log(renderMetrics(judge.id, metrics));
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
  if (judge.id === "jev") {
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
