/**
 * `invariant propose`: drafts Change files into the provider's pull request.
 *
 * The drafts are the confirmation mechanism. A provider reads them while the
 * change is fresh, edits what is wrong, and merges; git then records who
 * confirmed what, and the release gate checks the result. Nothing here decides
 * anything, and nothing here writes outside `invariant/changes`.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadContract, loadPendingChanges } from "@invariant/contract";
import type { Change } from "@invariant/ir";
import {
  HybridJudge,
  type Impasse,
  JevJudge,
  type Proposal,
  propose,
  RulesJudge,
  type Unresolved,
} from "@invariant/proposer";
import { stringify as stringifyYaml } from "yaml";
import type { InvariantConfig } from "./config.ts";

export interface ProposeResult {
  proposals: Proposal[];
  /** Changes the proposer would not draft, with the reason it would not. */
  unresolved: Unresolved[];
  /** Changes no Change could express, named as one problem each. */
  impasses: Impasse[];
  /** Ids already declared in the repository, which are left alone. */
  skipped: string[];
  written: string[];
}

function render(proposal: Proposal): string {
  const header = [
    `# Drafted by ${proposal.judge}, ${(proposal.confidence * 100).toFixed(0)}% confident.`,
    "#",
    "# This is a proposal, not a decision. Read it, fix what is wrong, and merge",
    "# it; merging is what records that you confirmed it. The release gate will",
    "# still check that these ops explain the whole breaking diff.",
  ];
  if (proposal.attention === "explicit") {
    header.push("#", "# NEEDS A CLOSE LOOK:");
  } else if (proposal.notes.length > 0) {
    header.push("#");
  }
  for (const note of proposal.notes) header.push(`#   - ${note}`);

  return `${header.join("\n")}\n${stringifyYaml(proposal.change as unknown as Record<string, unknown>)}`;
}

export async function runPropose(
  config: InvariantConfig,
  options: { write?: boolean; context?: string; offline?: boolean } = {},
): Promise<ProposeResult> {
  const labels = [...config.releasedSpecs.keys()].sort();
  const latest = labels[labels.length - 1];
  if (!latest) {
    return { proposals: [], unresolved: [], impasses: [], skipped: [], written: [] };
  }

  const [previous, current, existing] = await Promise.all([
    loadContract(config.releasedSpecs.get(latest) as string, latest),
    loadContract(config.currentSpec, "current"),
    loadPendingChanges(config.invariantDir),
  ]);

  // Rules first, so a model is only asked about what spelling cannot settle.
  const judge = options.offline
    ? new RulesJudge()
    : new HybridJudge(new RulesJudge(), new JevJudge());

  const { proposals, unresolved, impasses } = await propose(
    previous.document,
    current.document,
    {
      judge,
      ...(options.context === undefined ? {} : { context: options.context }),
    },
  );

  const declared = new Set(existing.map((change: Change) => change.id));
  const fresh = proposals.filter((proposal) => !declared.has(proposal.change.id));
  const skipped = proposals
    .filter((proposal) => declared.has(proposal.change.id))
    .map((proposal) => proposal.change.id);

  const written: string[] = [];
  if (options.write) {
    for (const proposal of fresh) {
      const path = join(config.invariantDir, "changes", `${proposal.change.id}.yaml`);
      await writeFile(path, render(proposal), "utf8");
      written.push(path);
    }
  }

  return { proposals: fresh, unresolved, impasses, skipped, written };
}

/**
 * The ones there is no Change for, at any confidence, ever.
 *
 * Printed above the per-field list and separately from it, because a provider
 * who reads "three fields are unaccounted for" goes looking for three Changes,
 * and here there are none to find. Leaving them to work that out from a blocked
 * release would be the worst first impression this tool could make.
 */
function renderImpasses(result: ProposeResult): string[] {
  if (result.impasses.length === 0) return [];

  const lines = [
    `${result.impasses.length} ${result.impasses.length === 1 ? "change has" : "changes have"} no Change that could express ${result.impasses.length === 1 ? "it" : "them"}:`,
    "",
  ];
  for (const impasse of result.impasses) {
    lines.push(`  ${impasse.schema}: a ${impasse.kind}`);
    lines.push(`    ${impasse.why}`);
    lines.push("");
    lines.push("    What you can do:");
    for (const [index, option] of impasse.options.entries()) {
      lines.push(`      ${index + 1}. ${option}`);
    }
    lines.push("");
  }
  return lines;
}

function renderUnresolved(result: ProposeResult): string[] {
  // Fields already explained as part of an impasse are not separate problems.
  const claimed = new Set(
    result.impasses.flatMap((impasse) =>
      [...impasse.removed, ...impasse.added].map((field) => `${impasse.schema}.${field}`),
    ),
  );
  const rest = result.unresolved.filter(
    (entry) => !claimed.has(`${entry.schema}.${entry.field}`),
  );
  if (rest.length === 0) return [];

  // Saying nothing here would leave the provider to discover these from a
  // blocked release instead, with less to go on.
  return [
    `${rest.length} changes it would not draft, which you will have to write yourself:`,
    "",
    ...rest.flatMap((entry) => [
      `  ${entry.schema}.${entry.field}`,
      `    ${entry.reason}`,
    ]),
    "",
  ];
}

export function renderProposals(result: ProposeResult): string {
  if (result.proposals.length === 0) {
    const nothing = [...renderImpasses(result), ...renderUnresolved(result)];
    if (nothing.length > 0) return nothing.join("\n").trimEnd();
    return result.skipped.length > 0
      ? `Every change this release makes is already declared (${result.skipped.length} of them).`
      : "Nothing to propose: no breaking field changes found between the last contract and current.";
  }

  const lines = [`${result.proposals.length} draft changes:`, ""];
  for (const proposal of result.proposals) {
    const mark = proposal.attention === "explicit" ? " [needs a close look]" : "";
    lines.push(`  ${proposal.change.id}${mark}`);
    lines.push(`    ${proposal.change.summary}`);
    lines.push(
      `    drafted by ${proposal.judge}, ${(proposal.confidence * 100).toFixed(0)}% confident`,
    );
    for (const note of proposal.notes) lines.push(`    - ${note}`);
    lines.push("");
  }
  lines.push(...renderImpasses(result), ...renderUnresolved(result));

  if (result.written.length > 0) {
    lines.push(`Wrote ${result.written.length} files into invariant/changes.`);
    lines.push("Review them, fix what is wrong, and commit them with the API change.");
  } else {
    lines.push("Nothing written. Pass --write to put these in invariant/changes.");
  }
  return lines.join("\n");
}
