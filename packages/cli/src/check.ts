/**
 * `invariant check`: the release gate, run in the provider's own CI.
 *
 * It answers one question. Do the Changes in this pull request completely
 * explain what the API actually did? Anything left over is a change nobody
 * wrote down, and the release does not pass with one outstanding.
 *
 * Unexplained breaking deltas and failed verification are not configurable.
 * A provider can decide how loudly to treat a declared loss; it cannot decide
 * to ship a change nobody accounted for.
 */

import {
  type ContractStep,
  chainProgram,
  derive,
  missingAcknowledgement,
  predictDocument,
} from "@invariant/compiler";
import {
  type Contract,
  listReleasedLabels,
  loadContract,
  loadPendingChanges,
  loadReleaseStep,
} from "@invariant/contract";
import {
  breakingEntries,
  describeEntry,
  diffDocuments,
  oasdiffAvailable,
} from "@invariant/diff";
import type { Change, CompiledProgram } from "@invariant/ir";
import { type Evidence, inputsDigest } from "@invariant/verifier";
import type { InvariantConfig } from "./config.ts";
import { type VerifyOptions, verify } from "./verify.ts";

export type GateResult = "pass" | "warn" | "block";

export interface StepReport {
  from: string;
  to: string;
  changes: Change[];
  /** Breaking deltas no Change accounts for. */
  unexplained: string[];
  /** Problems applying the declared Changes at all. */
  issues: string[];
  additive: number;
}

export interface CheckReport {
  api: string;
  current: { label: string; digest: string };
  steps: StepReport[];
  program: CompiledProgram | undefined;
  warnings: string[];
  /** What was actually checked, one record per layer per subject. */
  evidence: Evidence[];
  /** Everything a verification layer found wrong. */
  problems: string[];
  /** Differences the provider named and justified. */
  acknowledged: string[];
  result: GateResult;
}

async function contractsFor(config: InvariantConfig): Promise<{
  released: { label: string; contract: Contract }[];
  current: Contract;
}> {
  const labels = [...config.releasedSpecs.keys()].sort();
  const released = await Promise.all(
    labels.map(async (label) => ({
      label,
      contract: await loadContract(config.releasedSpecs.get(label) as string, label),
    })),
  );
  const currentLabel = new Date().toISOString().slice(0, 10);
  return { released, current: await loadContract(config.currentSpec, currentLabel) };
}

/**
 * Builds the ordered list of contract steps, oldest first, ending at the
 * pending Changes that this pull request is proposing.
 */
async function stepsFor(config: InvariantConfig): Promise<{
  steps: ContractStep[];
  current: Contract;
}> {
  const { released, current } = await contractsFor(config);
  const releasedLabels = await listReleasedLabels(config.invariantDir);

  const steps: ContractStep[] = [];
  for (let index = 0; index < released.length - 1; index += 1) {
    const from = released[index] as { label: string; contract: Contract };
    const to = released[index + 1] as { label: string; contract: Contract };
    if (!releasedLabels.includes(to.label)) {
      throw new Error(`No released Changes for contract ${to.label}`);
    }
    const step = await loadReleaseStep(config.invariantDir, to.label);
    steps.push({
      label: to.label,
      parent: from.label,
      from: from.contract.document,
      to: to.contract.document,
      changes: step.changes,
    });
  }

  const last = released[released.length - 1];
  if (last) {
    steps.push({
      label: current.label,
      parent: last.label,
      from: last.contract.document,
      to: current.document,
      changes: await loadPendingChanges(config.invariantDir),
    });
  }

  return { steps, current };
}

export async function check(
  config: InvariantConfig,
  options: VerifyOptions = {},
): Promise<CheckReport> {
  if (!(await oasdiffAvailable())) {
    throw new Error(
      'oasdiff is required. Install it with "go install github.com/oasdiff/oasdiff@latest".',
    );
  }

  const { steps, current } = await stepsFor(config);
  const reports: StepReport[] = [];
  const warnings: string[] = [];
  const evidence: Evidence[] = [];

  for (const step of steps) {
    const prediction = predictDocument(step.from, step.to, step.changes);
    const entries = await diffDocuments(prediction.document, step.to);
    const breaking = breakingEntries(entries);

    reports.push({
      from: step.parent,
      to: step.label,
      changes: step.changes,
      unexplained: breaking.map(describeEntry),
      issues: prediction.issues.map((issue) => `${issue.changeId}: ${issue.message}`),
      additive: entries.length - breaking.length,
    });

    evidence.push({
      kind: "E2-closure",
      subject: `${step.parent} -> ${step.label}`,
      result: breaking.length > 0 || prediction.issues.length > 0 ? "fail" : "pass",
      inputsDigest: inputsDigest(step.changes, step.parent, step.label),
      tool: "oasdiff",
      summary:
        breaking.length > 0
          ? `${breaking.length} breaking deltas no Change accounts for`
          : `the declared Changes explain the whole breaking diff, ` +
            `alongside ${entries.length - breaking.length} compatible deltas`,
      ...(breaking.length > 0 ? { detail: breaking.map(describeEntry) } : {}),
    });

    for (const change of step.changes) {
      if (change.assertions?.side_effects_unchanged !== true) {
        warnings.push(
          `${change.id} does not state whether side effects are unchanged. ` +
            "Add side_effects_unchanged to its assertions.",
        );
      }

      // A change that cannot be served exactly has to say so in its own file.
      // Deriving the class and then letting it pass unmentioned would put the
      // judgement in the tool rather than with the person accountable for it.
      const derived = derive(change);
      if (missingAcknowledgement(change, derived)) {
        warnings.push(
          `${change.id} is ${derived.runtime} and does not acknowledge it. ` +
            `Add loss_acknowledged: true, having read why: ${derived.reasons[0] ?? ""}`,
        );
      }
      if (derived.runtime === "none") {
        warnings.push(
          `${change.id} cannot be served to an old caller at all. ${derived.reasons[0] ?? ""}`,
        );
      }
    }
  }

  // E1. Every Change in this release parsed as this version of the IR, which
  // happened during loading: an unknown op kind or an unknown field is a hard
  // error there, so reaching this line is the proof.
  const declared = steps.flatMap((step) => step.changes);
  evidence.push({
    kind: "E1-schema",
    subject: `${config.api} ${current.label}`,
    result: "pass",
    inputsDigest: inputsDigest(declared),
    tool: "typebox",
    summary:
      `${declared.length} Change ${declared.length === 1 ? "file" : "files"} parsed as ` +
      "IR version 1, with no unknown op kinds and no unknown fields",
  });

  const verified = await verify(config, steps, current.label, current.document, options);
  evidence.push(...verified.evidence);

  const chained = chainProgram(config.api, current.label, current.digest, steps);
  for (const issue of chained.issues) {
    warnings.push(`${issue.changeId}: ${issue.message}`);
  }

  const blocked =
    reports.some((report) => report.unexplained.length > 0 || report.issues.length > 0) ||
    verified.problems.length > 0;

  return {
    api: config.api,
    current: { label: current.label, digest: current.digest },
    steps: reports,
    program: blocked ? undefined : chained.program,
    warnings,
    evidence,
    problems: verified.problems,
    acknowledged: verified.acknowledged,
    result: blocked ? "block" : warnings.length > 0 ? "warn" : "pass",
  };
}

/** The report a provider reads in their pull request. */
export function renderReport(report: CheckReport): string {
  const lines: string[] = [];
  const pending = report.steps[report.steps.length - 1];

  lines.push(`API release check - ${report.api}`, "");
  if (pending) {
    lines.push(`Contract ${pending.from} -> ${pending.to}`);
    lines.push(`  ${pending.changes.length} declared changes`);
    lines.push(`  ${pending.additive} additive or otherwise compatible deltas`);
    if (pending.unexplained.length > 0) {
      lines.push(`  ${pending.unexplained.length} breaking deltas nothing accounts for:`);
      for (const entry of pending.unexplained) lines.push(`    - ${entry}`);
    }
    for (const issue of pending.issues) lines.push(`  ! ${issue}`);
  }

  const served = report.steps.map((step) => step.from);
  if (served.length > 0) {
    lines.push("", `Historical contracts still served: ${served.join(", ")}`);
  }

  // What was checked comes before what went wrong. A reader who sees only a
  // list of failures has no way to tell which layers ran at all, and a layer
  // that silently did not run is the way a gate stops being one.
  if (report.evidence.length > 0) {
    lines.push("", "What was checked:");
    for (const kind of EVIDENCE_ORDER) {
      const group = report.evidence.filter((entry) => entry.kind === kind);
      if (group.length === 0) continue;
      const failed = group.filter((entry) => entry.result === "fail").length;
      const skipped = group.filter((entry) => entry.result === "skipped").length;
      const mark = failed > 0 ? "x" : skipped === group.length ? "-" : "+";
      lines.push(`  ${mark} ${EVIDENCE_NAMES[kind]}`);
      for (const entry of group) {
        lines.push(`      ${entry.subject}: ${entry.summary}`);
      }
    }
  }

  if (report.acknowledged.length > 0) {
    lines.push("", "Differences the provider has accepted:");
    for (const entry of report.acknowledged) lines.push(`  - ${entry}`);
  }

  if (report.problems.length > 0) {
    lines.push("", "Verification found:");
    for (const problem of report.problems) lines.push(`  - ${problem}`);
  }

  if (report.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of report.warnings) lines.push(`  - ${warning}`);
  }

  lines.push("", `Release status: ${report.result.toUpperCase()}`);
  if (report.result === "block") {
    const unexplained = report.steps.some((step) => step.unexplained.length > 0);
    lines.push(
      unexplained
        ? "Reason: the declared Changes do not fully explain this release."
        : "Reason: a verification layer found something that would break an old caller.",
      "Every breaking delta needs a Change that accounts for it, and every",
      "Change has to hold when it is actually run, or the old contract cannot",
      "be served.",
    );
  }

  return lines.join("\n");
}

const EVIDENCE_ORDER = [
  "E1-schema",
  "E2-closure",
  "E3-totality",
  "E4-laws",
  "E5-chain",
  "E6-differential",
  "E7-conformance",
  "E8-merge",
  "E9-runtime",
] as const;

const EVIDENCE_NAMES: Record<string, string> = {
  "E1-schema": "the Change files are valid IR",
  "E2-closure": "the Changes explain the whole breaking diff",
  "E3-totality": "no schema-valid input reaches an undefined case",
  "E4-laws": "each schema's Changes round trip on generated values",
  "E5-chain": "one pass equals applying each step in turn",
  "E6-differential": "the old build and the new build plus adapter agree",
  "E7-conformance": "the running code matches its own specification",
  "E8-merge": "a person with write access reviewed it",
  "E9-runtime": "what production has reported since",
};
