/**
 * The demo, as an executable test.
 *
 * Step 1: the three consumers pass against the contract each was written for,
 * and break against the provider's new canonical API.
 * Step 2: with the compiled program in the provider's build, the same three
 * consumers pass against that same new API, unmodified.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ACME_PROGRAM } from "@fixtures/provider-acme";
import type { UsageEvent } from "@invariant/runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ConsumerId,
  type RunningProvider,
  runConsumerSuite,
  runMigratedSuite,
  startProvider,
} from "./harness.ts";
import { migrateConsumerA } from "./migrate.ts";

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

describe("step 3: the connected codebase moves forward", () => {
  it("migrates consumer A from two contracts back, with no new type errors", async () => {
    const result = await migrateConsumerA();
    expect(result.newDiagnostics).toEqual([]);
    expect(result.changedFiles).toEqual(["src/billing.test.ts", "src/billing.ts"]);
  });

  it("says exactly what it would not rewrite, rather than guessing", async () => {
    const result = await migrateConsumerA();
    // One site: a status baked into an assembled string, where no type says
    // what the text means. Everything else followed from the Changes.
    expect(result.manual).toHaveLength(1);
    expect(result.manual[0]?.file).toBe("src/billing.test.ts");
    expect(result.manual[0]?.reason).toContain("succeeded");
  });

  it("passes against the new canonical API except at the site it flagged", async () => {
    const migrated = await migrateConsumerA();
    // No program at all: the provider serves only its current contract here.
    // The migrated consumer speaks it directly, which is the point.
    provider = await startProvider({ build: "head" });

    const result = await runMigratedSuite(`${migrated.dir}/src`, {
      ACME_BASE_URL: provider.baseUrl,
      ACME_API_KEY: "sk_test_delta",
    });
    expect(result.ran, result.output).toBe(true);
    expect(result.succeeded).toBeGreaterThan(0);
    // The engine claimed one site it could not do. Exactly one test fails, and
    // a claim that matches the outcome is the thing worth proving here.
    expect(result.failed).toBe(migrated.manual.length);
  });

  it("goes green once the flagged site is dealt with", async () => {
    const migrated = await migrateConsumerA();
    // Standing in for the developer acting on the report the PR carries.
    const flagged = join(migrated.dir, migrated.manual[0]?.file ?? "");
    await writeFile(
      flagged,
      (await readFile(flagged, "utf8")).replace("succeeded", "paid"),
      "utf8",
    );

    provider = await startProvider({ build: "head" });
    const result = await runMigratedSuite(`${migrated.dir}/src`, {
      ACME_BASE_URL: provider.baseUrl,
      ACME_API_KEY: "sk_test_delta",
    });
    expect(result.passed, result.output).toBe(true);
  });

  it("no longer needs the old contract once it has migrated", async () => {
    const migrated = await migrateConsumerA();
    const flagged = join(migrated.dir, migrated.manual[0]?.file ?? "");
    await writeFile(
      flagged,
      (await readFile(flagged, "utf8")).replace("succeeded", "paid"),
      "utf8",
    );

    const usage: UsageEvent[] = [];
    provider = await startProvider({
      build: "head",
      program: ACME_PROGRAM,
      onUsage: (event) => usage.push(event),
    });

    const result = await runMigratedSuite(`${migrated.dir}/src`, {
      ACME_BASE_URL: provider.baseUrl,
      ACME_API_KEY: "sk_test_delta",
    });
    expect(result.passed, result.output).toBe(true);
    // The adapter is still deployed and this consumer no longer touches it.
    // That zero is what eventually retires the old contract.
    expect(usage).toEqual([]);
  });
});
