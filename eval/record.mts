/**
 * Records fresh judge answers into the cache. A deliberate act, run by hand.
 */

import {
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
  console.log("  by tag:");
  for (const [tag, m] of byTag(outcomes)) {
    console.log(
      `    ${tag.padEnd(14)} ${m.answered}/${m.total} answered, ${(m.selectiveAccuracy * 100).toFixed(0)}% right`,
    );
  }
  if (judge.id === "jev") {
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
