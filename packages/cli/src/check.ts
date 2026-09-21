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

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type ContractStep, chainProgram, predictDocument } from "@invariant/compiler";
import {
  type Contract,
  listReleasedLabels,
  loadContract,
  loadPendingChanges,
  loadReleaseStep,
} from "@invariant/contract";
import {
  assertUsableOasdiff,
  breakingEntries,
  catalogueEntry,
  describeEntry,
  diffDocuments,
  kindsOf,
} from "@invariant/diff";
import type { Change, CompiledProgram } from "@invariant/ir";
import { type Evidence, inputsDigest } from "@invariant/verifier";
import type { InvariantConfig } from "./config.ts";
import { outcomeEvidence, readOutcomes } from "./outcomes.ts";
import { applyGatePolicy } from "./policy.ts";
import { readLedger, type UsageRecord } from "./usage.ts";
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
  /**
   * Declared Changes the compiled program cannot carry out.
   *
   * Closure proves the Changes describe the release. This says whether the
   * runtime can then do what they describe, which is a separate question and
   * the one an old caller actually depends on.
   */
  unservable: string[];
  /** What the gate settings in invariant.yaml refuse. */
  policy: string[];
  result: GateResult;
}

/**
 * The usage ledger, if there is one.
 *
 * Named explicitly, or the file the runtime's counters write by convention.
 * Absent is returned as undefined rather than as no usage, because the two
 * mean different things to anyone deciding whether an old contract is empty.
 */
async function usageFor(
  config: InvariantConfig,
  path: string | undefined,
): Promise<UsageRecord[] | undefined> {
  const ledger = resolve(config.root, path ?? "invariant/usage.jsonl");
  if (path === undefined && !existsSync(ledger)) return undefined;
  return readLedger(ledger);
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
  const pending = await loadPendingChanges(config.invariantDir);
  if (pending.length > 0 && config.releasedSpecs.has(current.label)) {
    // Compiling new Changes under a published label would change what that
    // label means to every caller already pinned to it.
    throw new Error(
      `spec.currentLabel is ${current.label}, which is already released. Name the ` +
        "contract this pull request builds before declaring Changes for it.",
    );
  }
  if (last) {
    steps.push({
      label: current.label,
      parent: last.label,
      from: last.contract.document,
      to: current.document,
      changes: pending,
    });
  }

  return { steps, current };
}

export async function check(
  config: InvariantConfig,
  options: VerifyOptions = {},
): Promise<CheckReport> {
  await assertUsableOasdiff();

  const { steps, current } = await stepsFor(config);
  const reports: StepReport[] = [];
  const warnings: string[] = [];
  const evidence: Evidence[] = [];

  for (const step of steps) {
    const prediction = predictDocument(step.from, step.to, step.changes);
    // Always confirmed here, whatever it costs. This comparison decides whether
    // a release may ship, and oasdiff 1.32.1 was found returning a different
    // answer each run on documents with reference cycles. Repeating it makes
    // the gate independent of which build of the differ is installed: an answer
    // that will not reproduce is refused rather than acted on.
    const entries = await diffDocuments(prediction.document, step.to, {
      confirm: true,
    });
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
    }
  }

  const usage = await usageFor(config, options.usage);
  const policy = applyGatePolicy(
    config,
    steps.map((step, index) => ({
      changes: step.changes,
      pending: index === steps.length - 1,
    })),
    usage,
  );
  warnings.push(...policy.warnings);

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

  // E9. The only evidence here that is an observation rather than a prediction,
  // and the only one that can say the predictions held. It never blocks: a
  // release is very often the fix for what this is reporting.
  if (options.outcomes !== undefined) {
    const served = [...config.releasedSpecs.keys()].sort();
    const observed = outcomeEvidence(served, await readOutcomes(options.outcomes));
    evidence.push(...observed);
    for (const entry of observed) {
      if (entry.result !== "fail") continue;
      warnings.push(
        `Production is failing transforms for contract ${entry.subject}: ${entry.summary}. ` +
          "The operation had already run each time, so those callers were charged " +
          "for work whose result they never got.",
      );
    }
  }

  // Each step is projected once for every historical contract it lies on the
  // way from, so the same issue arrives several times.
  const chained = chainProgram(
    config.api,
    current.label,
    current.digest,
    steps,
    config.identity ? { identity: config.identity } : {},
  );
  const unservable = [
    ...new Set(chained.issues.map((issue) => `${issue.changeId}: ${issue.message}`)),
  ];

  const blocked =
    reports.some(
      (report) =>
        report.unexplained.length > 0 ||
        report.issues.length > 0 ||
        report.stale.length > 0,
    ) ||
    verified.problems.length > 0 ||
    unservable.length > 0 ||
    policy.blocks.length > 0;

  return {
    api: config.api,
    current: { label: current.label, digest: current.digest },
    steps: reports,
    program: blocked ? undefined : chained.program,
    warnings,
    evidence,
    problems: verified.problems,
    acknowledged: verified.acknowledged,
    unservable,
    policy: policy.blocks,
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
      lines.push("", "  What each kind means, and what can serve it:");
      for (const id of kindsOf(pending.unexplained)) {
        lines.push(`    ${id}: ${catalogueEntry(id).sentence}`);
      }

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

  if (report.policy.length > 0) {
    lines.push("", "Refused by the gate settings in invariant.yaml:");
    for (const entry of report.policy) lines.push(`  - ${entry}`);
  }

  if (report.unservable.length > 0) {
    lines.push("", "Changes the runtime cannot serve:");
    for (const entry of report.unservable) lines.push(`  - ${entry}`);
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
  if (report.result === "block") lines.push(...reasonFor(report));

  return lines.join("\n");
}

/**
 * Why this release is blocked, said accurately.
 *
 * Worth the care, because a gate that misdiagnoses is worse than one that only
 * says no: it sends a provider to read the wrong files. A stale specification
 * in particular is not a compatibility failure at all, and telling someone
 * their unchanged code would break an old caller, when what actually happened
 * is that their OpenAPI document mentions a field their handler does not
 * return, is the worst first impression this tool could make.
 */
function reasonFor(report: CheckReport): string[] {
  const unexplained = report.steps.some(
    (step) =>
      step.unexplained.length > 0 || step.issues.length > 0 || step.stale.length > 0,
  );
  if (unexplained) {
    return [
      "Reason: the declared Changes do not fully explain this release.",
      "Every breaking delta needs a Change that accounts for it, and every",
      "Change has to hold when it is actually run, or the old contract cannot",
      "be served.",
    ];
  }

  if (report.policy.length > 0 && report.unservable.length === 0) {
    return [
      "Reason: this release does something invariant.yaml says to refuse.",
      "Each line above names the setting. Change the release, or change the",
      "setting if the policy itself is what is wrong.",
    ];
  }

  if (report.unservable.length > 0) {
    return [
      "Reason: a declared Change describes this release correctly, but the",
      "compiled adapter cannot carry it out. Shipping it would tell old callers",
      "they are served when their requests reach your code untranslated.",
    ];
  }

  const failing = new Set(
    report.evidence.filter((entry) => entry.result === "fail").map((entry) => entry.kind),
  );
  if (failing.size === 1 && failing.has("E7-conformance")) {
    return [
      "Reason: the specification does not describe the code that is running.",
      "",
      "Nothing here says an old caller would break. It says the document this",
      "release was checked against is not the one your service implements, and",
      "every other check in this report reasons about that document. A contract",
      "that is wrong does not make the rest of this wrong, it makes it",
      "meaningless, which is why it stops here.",
      "",
      "The mismatches are listed above, each naming the operation, the status",
      "and the field. If your specification is generated from your code,",
      "regenerate it and run this again. If it is written by hand, either the",
      "handler has not caught up with it or it describes something that was",
      "never true.",
    ];
  }

  return [
    "Reason: a verification layer found something that would break an old caller.",
    "Every Change has to hold when it is actually run, or the old contract",
    "cannot be served.",
  ];
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
