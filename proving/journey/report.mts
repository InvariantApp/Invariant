/**
 * Merges the journeys' result files into proving/journey/results.json.
 *
 *   node --import tsx proving/journey/report.mts journey-*.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Journey, summarize } from "./summary.ts";

const files = process.argv.slice(2);
const journeys = files.map((file) => JSON.parse(readFileSync(file, "utf8")) as Journey);
const summary = summarize(journeys);
writeFileSync(
  join(import.meta.dirname, "results.json"),
  `${JSON.stringify({ ...summary, journeys }, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(summary.systems)}\n`);
