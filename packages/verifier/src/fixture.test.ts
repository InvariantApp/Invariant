/**
 * The laws, run against the Changes that actually ship.
 *
 * The unit tests above build small contracts to isolate one fault each. This
 * one takes the provider fixture exactly as it stands, both contract steps, and
 * insists the real declarations hold on generated traffic. If a Change in the
 * fixture ever stops satisfying its own laws, this fails before the demo does.
 */
import { join } from "node:path";
import { predictDocument } from "@invariant/compiler";
import { loadContract, loadPendingChanges, loadReleaseStep } from "@invariant/contract";
import { describe, expect, it } from "vitest";
import { checkLaws } from "./laws.ts";

const FIXTURE = join(import.meta.dirname, "../../../fixtures/provider-acme");
const INVARIANT = join(FIXTURE, "invariant");

async function spec(label: string): Promise<Awaited<ReturnType<typeof loadContract>>> {
  return loadContract(join(FIXTURE, "openapi", `${label}.json`), label);
}

describe("the provider fixture", () => {
  it("satisfies the lens laws on the released step", async () => {
    const from = await spec("2026-01-15");
    const to = await spec("2026-03-01");
    const { changes } = await loadReleaseStep(INVARIANT, "2026-03-01");

    const predicted = predictDocument(from.document, to.document, changes);
    expect(predicted.issues).toEqual([]);

    const report = checkLaws(from.document, predicted.document, changes, {
      runs: 400,
      seed: 1,
    });

    expect(report.failures).toEqual([]);
    expect(report.evidence.every((entry) => entry.result === "pass")).toBe(true);
    expect(report.evidence.length).toBeGreaterThan(0);
  });

  it("satisfies the lens laws on the pending step", async () => {
    const from = await spec("2026-03-01");
    const to = await spec("head");
    const changes = await loadPendingChanges(INVARIANT);

    const predicted = predictDocument(from.document, to.document, changes);
    expect(predicted.issues).toEqual([]);

    const report = checkLaws(from.document, predicted.document, changes, {
      runs: 400,
      seed: 1,
    });

    expect(report.failures).toEqual([]);
    expect(report.evidence.every((entry) => entry.result === "pass")).toBe(true);
  });
});
