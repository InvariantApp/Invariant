/**
 * The demo, as an executable test.
 *
 * Step 1: the three consumers pass against the contract each was written for,
 * and break against the provider's new canonical API.
 * Step 2: with the compiled program in the provider's build, the same three
 * consumers pass against that same new API, unmodified.
 */
import { ACME_PROGRAM } from "@fixtures/provider-acme";
import type { UsageEvent } from "@invariant/runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ConsumerId,
  type RunningProvider,
  runConsumerSuite,
  startProvider,
} from "./harness.ts";

const OWN_CONTRACT: Record<ConsumerId, "2026-01-15" | "2026-03-01"> = {
  a: "2026-01-15",
  b: "2026-03-01",
  c: "2026-03-01",
};

let provider: RunningProvider | undefined;

afterEach(async () => {
  await provider?.close();
  provider = undefined;
});

describe("step 1: the break is real", () => {
  for (const consumer of ["a", "b", "c"] as const) {
    it(`consumer ${consumer} passes against contract ${OWN_CONTRACT[consumer]}`, async () => {
      provider = await startProvider({ build: OWN_CONTRACT[consumer] });
      const result = await runConsumerSuite(consumer, {
        ACME_BASE_URL: provider.baseUrl,
      });
      expect(result.ran, result.output).toBe(true);
      expect(result.succeeded).toBeGreaterThan(0);
      expect(result.passed, result.output).toBe(true);
    });
  }

  for (const consumer of ["a", "b", "c"] as const) {
    it(`consumer ${consumer} breaks against the new canonical API`, async () => {
      provider = await startProvider({ build: "head" });
      const result = await runConsumerSuite(consumer, {
        ACME_BASE_URL: provider.baseUrl,
      });
      // The suite has to really run and really fail. A runner that cannot even
      // start would otherwise look like a broken integration.
      expect(result.ran, result.output).toBe(true);
      expect(
        result.failed,
        "expected the unmigrated consumer to fail against head",
      ).toBeGreaterThan(0);
    });
  }
});

describe("step 2: the release ships and nothing breaks", () => {
  for (const consumer of ["a", "b", "c"] as const) {
    it(`consumer ${consumer} passes against head, unmodified`, async () => {
      provider = await startProvider({ build: "head", program: ACME_PROGRAM });
      const result = await runConsumerSuite(consumer, {
        ACME_BASE_URL: provider.baseUrl,
      });
      expect(result.ran, result.output).toBe(true);
      expect(result.succeeded).toBeGreaterThan(0);
      expect(result.passed, result.output).toBe(true);
    });
  }

  it("serves all three contracts at once from one canonical API", async () => {
    const usage: UsageEvent[] = [];
    provider = await startProvider({
      build: "head",
      program: ACME_PROGRAM,
      onUsage: (event) => usage.push(event),
    });

    const results = await Promise.all(
      (["a", "b", "c"] as const).map((consumer) =>
        runConsumerSuite(consumer, { ACME_BASE_URL: provider?.baseUrl ?? "" }),
      ),
    );
    for (const result of results) {
      expect(result.passed, `${result.consumer}\n${result.output}`).toBe(true);
    }

    // Both historical contracts were exercised, and the counters say which
    // Changes each one still depends on.
    expect(new Set(usage.map((event) => event.contract))).toEqual(
      new Set(["2026-01-15", "2026-03-01"]),
    );
    const changes = new Set(usage.flatMap((event) => [...event.changes.keys()]));
    expect(changes.has("chg_money_in_minor_units")).toBe(true);
    expect(changes.has("chg_charges_became_payments")).toBe(true);
  });
});
