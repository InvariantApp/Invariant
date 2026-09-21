/**
 * A single real specification pair, run through the whole pipeline.
 *
 * Kept as a script rather than folded into the harness because its job is to
 * fail loudly and show where. Everything this project has measured so far was
 * measured against a fixture written for it, and a fixture cannot say whether
 * the compiler survives a 700 KB document with a hundred and seventy schemas.
 */

import { predictDocument } from "@invariant/compiler";
import { loadContract } from "@invariant/contract";
import { breakingEntries, describeEntry, diffDocuments } from "@invariant/diff";
import { HybridJudge, JevJudge, propose, RulesJudge } from "@invariant/proposer";

const [oldPath, newPath] = process.argv.slice(2);
if (!oldPath || !newPath) throw new Error("usage: probe.mts <old.json> <new.json>");

function since(start: number): string {
  return `${((performance.now() - start) / 1000).toFixed(1)}s`;
}

let mark = performance.now();
const before = await loadContract(oldPath, "old");
const after = await loadContract(newPath, "new");
console.log(`loaded both in ${since(mark)}`);
console.log(`  old digest ${before.digest.slice(0, 19)}`);
console.log(`  new digest ${after.digest.slice(0, 19)}`);

mark = performance.now();
const entries = await diffDocuments(before.document, after.document);
const breaking = breakingEntries(entries);
console.log(
  `diffed in ${since(mark)}: ${entries.length} deltas, ${breaking.length} breaking`,
);

const byId = new Map<string, number>();
for (const entry of breaking) byId.set(entry.id, (byId.get(entry.id) ?? 0) + 1);
console.log("  breaking, by kind:");
for (const [id, count] of [...byId].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`    ${count.toString().padStart(4)}  ${id}`);
}

mark = performance.now();
const judge =
  process.argv[4] === "hybrid"
    ? new HybridJudge(new RulesJudge(), new JevJudge())
    : new RulesJudge();
const drafted = await propose(before.document, after.document, { judge });
console.log(
  `proposed in ${since(mark)}: ${drafted.proposals.length} drafts, ` +
    `${drafted.unresolved.length} unresolved, ${drafted.impasses.length} impasses`,
);

// What it actually decided, so a person can judge the alignments rather than
// only the counts. On real documents there are no labels, and reading a dozen
// is the only way to tell a useful draft from a confident guess.
const aligned = drafted.proposals.filter((proposal) =>
  proposal.change.ops.some((op) => op.op === "move"),
);
if (aligned.length > 0) {
  console.log(`\nfield alignments (${aligned.length}):`);
  for (const proposal of aligned.slice(0, 20)) {
    console.log(
      `  ${(proposal.confidence * 100).toFixed(0).padStart(3)}%  ${proposal.change.summary}`,
    );
  }
}

mark = performance.now();
const predicted = predictDocument(
  before.document,
  after.document,
  drafted.proposals.map((proposal) => proposal.change),
);
console.log(`compiled in ${since(mark)}: ${predicted.issues.length} issues`);
for (const issue of predicted.issues.slice(0, 5)) {
  console.log(`    ${issue.changeId}: ${issue.message}`);
}

mark = performance.now();
const residual = breakingEntries(await diffDocuments(predicted.document, after.document));
console.log(
  `closure in ${since(mark)}: ${breaking.length} breaking before, ${residual.length} after`,
);
console.log("\nfirst few still unexplained:");
for (const entry of residual.slice(0, 8)) console.log(`  - ${describeEntry(entry)}`);
