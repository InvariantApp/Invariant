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

import { type ContractStep, chainProgram, predictDocument } from "@invariant/compiler";
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
import type { InvariantConfig } from "./config.ts";

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

export async function check(config: InvariantConfig): Promise<CheckReport> {
  if (!(await oasdiffAvailable())) {
    throw new Error(
      'oasdiff is required. Install it with "go install github.com/oasdiff/oasdiff@latest".',
    );
  }

  const { steps, current } = await stepsFor(config);
  const reports: StepReport[] = [];
  const warnings: string[] = [];

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

    for (const change of step.changes) {
      if (change.assertions?.side_effects_unchanged !== true) {
        warnings.push(
          `${change.id} does not state whether side effects are unchanged. ` +
            "Add side_effects_unchanged to its assertions.",
        );
      }
    }
  }

  const chained = chainProgram(config.api, current.label, current.digest, steps);
  for (const issue of chained.issues) {
    warnings.push(`${issue.changeId}: ${issue.message}`);
  }

  const blocked = reports.some(
    (report) => report.unexplained.length > 0 || report.issues.length > 0,
  );

  return {
    api: config.api,
    current: { label: current.label, digest: current.digest },
    steps: reports,
    program: blocked ? undefined : chained.program,
    warnings,
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

  if (report.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of report.warnings) lines.push(`  - ${warning}`);
  }

  lines.push("", `Release status: ${report.result.toUpperCase()}`);
  if (report.result === "block") {
    lines.push(
      "Reason: the declared Changes do not fully explain this release.",
      "Every breaking delta needs a Change that accounts for it, or the old",
      "contract cannot be served.",
    );
  }

  return lines.join("\n");
}
