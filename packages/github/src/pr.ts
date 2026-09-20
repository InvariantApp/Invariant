/**
 * The pull request a consumer receives.
 *
 * This is the only part of the product most consumers will ever see, and it
 * has one job beyond describing the change: it has to make clear which parts
 * of the diff were proven and which were guessed. A migration that mixes a
 * type-checked rename and a name-matched rewrite in one diff, with nothing to
 * tell them apart, teaches the reader to skim both.
 *
 * So provenance is per hunk, the sites the engine would not do are listed
 * before the ones it did, and the pull request opens as a draft. The
 * consumer's own CI decides whether it is ready, because the consumer's own CI
 * is the only thing here that knows what their code is for.
 */
import type { EvolutionBundle } from "@invariant/bundle";
import type { ManualSite } from "@invariant/migrate-ts";

export interface HunkProvenance {
  file: string;
  changeId: string;
  /** Who wrote this hunk: a deterministic codemod, or a model. */
  author: "codemod" | "model";
  reason: string;
  /** False when nothing checked it against a schema, as for raw HTTP. */
  typeChecked: boolean;
}

export interface MigrationSummary {
  bundle: EvolutionBundle;
  repo: string;
  /** The contract this repository spoke before. */
  from: string;
  hunks: HunkProvenance[];
  manual: ManualSite[];
  /** New type errors, which should be empty or the PR should not exist. */
  newDiagnostics: string[];
  /** Whether the consumer's suite was run here. It is not, deliberately. */
  testsRun: false;
}

export const PR_MARKER = "<!-- invariant:migration -->";

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function renderPullRequestTitle(summary: MigrationSummary): string {
  const { bundle } = summary;
  return `Move to ${bundle.api} contract ${bundle.to.label}`;
}

export function renderPullRequestBody(summary: MigrationSummary): string {
  const { bundle } = summary;
  const lines: string[] = [PR_MARKER, ""];

  lines.push(
    `\`${bundle.api}\` released contract **${bundle.to.label}**. This repository ` +
      `speaks \`${summary.from}\`, and this moves it forward.`,
    "",
    "You do not have to merge this to keep working. The provider serves your " +
      "current contract through a compatibility layer, and will until nobody " +
      "is using it. Merging is how that layer eventually stops being needed.",
    "",
  );

  lines.push("## What the provider changed", "");
  for (const change of bundle.changes) {
    lines.push(`- **${change.id}** - ${change.summary}`);
  }
  lines.push("");

  const reviewed = bundle.changes.filter(
    (change) => change.provenance?.confirmed_by?.kind === "provider-merge",
  );
  if (reviewed.length > 0) {
    lines.push(
      `Each was reviewed and merged by someone at the provider, not inferred ` +
        `from a changelog. The release carries ${plural(bundle.evidence.length, "evidence record")}.`,
      "",
    );
  }

  // The unproven half comes first. A reader who stops after one section should
  // have read the part that needs them.
  const unchecked = summary.hunks.filter((hunk) => !hunk.typeChecked);
  if (summary.manual.length > 0 || unchecked.length > 0) {
    lines.push("## Please look at these", "");

    if (unchecked.length > 0) {
      lines.push(
        `${plural(unchecked.length, "change")} below could not be checked against ` +
          "the provider's schema, because nothing in this repository connects " +
          "these call sites to it. They were matched by name.",
        "",
      );
      for (const hunk of unchecked) {
        lines.push(`- \`${hunk.file}\` - ${hunk.reason}`);
      }
      lines.push("");
    }

    if (summary.manual.length > 0) {
      lines.push(
        `${plural(summary.manual.length, "site")} were left alone, with the reason:`,
        "",
      );
      for (const site of summary.manual) {
        lines.push(`- \`${site.file}:${site.line}\` - ${site.reason}`);
      }
      lines.push("");
    }
  }

  const checked = summary.hunks.filter((hunk) => hunk.typeChecked);
  if (checked.length > 0) {
    lines.push(
      "<details>",
      `<summary>${plural(checked.length, "change")} the type checker found and verified</summary>`,
      "",
      "| File | Change | Why |",
      "| --- | --- | --- |",
    );
    for (const hunk of checked) {
      lines.push(`| \`${hunk.file}\` | ${hunk.changeId} | ${hunk.reason} |`);
    }
    lines.push("", "</details>", "");
  }

  const byModel = summary.hunks.filter((hunk) => hunk.author === "model");
  lines.push("## How this was produced", "");
  lines.push(
    `- ${plural(summary.hunks.length - byModel.length, "hunk")} written by a ` +
      "deterministic codemod from the provider's confirmed changes.",
  );
  if (byModel.length > 0) {
    lines.push(
      `- ${plural(byModel.length, "hunk")} written by a model, where the codemod ` +
        "could not reach. Each is listed above.",
    );
  }
  lines.push(
    `- The type checker reports ${
      summary.newDiagnostics.length === 0
        ? "no new errors"
        : `**${plural(summary.newDiagnostics.length, "new error")}**, which is why this is a draft`
    }.`,
    "- Your tests were not run. They run in your CI, on your infrastructure, " +
      "where they belong.",
    "",
    `Bundle \`${bundle.to.digest.slice(0, 19)}\`, published from ` +
      `\`${bundle.source.repo}@${bundle.source.commit.slice(0, 7)}\`.`,
  );

  return `${lines.join("\n")}\n`;
}

/**
 * Whether a draft can be marked ready.
 *
 * Green checks are necessary and not sufficient: a migration that left a new
 * type error, or that touched a site nobody has looked at, stays a draft
 * however green the suite is. Nothing here ever merges anything.
 */
export function readyToPromote(
  summary: MigrationSummary,
  checks: { conclusion: string }[],
): { ready: boolean; reason: string } {
  if (summary.newDiagnostics.length > 0) {
    return {
      ready: false,
      reason: `the migration left ${plural(summary.newDiagnostics.length, "new type error")}`,
    };
  }
  if (summary.manual.length > 0) {
    return {
      ready: false,
      reason: `${plural(summary.manual.length, "site")} need a person to look at them`,
    };
  }
  if (checks.length === 0) {
    return { ready: false, reason: "no checks have reported yet" };
  }

  const failed = checks.filter(
    (check) => check.conclusion !== "success" && check.conclusion !== "neutral",
  );
  if (failed.length > 0) {
    return { ready: false, reason: `${plural(failed.length, "check")} did not pass` };
  }

  return { ready: true, reason: "your checks passed and nothing was left unresolved" };
}
