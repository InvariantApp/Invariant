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
import { findInterference } from "@invariant/compiler";
import { loadContract, loadPendingChanges } from "@invariant/contract";
import type { Change } from "@invariant/ir";
import {
  CHOOSE_ONE,
  type Decision,
  decisionChange,
  describeShape,
  type FoldDecision,
  HybridJudge,
  type Impasse,
  JevJudge,
  type Proposal,
  propose,
  RulesJudge,
  type Unresolved,
  type ValueDecision,
} from "@invariant/proposer";
import { stringify as stringifyYaml } from "yaml";
import type { InvariantConfig } from "./config.ts";

export interface ProposeResult {
  proposals: Proposal[];
  /**
   * What only the provider can answer, each drafted as a Change with the
   * answer left as a placeholder: vocabularies that changed, with suggestions
   * beside them, and values the specification does not give.
   */
  decisions: Decision[];
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

/** The explanation a decision file opens with, wrapped as comment lines. */
function wrapped(text: string): string[] {
  return (text.match(/.{1,74}(\s|$)/g) ?? []).map((line) => `# ${line.trimEnd()}`);
}

/**
 * A decision drafted with every answer left as `CHOOSE_ONE`, headed so no one
 * mistakes it for one already made.
 */
function renderDecision(decision: Decision, change: Change): string {
  return decision.kind === "vocabulary"
    ? renderVocabularyDecision(decision, change)
    : renderValueDecision(decision, change);
}

function renderValueDecision(decision: ValueDecision, change: Change): string {
  const header = [
    "# DECISION NEEDED. Nothing below has been decided.",
    "#",
    ...wrapped(decision.why),
    "#",
    `# Replace ${CHOOSE_ONE} below with ${describeShape(decision.shape)}.`,
    "# The release gate refuses this Change while the placeholder is left.",
  ];
  return `${header.join("\n")}\n${stringifyYaml(change as unknown as Record<string, unknown>)}`;
}

/** A vocabulary decision, with the suggestions beside the placeholders. */
function renderVocabularyDecision(decision: FoldDecision, change: Change): string {
  const suggestion = (value: string, target: string) =>
    target === CHOOSE_ONE
      ? `#   ${value}: nothing in the names suggests an answer`
      : `#   ${value}: ${target}, suggested because the names share a part`;
  const header = [
    "# DECISION NEEDED. Nothing below has been decided.",
    "#",
    ...wrapped(decision.why),
    "#",
    `# Replace every ${CHOOSE_ONE} below with one of: ${decision.choices.join(", ")}`,
    ...(decision.suggested.fold.length > 0
      ? ["#", "# What each new value could be shown as:"]
      : []),
    ...decision.suggested.fold.map(([value, target]) => suggestion(value, target)),
    ...(decision.suggested.pairs.length > 0
      ? ["#", "# What each value that went could have become:"]
      : []),
    ...decision.suggested.pairs.map(([value, target]) => suggestion(value, target)),
    "#",
    "# The suggestions come from what the names share, not what they mean.",
    "# The release gate refuses this Change while any placeholder is left,",
    "# and a fold is a declared loss you then acknowledge under assertions.",
  ];
  return `${header.join("\n")}\n${stringifyYaml(change as unknown as Record<string, unknown>)}`;
}

export async function runPropose(
  config: InvariantConfig,
  options: { write?: boolean; context?: string; offline?: boolean } = {},
): Promise<ProposeResult> {
  const labels = [...config.releasedSpecs.keys()].sort();
  const latest = labels[labels.length - 1];
  if (!latest) {
    return {
      proposals: [],
      decisions: [],
      unresolved: [],
      impasses: [],
      skipped: [],
      written: [],
    };
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

  const { proposals, unresolved, impasses, decisions } = await propose(
    previous.document,
    current.document,
    {
      judge,
      ...(options.context === undefined ? {} : { context: options.context }),
    },
  );

  const declared = new Set(existing.map((change: Change) => change.id));
  // A draft touching what a Change already in the repository touches is
  // that Change said again under another name, and the two would collide at
  // the gate. The one a person wrote or merged stands.
  const covered = (change: Change) =>
    findInterference([...existing, change]).some((issue) => issue.changeId === change.id);
  const fresh = proposals.filter(
    (proposal) => !declared.has(proposal.change.id) && !covered(proposal.change),
  );
  const skipped = proposals
    .filter((proposal) => !fresh.includes(proposal))
    .map((proposal) => proposal.change.id);

  const freshDecisions = decisions.filter((decision) => {
    const change = decisionChange(decision);
    return !declared.has(change.id) && !covered(change);
  });
  const written: string[] = [];
  if (options.write) {
    for (const proposal of fresh) {
      const path = join(config.invariantDir, "changes", `${proposal.change.id}.yaml`);
      await writeFile(path, render(proposal), "utf8");
      written.push(path);
    }
    for (const decision of freshDecisions) {
      const change = decisionChange(decision);
      const path = join(config.invariantDir, "changes", `${change.id}.yaml`);
      await writeFile(path, renderDecision(decision, change), "utf8");
      written.push(path);
    }
  }

  return {
    proposals: fresh,
    decisions: freshDecisions,
    unresolved,
    impasses,
    skipped,
    written,
  };
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

/** Vocabularies that grew: a decision each, drafted with suggestions for a person to check. */
function renderDecisions(result: ProposeResult): string[] {
  if (result.decisions.length === 0) return [];
  const lines = [
    `${result.decisions.length} ${result.decisions.length === 1 ? "decision needs" : "decisions need"} you, drafted with the answer left open:`,
    "",
  ];
  for (const decision of result.decisions) {
    lines.push(`  ${decision.schema}.${decision.field}`);
    if (decision.kind === "value") {
      lines.push(
        `    ${decision.why}`,
        `    Answer with ${describeShape(decision.shape)}.`,
        "",
      );
      continue;
    }
    for (const [value, target] of decision.suggested.fold) {
      lines.push(
        target === CHOOSE_ONE
          ? `    show ${value} as what? (no suggestion)`
          : `    show ${value} as ${target}?`,
      );
    }
    for (const [value, target] of decision.suggested.pairs) {
      lines.push(
        target === CHOOSE_ONE
          ? `    ${value} became what? (no suggestion)`
          : `    ${value} became ${target}?`,
      );
    }
    lines.push("");
  }
  if (result.decisions.some((decision) => decision.kind === "vocabulary")) {
    lines.push("  Each suggestion comes from what the names share, not what they mean.");
  }
  lines.push(
    `  The gate refuses these until every ${CHOOSE_ONE} is replaced with an answer.`,
    "",
  );
  return lines;
}

export function renderProposals(result: ProposeResult): string {
  if (result.proposals.length === 0) {
    const nothing = [
      ...renderDecisions(result),
      ...renderImpasses(result),
      ...renderUnresolved(result),
    ];
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
  lines.push(
    ...renderDecisions(result),
    ...renderImpasses(result),
    ...renderUnresolved(result),
  );

  if (result.written.length > 0) {
    lines.push(`Wrote ${result.written.length} files into invariant/changes.`);
    lines.push("Review them, fix what is wrong, and commit them with the API change.");
  } else {
    lines.push("Nothing written. Pass --write to put these in invariant/changes.");
  }
  return lines.join("\n");
}
