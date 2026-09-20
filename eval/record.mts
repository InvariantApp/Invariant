/**
 * Records fresh judge answers into the cache. A deliberate act, run by hand.
 */

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
import { JevJudge, RulesJudge } from "@invariant/proposer";

const CORPUS = new URL("corpus", import.meta.url).pathname;
const CACHE = new URL("cache", import.meta.url).pathname;

const cases = await loadCorpus(CORPUS);
console.log(`corpus: ${cases.length} cases\n`);

for (const judge of [new RulesJudge(), new JevJudge()]) {
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
