/**
 * The verification layers, run in the order that fails cheapest first.
 *
 * Closure needs two documents. The laws need a generator and an interpreter.
 * The differential needs two running builds, which costs seconds rather than
 * milliseconds, so it runs last and only when the provider has said how to
 * start one. A release that is already blocked does not pay for it.
 *
 * Every layer produces evidence records rather than a boolean, because what a
 * reviewer needs to know is not whether it passed but what was actually
 * checked. "The model was confident" has no record to live in.
 */

import { join } from "node:path";
import { type ContractStep, predictDocument } from "@invariant/compiler";
import { loadContract, type OpenApiDocument } from "@invariant/contract";
import {
  CURRENT_CONTRACT_ALIAS,
  checkChainEquivalence,
  checkConformance,
  checkDifferential,
  checkLaws,
  type Evidence,
  isCurrent,
  loadScenarios,
  type Scenario,
  scenariosFromDocument,
} from "@invariant/verifier";
import type { InvariantConfig } from "./config.ts";
import { launchBuild } from "./launch.ts";

export interface VerifyOptions {
  /** Start real builds and compare them. Off by default because it costs time. */
  full?: boolean;
  /** Generated values per property. */
  runs?: number;
  /**
   * Ledger of what the deployed runtime reported, for E9.
   *
   * Absent, the gate says nothing about production rather than implying it
   * looked and found nothing wrong.
   */
  outcomes?: string;
  /**
   * The usage ledger the gate weighs unservable Changes against. Defaults to
   * `invariant/usage.jsonl` when that file exists.
   */
  usage?: string;
}

export interface VerifyReport {
  evidence: Evidence[];
  /** One line per problem, ready to print. */
  problems: string[];
  /** Differences the provider named and justified, kept visible. */
  acknowledged: string[];
}

export async function verify(
  config: InvariantConfig,
  steps: readonly ContractStep[],
  currentLabel: string,
  currentDocument: OpenApiDocument,
  options: VerifyOptions = {},
): Promise<VerifyReport> {
  const evidence: Evidence[] = [];
  const problems: string[] = [];
  const acknowledged: string[] = [];

  // E3 and E4. Each step's Changes have to hold on values of their own schemas.
  for (const step of steps) {
    const predicted = predictDocument(step.from, step.to, step.changes);
    const report = checkLaws(step.from, predicted.document, step.changes, {
      ...(options.runs === undefined ? {} : { runs: options.runs }),
    });
    evidence.push(...report.evidence);
    for (const failure of report.failures) {
      problems.push(
        `${step.parent} -> ${step.label}: ${failure.changeId} broke its ${failure.law} ` +
          `on ${JSON.stringify(failure.counterexample)} - ${failure.detail}`,
      );
    }
  }

  // E5. One pass has to mean the same thing as the steps it was folded from.
  if (steps.length > 1) {
    const report = checkChainEquivalence(steps, {
      ...(options.runs === undefined ? {} : { runs: options.runs }),
    });
    evidence.push(...report.evidence);
    for (const failure of report.failures) {
      problems.push(
        `${failure.contract}: chaining disagrees with stepping at ${failure.site} - ${failure.detail}`,
      );
    }
  }

  if (!options.full) return { evidence, problems, acknowledged };

  if (!config.build) {
    // Saying nothing here would let a report look complete when two of its
    // layers never ran.
    evidence.push({
      kind: "E6-differential",
      subject: currentLabel,
      result: "skipped",
      inputsDigest: "sha256:0",
      tool: "invariant verify",
      summary:
        "invariant.yaml has no build section, so no build could be started and " +
        "nothing was compared. Only the specifications were checked.",
    });
    return { evidence, problems, acknowledged };
  }

  const written: Scenario[] = await loadScenarios(join(config.invariantDir, "scenarios"));
  // A released contract nobody wrote scenarios for is asked what its own
  // document says it serves, so a stranger's first `check --full` compares
  // something rather than nothing.
  const generated: Scenario[] = [];
  const leftOut: string[] = [];
  if (config.scenarios.generate !== "never") {
    for (const [label, specPath] of config.releasedSpecs) {
      const covered = written.some((scenario) => scenario.contract === label);
      if (covered && config.scenarios.generate === "missing") continue;
      const document = (await loadContract(specPath, label)).document;
      const made = scenariosFromDocument(document, label, {
        headers: config.scenarios.headers,
      });
      generated.push(...made.scenarios);
      leftOut.push(...made.skipped.map((reason) => `${label} ${reason}`));
    }
  }
  const scenarios = [...written, ...generated];
  if (scenarios.length === 0) {
    evidence.push({
      kind: "E6-differential",
      subject: currentLabel,
      result: "skipped",
      inputsDigest: "sha256:0",
      tool: "invariant verify",
      summary:
        "no scenarios in invariant/scenarios, so there was nothing to ask either build",
    });
    return { evidence, problems, acknowledged };
  }

  const build = config.build;
  const launch = (label: string) => launchBuild(label, { build, cwd: config.root });

  // E6. The old build and the new build plus adapter, asked the same things.
  const differential = await checkDifferential(scenarios, {
    launch,
    currentLabel,
    knownContracts: [
      ...config.releasedSpecs.keys(),
      CURRENT_CONTRACT_ALIAS,
      currentLabel,
    ],
    // Straight to stderr, so it shows up live in a CI log without ending up
    // inside a report that is meant to be pasted into a pull request.
    onProgress: (message) => process.stderr.write(`  ${message}\n`),
    ...(config.contractHeader ? { contractHeader: config.contractHeader } : {}),
  });
  // Where each historical build came from, so a reader of the evidence knows
  // what was compared: a running environment shares state between the two
  // runs that calibrate volatility, which a fresh build does not.
  const sources = [...build.contracts].map(([label, source]) =>
    source.kind === "url"
      ? `${label} at ${source.url}, a running environment whose state both runs shared`
      : source.kind === "image"
        ? `${label} from image ${source.image}`
        : `${label} from ${source.ref}`,
  );
  // And what was asked that nobody wrote, and what could not be asked.
  const notes = [
    ...(sources.length > 0 ? [`Historical builds: ${sources.join("; ")}.`] : []),
    ...(generated.length > 0
      ? [
          `${generated.length} scenarios were made from the released documents` +
            (leftOut.length > 0
              ? `; left out: ${leftOut.slice(0, 5).join("; ")}${leftOut.length > 5 ? `; and ${leftOut.length - 5} more` : ""}.`
              : "."),
        ]
      : []),
  ];
  evidence.push(
    ...differential.evidence.map((record) =>
      record.kind === "E6-differential" && notes.length > 0
        ? { ...record, summary: `${record.summary} ${notes.join(" ")}` }
        : record,
    ),
  );
  for (const difference of differential.differences) {
    problems.push(
      `${difference.scenario} / ${difference.step} ${difference.pointer}: ${difference.detail}`,
    );
  }
  for (const entry of differential.acknowledged) {
    acknowledged.push(
      `${entry.scenario} / ${entry.step} ${entry.pointer}: ${entry.detail} (${entry.acknowledged})`,
    );
  }

  // E7. The running code against its own specification, which is what every
  // other layer has been trusting.
  const current = scenarios.filter((scenario) =>
    isCurrent(scenario.contract, currentLabel),
  );
  if (current.length > 0) {
    const conformance = await checkConformance(
      currentDocument,
      currentLabel,
      current,
      () => launch("head"),
    );
    evidence.push(...conformance.evidence);
    for (const failure of conformance.failures) {
      problems.push(
        `${failure.scenario} / ${failure.step}: the ${failure.status} from ` +
          `${failure.operation} does not match the contract - ` +
          failure.violations
            .slice(0, 3)
            .map((violation) => `${violation.pointer} ${violation.message}`)
            .join("; "),
      );
    }
    for (const unknown of conformance.unknownOperations) {
      problems.push(`${unknown} is not an operation in the current contract`);
    }
  }

  return { evidence, problems, acknowledged };
}
