/**
 * What is left unexplained on one pair, entry by entry, for reading.
 *
 *   node --import tsx proving/corpus/explain.mts --provider paypal.com [--api A] [--from LABEL]
 *     [--index 0] [--id response-property-type-changed] [--limit 20]
 *
 * Runs the same stages as the corpus run, rules judge only, and prints the
 * breaking entries the predicted document still differs from the real one
 * by, with the proposer's unresolved notes for the schemas they touch.
 */

import { predictDocument } from "@invariant-app/compiler";
import { loadContract } from "@invariant-app/contract";
import { breakingEntries, diffDocuments } from "@invariant-app/diff";
import { propose, RulesJudge } from "@invariant-app/proposer";
import { materialize, readManifest } from "./manifest.mts";

const option = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const provider = option("provider");
const api = option("api");
const fromLabel = option("from");
const index = Number(option("index") ?? 0);
const id = option("id");
const limit = Number(option("limit") ?? 20);
/** Prints the drafts whose text mentions this, to see what was proposed for a field. */
const grep = option("grep");

const manifest = await readManifest();
const pairs = manifest.pairs.filter(
  (pair) =>
    (provider === undefined || pair.provider === provider) &&
    (api === undefined || pair.api === api) &&
    (fromLabel === undefined || pair.from.label === fromLabel),
);
const pair = pairs[index];
if (!pair) throw new Error(`no pair ${index} for ${provider ?? "any provider"}`);
console.log(`${pair.api}: ${pair.from.label} -> ${pair.to.label}`);

const from = (await loadContract(await materialize(pair.from), pair.from.label)).document;
const to = (await loadContract(await materialize(pair.to), pair.to.label)).document;
const drafted = await propose(from, to, { judge: new RulesJudge() });
const changes = drafted.proposals.map((proposal) => proposal.change);
const predicted = predictDocument(from, to, changes);
const residual = breakingEntries(await diffDocuments(predicted.document, to)).filter(
  (entry) => id === undefined || entry.id === id,
);
console.log(
  `${changes.length} drafts, ${predicted.issues.length} issues, ${residual.length} left${id ? ` of ${id}` : ""}`,
);
for (const entry of residual.slice(0, limit)) {
  console.log(`- ${entry.id} ${entry.operation} ${entry.path}\n    ${entry.text}`);
}
if (predicted.issues.length > 0) {
  console.log("issues:");
  for (const issue of predicted.issues.slice(0, 10))
    console.log(`  ${issue.changeId}: ${issue.message}`);
}
if (grep !== undefined) {
  console.log(`drafts mentioning ${grep}:`);
  for (const change of changes
    .filter((change) => JSON.stringify(change).includes(grep))
    .slice(0, limit)) {
    console.log(
      `  ${change.id} ${JSON.stringify(change.scopes)} ${JSON.stringify(change.ops)}`,
    );
  }
}
console.log("unresolved:");
for (const entry of drafted.unresolved.slice(0, limit))
  console.log(`  ${entry.schema}.${entry.field}: ${entry.reason}`);
// A decision is not a failure: it is a question only the provider can answer,
// and what is left above closes once it is answered.
console.log(`decisions (${drafted.decisions.length}):`);
for (const decision of drafted.decisions.slice(0, limit)) {
  const what =
    decision.kind === "vocabulary"
      ? `gained ${decision.gained.join(", ")}${decision.lost.length > 0 ? `, lost ${decision.lost.join(", ")}` : ""}`
      : decision.summary;
  console.log(`  ${decision.kind} ${decision.schema}.${decision.field}: ${what}`);
}
