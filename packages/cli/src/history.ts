/**
 * `invariant history import`: contracts a provider served before adopting
 * Invariant, put in front of the chain it already has.
 *
 * DESIGN 5.3 once left history before onboarding out of scope, and the
 * providers with the most to gain are exactly the ones it excluded: an API
 * that already serves several versions as separate handlers (Adyen's `-v70`
 * and `-v71`, every URL-versioned API) gets its return from deleting the old
 * handlers, and to do that safely it needs the old versions as contracts, the
 * Changes between them, and a check that the adapter answers the way the old
 * handler still does. This command does the first two. The third is
 * `check --full` with the old version's running deployment as a `url` source,
 * which is the one oracle a provider in this position already has.
 *
 * Each document is snapshotted where `release` puts one, and the Changes
 * between neighbours are drafted with rules only into the released step they
 * belong to, headed as drafts. Nothing is decided here: a draft that needs an
 * answer carries a placeholder the gate refuses, and what no Change could
 * express is listed rather than guessed at.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { loadContract, standaloneText } from "@invariant-app/contract";
import { propose, RulesJudge } from "@invariant-app/proposer";
import { isMap, parseDocument, type Scalar, stringify as stringifyYaml } from "yaml";
import type { InvariantConfig } from "./config.ts";
import { type DraftFile, draftFiles } from "./propose.ts";

export class HistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryError";
  }
}

export interface HistoryStep {
  from: string;
  to: string;
  drafts: DraftFile[];
  /** What the proposer would not draft, or no Change could express. */
  open: string[];
}

export interface HistoryResult {
  /** Contract labels added, oldest first. */
  added: string[];
  steps: HistoryStep[];
  wrote: string[];
}

/**
 * Adds each `label=path` document as a released contract older than every
 * one the configuration already names, and drafts the step into each.
 */
export async function importHistory(
  config: InvariantConfig,
  entries: readonly { label: string; spec: string }[],
): Promise<HistoryResult> {
  if (entries.length === 0) {
    throw new HistoryError("name at least one contract, as <label>=<path>");
  }
  const existing = [...config.releasedSpecs.keys()].sort();
  const oldest = existing[0];
  if (oldest === undefined) {
    throw new HistoryError(
      "invariant.yaml releases no contract yet. Run invariant init first, so the " +
        "history has a present to lead to.",
    );
  }
  const added = entries.map((entry) => entry.label);
  // The chain is ordered by label, everywhere, so history has to sort before
  // what is already there, and in the order it was given.
  const sorted = [...added].sort();
  if (added.some((label, index) => label !== sorted[index])) {
    throw new HistoryError(
      `the labels ${added.join(", ")} do not sort in the order given, and contracts ` +
        "are ordered by label. Give them oldest first, named so they sort that way, " +
        "such as the date each was released.",
    );
  }
  for (const label of added) {
    if (config.releasedSpecs.has(label) || label === config.currentLabel) {
      throw new HistoryError(`${label} is already a contract in invariant.yaml`);
    }
    if (label >= oldest) {
      throw new HistoryError(
        `${label} sorts after ${oldest}, the oldest contract already released. ` +
          "History comes before it: name the older contracts so they sort first, " +
          "such as by the date each was released.",
      );
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label)) {
      throw new HistoryError(`${label} is not a label: letters, digits, . _ and -`);
    }
  }
  if (existsSync(join(config.invariantDir, "released", oldest))) {
    throw new HistoryError(
      `invariant/released/${oldest} already exists, so ${oldest} already has a ` +
        "parent. History can only be put in front of a chain that starts there.",
    );
  }

  const contractsDir = join(config.root, "invariant", "contracts");
  const specs = new Map<string, string>();
  const wrote: string[] = [];
  await mkdir(contractsDir, { recursive: true });
  for (const entry of entries) {
    // Loaded the way every check will load it, so a document the gate cannot
    // read is refused now rather than on the next pull request.
    await loadContract(entry.spec, entry.label);
    const path = join(contractsDir, `${entry.label}.openapi.json`);
    await writeFile(path, await standaloneText(entry.spec), "utf8");
    specs.set(entry.label, path);
    wrote.push(path);
  }

  const chain = [...added, oldest];
  const pathOf = (label: string) =>
    specs.get(label) ?? (config.releasedSpecs.get(label) as string);
  const steps: HistoryStep[] = [];
  for (let index = 1; index < chain.length; index += 1) {
    const from = chain[index - 1] as string;
    const to = chain[index] as string;
    const [before, after] = await Promise.all([
      loadContract(pathOf(from), from),
      loadContract(pathOf(to), to),
    ]);
    // Rules only: history is drafted in bulk, often for many steps, and a
    // person reads every draft before the gate accepts it anyway.
    const outcome = await propose(before.document, after.document, {
      judge: new RulesJudge(),
    });
    const drafts = draftFiles({
      proposals: outcome.proposals,
      decisions: outcome.decisions,
      unresolved: outcome.unresolved,
      impasses: outcome.impasses,
      skipped: [],
      written: [],
    });
    const stepDir = join(config.invariantDir, "released", to);
    await mkdir(stepDir, { recursive: true });
    for (const draft of drafts) {
      const path = join(stepDir, `${draft.id}.yaml`);
      await writeFile(path, draft.text, "utf8");
      wrote.push(path);
    }
    const order = join(stepDir, "order.yaml");
    await writeFile(
      order,
      // Quoted, because a label can look exactly like a date.
      stringifyYaml(
        { contract: to, parent: from, changes: drafts.map((draft) => draft.id) },
        { defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN" },
      ),
      "utf8",
    );
    wrote.push(order);
    steps.push({
      from,
      to,
      drafts,
      open: [
        ...outcome.unresolved.map(
          (entry) => `${entry.schema}.${entry.field}: ${entry.reason}`,
        ),
        ...outcome.impasses.map(
          (entry) => `${entry.schema}: a ${entry.kind}. ${entry.why}`,
        ),
      ],
    });
  }

  await recordHistory(
    config.path,
    entries.map((entry) => [
      entry.label,
      relative(config.root, specs.get(entry.label) as string),
    ]),
  );
  return { added, steps, wrote };
}

/** The imported contracts added to `spec.released`, comments and layout kept. */
async function recordHistory(
  configPath: string,
  entries: readonly [string, string][],
): Promise<void> {
  const document = parseDocument(await readFile(configPath, "utf8"));
  const released = document.getIn(["spec", "released"]);
  if (!isMap(released)) throw new HistoryError(`${configPath} has no spec.released`);
  for (const [label, spec] of entries) {
    const key = document.createNode(label) as Scalar;
    key.type = "QUOTE_DOUBLE";
    released.set(key, spec);
  }
  await writeFile(configPath, document.toString(), "utf8");
}

export function renderHistory(result: HistoryResult, root: string): string {
  const lines = [
    `Imported ${result.added.length} earlier ${result.added.length === 1 ? "contract" : "contracts"}: ${result.added.join(", ")}.`,
    "",
  ];
  for (const step of result.steps) {
    const answers = step.drafts.filter((draft) => draft.needsAnswer).length;
    lines.push(
      `${step.from} -> ${step.to}: ${step.drafts.length} drafted ${step.drafts.length === 1 ? "Change" : "Changes"}` +
        (answers > 0
          ? `, ${answers} waiting for an answer (replace every CHOOSE_ONE)`
          : ""),
    );
    for (const draft of step.drafts) lines.push(`  ${draft.id}: ${draft.summary}`);
    for (const open of step.open) lines.push(`  ! ${open}`);
  }
  lines.push(
    "",
    "Wrote:",
    ...result.wrote.map((path) => `  ${relative(root, path)}`),
    "",
    "Read every draft under invariant/released before merging: they are proposals.",
    "Then run invariant check --full with each old version's running deployment as",
    "its source (build.contracts.<label>.url), so the adapter is compared with the",
    "handler it replaces before that handler is deleted.",
  );
  return lines.join("\n");
}
