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
import type { OpenApiDocument } from "@invariant/contract";
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

  const scenarios: Scenario[] = await loadScenarios(
    join(config.invariantDir, "scenarios"),
  );
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
  evidence.push(...differential.evidence);
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
