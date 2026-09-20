/**
 * The demo, as an executable test.
 *
 * Step 1 (this phase): the three consumers pass against the contract each was
 * written for, and break against the provider's new canonical API. Later phases
 * add step 2 (they survive the release unmodified, through the adapter) and
 * step 3 (their source migrates forward).
 */
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
