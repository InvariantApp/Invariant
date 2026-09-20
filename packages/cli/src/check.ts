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
  /** Claims a behavior Change makes that this release no longer breaks. */
  stale: string[];
  /** Breaking deltas a behavior Change accounts for, with no transform behind them. */
  accounted: number;
  additive: number;
}

/**
 * Every breaking delta a `behavior` Change in this step claims to cover.
 *
 * The claims are compared as text against what the gate prints, which is the
 * point: a provider copies the line, so the thing they acknowledged and the
 * thing that happened cannot drift apart without the comparison failing.
 */
function claimsIn(changes: readonly Change[]): Set<string> {
  const claims = new Set<string>();
  for (const change of changes) {
    for (const op of change.ops) {
      if (op.op !== "behavior") continue;
      for (const line of op.covers ?? []) claims.add(line);
    }
  }
  return claims;
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
  // The provider's own name for the contract being built, or today's date if
  // they have not given one. The fallback makes the compiled program depend on
  // the day it was built, which `invariant check` warns about rather than
  // leaving for someone to discover from two artifacts that will not match.
  const currentLabel = config.currentLabel ?? new Date().toISOString().slice(0, 10);
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
    const breakingAll = breakingEntries(entries);

    const claimed = claimsIn(step.changes);
    const breaking = breakingAll.filter((entry) => !claimed.has(describeEntry(entry)));
    const accounted = breakingAll.length - breaking.length;

    // A claim for a delta that is no longer there means the contract moved
    // under an acknowledgement, so whoever signed it has not seen what they
    // are now signing. Blocking is the only reading of that which is safe.
    const stale = [...claimed].filter(
      (line) => !breakingAll.some((entry) => describeEntry(entry) === line),
    );
    for (const line of stale) {
      warnings.push(
        `A behavior Change still claims to cover "${line}", which this release no ` +
          "longer breaks. Remove the line, so what was acknowledged is what is true.",
      );
    }

    reports.push({
      from: step.parent,
      to: step.label,
      changes: step.changes,
      unexplained: breaking.map(describeEntry),
      stale,
      accounted,
      issues: prediction.issues.map((issue) => `${issue.changeId}: ${issue.message}`),
      additive: entries.length - breakingAll.length,
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
          : accounted > 0
            ? `the declared Changes explain the whole breaking diff, of which ` +
              `${accounted} ${accounted === 1 ? "is" : "are"} acknowledged as ` +
              "breaking and handled in provider code rather than transformed"
            : `the declared Changes explain the whole breaking diff, ` +
              `alongside ${entries.length - breakingAll.length} compatible deltas`,
      ...(breaking.length > 0 ? { detail: breaking.map(describeEntry) } : {}),
    });

    if (accounted > 0) {
      // Not a failure, and not a pass either. Something here genuinely breaks
      // for an old caller unless provider code handles it, and no layer of
      // this tool can check that it does.
      warnings.push(
        `${accounted} breaking ${accounted === 1 ? "delta is" : "deltas are"} ` +
          `acknowledged by a behavior Change on ${step.parent} -> ${step.label}. ` +
          "Nothing transforms them. Old callers get the new behaviour unless your " +
          "own code branches on the flag, and only your tests can show that it does.",
      );
    }

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

  if (config.currentLabel === undefined) {
    warnings.push(
      "spec.currentLabel is not set, so the contract being built is named after " +
        "today's date. The same commit will compile to a different program " +
        "tomorrow. Set it to make the build depend only on this repository.",
    );
  }

  const verified = await verify(config, steps, current.label, current.document, options);
  evidence.push(...verified.evidence);

  const chained = chainProgram(config.api, current.label, current.digest, steps);
  for (const issue of chained.issues) {
    warnings.push(`${issue.changeId}: ${issue.message}`);
  }

  const blocked =
    reports.some(
      (report) =>
        report.unexplained.length > 0 ||
        report.issues.length > 0 ||
        report.stale.length > 0,
    ) || verified.problems.length > 0;

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
    if (pending.accounted > 0) {
      lines.push(
        `  ${pending.accounted} breaking ${pending.accounted === 1 ? "delta" : "deltas"} acknowledged by a behavior Change, with no transform behind ${pending.accounted === 1 ? "it" : "them"}`,
      );
    }
    if (pending.unexplained.length > 0) {
      lines.push(`  ${pending.unexplained.length} breaking deltas nothing accounts for:`);
      for (const entry of pending.unexplained) lines.push(`    - ${entry}`);

      // A provider whose change genuinely cannot be expressed needs these lines
      // verbatim, and asking them to retype the gate's own output is how a
      // discipline turns into a formality.
      lines.push(
        "",
        "  If your own code handles these, say so by copying them exactly into a",
        "  behavior Change. Nothing will transform them, and this release will",
        "  warn rather than pass:",
        "",
        "    ops:",
        "      - op: behavior",
        "        flag: <a slug naming the change>",
        "        covers:",
      );
      for (const entry of pending.unexplained) {
        lines.push(`          - ${JSON.stringify(entry)}`);
      }
    }
    for (const entry of pending.stale) {
      lines.push(`  ! a behavior Change covers "${entry}", which no longer happens`);
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
