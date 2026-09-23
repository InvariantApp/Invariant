/**
 * The release check, written for a pull request rather than a terminal.
 *
 * A reviewer reading this has thirty seconds and one question: can I merge it?
 * So the verdict is first, the thing that would stop them is second, and the
 * proof that anything was checked at all is underneath, folded away.
 *
 * What is deliberately not here is a summary that sounds better than the run.
 * A layer that was skipped says it was skipped, in the same list as the ones
 * that passed, because a reader who cannot tell the difference between "this
 * held" and "this never ran" has not been told anything.
 */
import { derive } from "@invariant-app/compiler";
import { catalogueEntry, kindsOf } from "@invariant-app/diff";
import type { EvidenceKind } from "@invariant-app/verifier";
import type { CheckReport } from "./check.ts";

const HEADINGS: Record<GateVerdict, string> = {
  pass: "Safe to merge",
  warn: "Safe to merge, with something to read first",
  block: "Not safe to merge",
};

type GateVerdict = "pass" | "warn" | "block";

const LAYER_NAMES: Record<EvidenceKind, string> = {
  "E1-schema": "The Change files are valid IR",
  "E2-closure": "The Changes explain the whole breaking diff",
  "E3-totality": "No schema-valid input reaches an undefined case",
  "E4-laws": "Each schema's Changes round trip on generated values",
  "E5-chain": "One pass equals applying each step in turn",
  "E6-differential": "The old build and the new build plus adapter agree",
  "E7-conformance": "The running code matches its own specification",
  "E8-merge": "A person with write access reviewed it",
  "E9-runtime": "What production has reported since",
};

const LAYER_ORDER: readonly EvidenceKind[] = [
  "E1-schema",
  "E2-closure",
  "E3-totality",
  "E4-laws",
  "E5-chain",
  "E6-differential",
  "E7-conformance",
  "E8-merge",
  "E9-runtime",
];

/** Marker so a second run edits the first comment instead of adding another. */
export const COMMENT_MARKER = "<!-- invariant:release-check -->";

function escapePipes(text: string): string {
  return text.replaceAll("|", "\\|");
}

/**
 * What this release does to the people on the old contract, which is the
 * question a percentage never answers.
 *
 * Every declared Change ends in one of three places: served, so their code
 * carries on; served with something declared lost, so it carries on and they
 * are told what is approximate; or not served at all, which is provider code
 * or nothing. A reviewer deciding whether to merge is deciding about the
 * third group, and it is written out rather than left to be worked out from
 * the evidence below.
 */
function callersNotice(
  step: CheckReport["steps"][number],
  impact: CheckReport["impact"],
): string[] {
  const derived = step.changes.map((change) => ({ change, ...derive(change) }));
  const served = derived.filter((entry) => entry.runtime === "exact");
  const lossy = derived.filter((entry) => entry.runtime === "declared-lossy");
  const unserved = derived.filter((entry) => entry.runtime === "none");
  const count = (n: number, one: string, many = `${one}s`) =>
    `${n} ${n === 1 ? one : many}`;
  const lines = [
    "### What callers on the old contract will notice",
    "",
    `- ${count(served.length, "change")} they will not notice: the adapter serves the old shape.`,
  ];
  if (lossy.length > 0) {
    lines.push(
      `- ${count(lossy.length, "change")} they carry on through, with something this release declares lost.`,
    );
  }
  if (unserved.length > 0) {
    lines.push(
      `- ${count(unserved.length, "change")} nothing can serve. Old callers meet the new behaviour.`,
    );
  }
  // Who that is, where the service has counted them. A number of consumers
  // is what makes the third line above a decision rather than a statistic.
  const carrying = impact?.contracts.filter((contract) => contract.consumers > 0) ?? [];
  if ((lossy.length > 0 || unserved.length > 0) && carrying.length > 0) {
    const consumers = carrying.reduce((sum, contract) => sum + contract.consumers, 0);
    lines.push(
      "",
      `Still out there, over the last ${impact?.days ?? 30} days: ` +
        `${count(consumers, "consumer")} on ${count(carrying.length, "old contract")}` +
        ` (${carrying.map((contract) => `\`${contract.label}\`: ${contract.consumers}`).join(", ")}).`,
    );
  }
  lines.push("");
  for (const entry of [...lossy, ...unserved]) {
    const what = entry.runtime === "none" ? "not served" : "declared loss";
    lines.push(
      `- \`${entry.change.id}\` (${what}): ${entry.reasons[0] ?? entry.change.summary}`,
    );
  }
  if (lossy.length > 0 || unserved.length > 0) lines.push("");
  return lines;
}

export function renderComment(report: CheckReport): string {
  const lines: string[] = [COMMENT_MARKER, ""];
  const verdict = report.result as GateVerdict;
  const pending = report.steps[report.steps.length - 1];

  lines.push(`## ${HEADINGS[verdict]}`, "");

  if (pending) {
    lines.push(
      `Contract \`${pending.from}\` to \`${pending.to}\` on **${report.api}**: ` +
        `${pending.changes.length} declared ${pending.changes.length === 1 ? "change" : "changes"}` +
        `, ${pending.additive} other compatible ${pending.additive === 1 ? "delta" : "deltas"}.`,
      "",
    );
  }

  if (pending && pending.changes.length > 0) {
    lines.push(...callersNotice(pending, report.impact));
  }

  const unexplained = report.steps.flatMap((step) => step.unexplained);
  if (unexplained.length > 0) {
    lines.push(
      `### ${unexplained.length} breaking ${unexplained.length === 1 ? "delta" : "deltas"} nothing accounts for`,
      "",
      "The old contract cannot be served until each of these has a Change that",
      "explains it. `invariant propose` will draft what it can.",
      "",
    );
    for (const entry of unexplained) lines.push(`- ${entry}`);
    lines.push("", "What each kind of delta means, and what can serve it:", "");
    for (const id of kindsOf(unexplained)) {
      lines.push(`- \`${id}\`: ${catalogueEntry(id).sentence}`);
    }
    lines.push("");
  }

  const issues = report.steps.flatMap((step) => step.issues);
  if (issues.length > 0) {
    lines.push("### Changes that do not apply to the old contract", "");
    for (const issue of issues) lines.push(`- ${issue}`);
    lines.push("");
  }

  if (report.policy.length > 0) {
    lines.push("### Refused by this repository's gate settings", "");
    for (const entry of report.policy) lines.push(`- ${entry}`);
    lines.push("");
  }

  if (report.unservable.length > 0) {
    lines.push(
      "### Changes the adapter cannot carry out",
      "",
      "Each of these explains part of the release, and the runtime has no way to",
      "apply it. Old callers would reach your code untranslated.",
      "",
    );
    for (const entry of report.unservable) lines.push(`- ${entry}`);
    lines.push("");
  }

  if (report.problems.length > 0) {
    lines.push(
      `### ${report.problems.length} ${report.problems.length === 1 ? "problem" : "problems"} found by running it`,
      "",
    );
    for (const problem of report.problems) lines.push(`- ${problem}`);
    lines.push("");
  }

  if (report.acknowledged.length > 0) {
    lines.push("### Differences this release accepts", "");
    for (const entry of report.acknowledged) lines.push(`- ${entry}`);
    lines.push("");
  }

  if (report.warnings.length > 0) {
    lines.push("### Worth reading", "");
    for (const warning of report.warnings) lines.push(`- ${warning}`);
    lines.push("");
  }

  // The evidence is folded: present for anyone who wants it, never in the way
  // of the one thing the reviewer came for.
  if (report.evidence.length > 0) {
    const failed = report.evidence.filter((entry) => entry.result === "fail").length;
    lines.push(
      "<details>",
      `<summary>What was checked (${report.evidence.length} records${failed > 0 ? `, ${failed} failing` : ""})</summary>`,
      "",
      "| | Layer | Subject | What it proved |",
      "| --- | --- | --- | --- |",
    );

    for (const kind of LAYER_ORDER) {
      for (const entry of report.evidence.filter((item) => item.kind === kind)) {
        const mark =
          entry.result === "fail"
            ? ":x:"
            : entry.result === "skipped"
              ? ":white_circle:"
              : ":white_check_mark:";
        lines.push(
          `| ${mark} | ${LAYER_NAMES[kind]} | \`${escapePipes(entry.subject)}\` | ${escapePipes(entry.summary)} |`,
        );
      }
    }

    const absent = LAYER_ORDER.filter(
      (kind) => !report.evidence.some((entry) => entry.kind === kind),
    );
    if (absent.length > 0) {
      lines.push(
        "",
        `Not run in this release: ${absent.map((kind) => LAYER_NAMES[kind]).join("; ")}.`,
      );
    }

    lines.push("", "</details>", "");
  }

  if (verdict === "block") {
    lines.push(
      "---",
      "",
      unexplained.length > 0
        ? "Merging this would deploy an API that old integrations cannot call, " +
            "and the compiled adapter would not be built."
        : "The Changes explain the release, but one of them does not hold when " +
            "it is actually run. Merging this would break callers on an older contract.",
    );
  }

  return `${lines.join("\n")}\n`;
}
