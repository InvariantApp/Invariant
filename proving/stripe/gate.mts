/**
 * The gate, as a provider runs it on one pair of Stripe's documents. Apart
 * from the harness so it can be tried on small documents, where the whole of
 * rig B cannot.
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type CheckReport, check, loadConfig, runPropose } from "@invariant-app/cli";
import { derive, missingAcknowledgement } from "@invariant-app/compiler";
import { syntheticAnswer } from "@invariant-app/eval";
import type { Change } from "@invariant-app/ir";
import { ROOT } from "../corpus/manifest.mts";
import type { Commit, StripeGate } from "./summary.ts";

const RECORDED = join(ROOT, "proving/stripe/changes");

/**
 * The provider's repository for the pair, and the gate's verdict on it.
 *
 * The auto-provider answers every decision the drafts leave open and
 * acknowledges every loss the compiler derives, as a provider would have to
 * before the gate lets the release through. Every answer it makes is labelled
 * synthetic in its id, and none of it leaves `proving/`.
 */
export async function gateFor(
  from: Commit,
  to: Commit,
  documents: { from: string; to: string },
  work: string,
): Promise<{ report: CheckReport; gate: StripeGate }> {
  const root = join(work, "provider");
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, "invariant", "changes"), { recursive: true });
  await mkdir(join(root, "specs"), { recursive: true });
  await copyFile(documents.from, join(root, "specs", "old.json"));
  await copyFile(documents.to, join(root, "specs", "new.json"));
  await writeFile(
    join(root, "invariant.yaml"),
    [
      "api: stripe",
      "spec:",
      "  current: specs/new.json",
      `  currentLabel: "${to.label}"`,
      "  released:",
      `    "${from.label}": specs/old.json`,
      "identity:",
      "  - kind: header",
      "    name: Stripe-Version",
      "  - kind: default",
      `    label: "${from.label}"`,
      "",
    ].join("\n"),
    "utf8",
  );
  const recorded = join(RECORDED, `${from.commit.slice(0, 7)}..${to.commit.slice(0, 7)}`);
  let drafted = 0;
  let decided = 0;
  if (existsSync(recorded)) {
    for (const name of await readdir(recorded)) {
      if (!/\.ya?ml$/.test(name)) continue;
      await copyFile(join(recorded, name), join(root, "invariant", "changes", name));
    }
  } else {
    const config = await loadConfig(join(root, "invariant.yaml"));
    const proposed = await runPropose(config, { offline: true });
    const changes: Change[] = [
      ...proposed.proposals.map((proposal) => proposal.change),
      ...proposed.decisions.map(syntheticAnswer),
    ];
    drafted = proposed.proposals.length;
    decided = proposed.decisions.length;
    for (const change of changes) {
      const acknowledged: Change = missingAcknowledgement(change, derive(change))
        ? { ...change, assertions: { ...change.assertions, loss_acknowledged: true } }
        : change;
      // JSON is YAML, and the loader reads either.
      await writeFile(
        join(root, "invariant", "changes", `${change.id}.yaml`),
        `${JSON.stringify(acknowledged, null, 2)}\n`,
        "utf8",
      );
    }
  }
  const report = await check(await loadConfig(join(root, "invariant.yaml")));
  const pending = report.steps.at(-1);
  return {
    report,
    gate: {
      result: report.result,
      drafted,
      decided,
      unexplained: pending?.unexplained ?? [],
      unservable: [
        ...(pending?.issues ?? []),
        ...(pending?.stale ?? []),
        ...report.unservable,
        ...report.problems,
        ...report.policy,
      ],
    },
  };
}

/**
 * Run on its own, the gate reads its inputs from one file and writes its
 * verdict and program to another. The rig runs it this way, in a process of
 * its own, because on some pairs of Stripe-sized documents the gate needs
 * more memory than the machine has, and a process that runs out takes
 * everything in it down: the pair is then recorded as blocked, with the
 * reason, beside the arms that did run.
 *
 *   node --import tsx proving/stripe/gate.mts <input.json> <output.json>
 */
if (process.argv[1]?.endsWith("gate.mts")) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error("usage: gate.mts <input.json> <output.json>");
  const { from, to, documents, work } = JSON.parse(await readFile(input, "utf8")) as {
    from: Commit;
    to: Commit;
    documents: { from: string; to: string };
    work: string;
  };
  const { report, gate } = await gateFor(from, to, documents, work);
  await writeFile(
    output,
    JSON.stringify({ gate, program: report.program ?? null }),
    "utf8",
  );
}
