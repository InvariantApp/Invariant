import { loadCorpus, outcomesOf, runJudge, summarize } from "@invariant/eval";
import { JevJudge, RulesJudge } from "@invariant/proposer";

const CORPUS = "/home/akirt/Invariant/eval/corpus";
const CACHE = "/home/akirt/Invariant/eval/cache";
const cases = await loadCorpus(CORPUS);
for (const judge of [new RulesJudge(), new JevJudge()]) {
  const run = await runJudge(judge, cases, { cacheDir: CACHE });
  const o = outcomesOf(cases, run.results);
  console.log(judge.id, JSON.stringify(summarize(o, judge.id === "jev" ? 0.6 : 0)));
  for (const x of o)
    console.log(
      `  ${judge.id} ${x.caseId.padEnd(34)} exp=${String(x.expected).padEnd(16)} got=${String(x.actual).padEnd(16)} conf=${x.confidence.toFixed(2)} ${x.correct ? "ok" : x.abstained ? "abstain" : "WRONG"}`,
    );
}
