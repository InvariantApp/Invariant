/**
 * The properties at the depth the design actually asked for.
 *
 * The ordinary suite runs the laws at five hundred generated values per schema,
 * which is enough for fast feedback while something is being written. The
 * success criteria ask for ten thousand per Change, and it turns out that costs
 * about a second and a half, so there was never a reason to be running less.
 *
 * Kept separate because the two are asking different questions. The suite asks
 * "did I just break something"; this asks "does the property hold", and the
 * answer to the second is the one that goes in a release.
 */
import { join } from "node:path";
import { type ContractStep, predictDocument } from "@invariant/compiler";
import { loadContract, loadPendingChanges, loadReleaseStep } from "@invariant/contract";
import { checkChainEquivalence, checkLaws } from "@invariant/verifier";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./harness.ts";

const PROVIDER = join(REPO_ROOT, "fixtures/provider-acme");
const INVARIANT = join(PROVIDER, "invariant");

/** The design's number, met rather than approximated. */
const RUNS = 10_000;

async function steps(): Promise<ContractStep[]> {
  const v1 = await loadContract(join(PROVIDER, "openapi/2026-01-15.json"), "2026-01-15");
  const v2 = await loadContract(join(PROVIDER, "openapi/2026-03-01.json"), "2026-03-01");
  const head = await loadContract(join(PROVIDER, "openapi/head.json"), "2026-09-20");

  return [
    {
      label: "2026-03-01",
      parent: "2026-01-15",
      from: v1.document,
      to: v2.document,
      changes: (await loadReleaseStep(INVARIANT, "2026-03-01")).changes,
    },
    {
      label: "2026-09-20",
      parent: "2026-03-01",
      from: v2.document,
      to: head.document,
      changes: await loadPendingChanges(INVARIANT),
    },
  ];
}

describe("the properties, at ten thousand cases", () => {
  it("holds the lens laws on every step", async () => {
    for (const step of await steps()) {
      const predicted = predictDocument(step.from, step.to, step.changes);
      expect(predicted.issues).toEqual([]);

      const report = checkLaws(step.from, predicted.document, step.changes, {
        runs: RUNS,
        seed: 20_260_920,
      });

      expect(report.failures, `${step.parent} -> ${step.label} broke a law`).toEqual([]);
      expect(report.evidence.every((entry) => entry.result === "pass")).toBe(true);
    }
  });

  it("holds chain equivalence on every historical contract", async () => {
    const report = checkChainEquivalence(await steps(), {
      runs: RUNS,
      seed: 20_260_920,
    });

    expect(report.failures).toEqual([]);
    expect(report.evidence).toHaveLength(2);
  });

  /**
   * A different seed asks a different question: whether the properties hold,
   * or whether one particular sequence of generated values happens to miss the
   * case that breaks them.
   */
  it("holds under a seed nothing was tuned against", async () => {
    const [, pending] = await steps();
    if (!pending) throw new Error("the fixture has no pending step");

    const predicted = predictDocument(pending.from, pending.to, pending.changes);
    const report = checkLaws(pending.from, predicted.document, pending.changes, {
      runs: RUNS,
      seed: 987_654_321,
    });

    expect(report.failures).toEqual([]);
  });
});
