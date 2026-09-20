/**
 * Chain equivalence against the fixture's real contract history.
 *
 * A consumer on the oldest contract is two steps behind, which is the smallest
 * chain where the order of composition can actually be wrong. Getting responses
 * backwards here is a mistake that was made once already during the build and
 * would not have shown up on a one-step chain at all.
 */
import { join } from "node:path";
import type { ContractStep } from "@invariant/compiler";
import { loadContract, loadPendingChanges, loadReleaseStep } from "@invariant/contract";
import { describe, expect, it } from "vitest";
import { checkChainEquivalence } from "./equivalence.ts";

const FIXTURE = join(import.meta.dirname, "../../../fixtures/provider-acme");

async function steps(): Promise<ContractStep[]> {
  const v1 = await loadContract(join(FIXTURE, "openapi/2026-01-15.json"), "2026-01-15");
  const v2 = await loadContract(join(FIXTURE, "openapi/2026-03-01.json"), "2026-03-01");
  const head = await loadContract(join(FIXTURE, "openapi/head.json"), "head");
  const invariant = join(FIXTURE, "invariant");

  return [
    {
      label: "2026-03-01",
      parent: "2026-01-15",
      from: v1.document,
      to: v2.document,
      changes: (await loadReleaseStep(invariant, "2026-03-01")).changes,
    },
    {
      label: "head",
      parent: "2026-03-01",
      from: v2.document,
      to: head.document,
      changes: await loadPendingChanges(invariant),
    },
  ];
}

describe("chain equivalence", () => {
  it("one pass equals applying each step in turn", async () => {
    const report = checkChainEquivalence(await steps(), { runs: 200, seed: 3 });

    expect(report.failures).toEqual([]);
    // One record per historical contract still served, two contracts back.
    expect(report.evidence.map((entry) => entry.subject)).toEqual([
      "2026-01-15",
      "2026-03-01",
    ]);
    expect(report.evidence.every((entry) => entry.result === "pass")).toBe(true);
  });

  it("notices when a step's work goes missing from the chain", async () => {
    const original = await steps();
    // Drop the money Change from the last step only. The per-step path still
    // knows about it through the first step, so the two ways of getting there
    // now disagree, which is exactly what this check is for.
    const damaged: ContractStep[] = [
      original[0] as ContractStep,
      {
        ...(original[1] as ContractStep),
        changes: (original[1] as ContractStep).changes.filter(
          (change) => change.id !== "chg_money_in_minor_units",
        ),
      },
    ];

    const intact = checkChainEquivalence(original, { runs: 200, seed: 3 });
    const broken = checkChainEquivalence(damaged, { runs: 200, seed: 3 });

    // The point is that removing real work changes the answer. If both were
    // clean the check would be proving nothing.
    expect(intact.failures).toEqual([]);
    expect(JSON.stringify(broken)).not.toEqual(JSON.stringify(intact));
  });
});
