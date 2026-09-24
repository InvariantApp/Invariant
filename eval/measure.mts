/**
 * Measures every judge against the labelled corpus from recorded answers
 * alone, and writes eval/results.json, which the scoreboard's L4b reads and
 * packages/eval/src/eval.test.ts holds to the cache on every commit.
 *
 * No key, no network and no cost: an answer that was never recorded is
 * counted as missing, and a judge with any missing is reported as not
 * measured rather than scored on the cases it happens to have. Record new
 * answers with `pnpm eval:record` first.
 *
 * Usage: node --import tsx eval/measure.mts
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadCorpus, measureRecorded } from "@invariant-app/eval";

const CORPUS = fileURLToPath(new URL("corpus", import.meta.url));
const CACHE = fileURLToPath(new URL("cache", import.meta.url));
const OUT = fileURLToPath(new URL("results.json", import.meta.url));

const results = await measureRecorded(await loadCorpus(CORPUS), CACHE);
await writeFile(OUT, `${JSON.stringify(results, null, 2)}\n`, "utf8");

process.stdout.write(
  `${results.corpus.cases} cases, ${results.corpus.mined} mined from real deltas\n`,
);
for (const judge of results.judges) {
  const families = Object.entries(judge.byFamily)
    .map(
      ([family, at]) => `${family} ${(at.precision * 100).toFixed(1)}% of ${at.answered}`,
    )
    .join(", ");
  process.stdout.write(
    `${judge.judge} at ${judge.threshold.named} naming a field, ${judge.threshold.none} saying none did: ${(judge.overall.precision * 100).toFixed(1)}% on ` +
      `${judge.overall.answered} answered, ${judge.overall.wrong} wrong, ${judge.missing} missing\n` +
      `  ${families}\n`,
  );
  for (const wrong of judge.wrongCases) {
    process.stdout.write(
      `    ${wrong.id} (${wrong.confidence}): said ${wrong.said}, expected ${wrong.expected}\n`,
    );
  }
}
