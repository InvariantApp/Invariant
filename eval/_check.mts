import { loadCorpus, outcomesOf, questionOf, summarize } from "@invariant/eval";
import { RulesJudge } from "@invariant/proposer";

const CORPUS = "/home/akirt/Invariant/eval/corpus";
const cases = await loadCorpus(CORPUS);
const results = await new RulesJudge().align(cases.map(questionOf));
const outcomes = outcomesOf(cases, results);
let bad = 0;
for (const o of outcomes) {
  const flag = o.abstained ? "abstain" : o.correct ? "ok     " : "WRONG  ";
  if (!o.abstained && !o.correct) bad++;
  const ambBad =
    o.tags.includes("ambiguous") && !o.abstained ? "  <-- AMBIGUOUS-BUT-ANSWERED" : "";
  console.log(
    `${flag} ${o.caseId.padEnd(42)} exp=${String(o.expected).padEnd(26)} got=${String(o.actual)}${ambBad}`,
  );
}
const m = summarize(outcomes);
console.log(
  `\ntotal=${m.total} answered=${m.answered} coverage=${m.coverage.toFixed(3)} selAcc=${m.selectiveAccuracy.toFixed(3)} wrong=${bad}`,
);
