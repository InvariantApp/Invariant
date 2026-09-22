/**
 * The demo, as an executable test.
 *
 * Step 1: the three consumers pass against the contract each was written for,
 * and break against the provider's new canonical API.
 * Step 2: with the compiled program in the provider's build, the same three
 * consumers pass against that same new API, unmodified.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACME_PROGRAM } from "@fixtures/provider-acme";
import {
  appendLedger,
  assessRetirement,
  hashConsumer,
  loadConfig,
  readLedger,
  renderRetirement,
} from "@invariant-app/cli";
import type { UsageEvent } from "@invariant-app/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ConsumerId,
  REPO_ROOT,
  type RunningProvider,
  runConsumerSuite,
  runMigratedSuite,
  startProvider,
} from "./harness.ts";
import { migrateConsumerA, migrateConsumerB, migrateConsumerC } from "./migrate.ts";

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

  /**
   * Consumer B holds generated types rather than an SDK.
   *
   * Nothing in the engine differs between the two: the symbol map says the
   * schemas live under `components.schemas` instead of being exported by name,
   * and that is the entire adaptation. If migrating a second client style had
   * needed a second engine, the claim that the type checker does the work
   * would be false.
   */
  it("migrates consumer B, whose schemas are nested inside generated types", async () => {
    const result = await migrateConsumerB();

    expect(result.changedFiles).toContain("src/checkout.ts");
    expect(result.changedFiles).toContain("src/checkout.test.ts");
    // Its types are regenerated from the new contract rather than a package
    // being bumped, because that is what a types-only dependency is.
    expect(result.changedFiles).toContain("src/acme-types.ts");
    // And the exact conversion helpers are written in, because there is no SDK
    // for them to arrive in and inlining the arithmetic would put a rounding
    // bug in every price.
    expect(result.changedFiles).toContain("src/invariant-units.ts");
  });

  it("rewrites consumer B's money without ever inlining the arithmetic", async () => {
    const result = await migrateConsumerB();
    const source = await readFile(join(result.dir, "src/checkout.ts"), "utf8");

    // A literal is resolved exactly at build time: 199.0 is 19900, with no
    // call left behind and no multiplication to get wrong.
    expect(source).toContain("amount_cents: 19900");
    // An expression cannot be, so it goes through the helper.
    expect(source).toContain("amount_cents: toMinorUnits(invoiceTotal(items))");
    expect(source).toContain("fromMinorUnits(payment.amount_cents)");
    expect(source).toContain('status === "paid"');
    expect(source).toContain('capture_method: "automatic"');
    // No site the migration wrote does the arithmetic itself. The consumer's
    // own invoice maths is left exactly as it was: the engine rewrites what
    // the contract describes and nothing else.
    for (const line of source
      .split("\n")
      .filter((entry) => entry.includes("amount_cents"))) {
      expect(line).not.toMatch(/[*/]\s*10{2,}/);
    }
    expect(source).toContain("Math.round(item.unitPrice * 100)");
  });

  it("points consumer B at the exact lines it would not rewrite", async () => {
    const result = await migrateConsumerB();
    expect(result.manual).toHaveLength(2);

    const text = await readFile(join(result.dir, "src/checkout.test.ts"), "utf8");
    const lines = text.split("\n");

    // The reported line has to be the line in the file the reviewer opens,
    // which is not the line it was on before the edits moved it.
    const optional = result.manual.find((site) => site.reason.includes("optional chain"));
    expect(lines[(optional?.line ?? 0) - 1]).toContain("fetched?.amount");

    const literal = result.manual.find((site) => site.reason.includes("succeeded"));
    expect(lines[(literal?.line ?? 0) - 1]).toContain("succeeded");
  });

  /**
   * Consumer C calls the API over raw fetch, with no SDK and no generated
   * types. The type checker has nothing to say about any of it, so every
   * rewrite is a name match inside a request to a URL that looked right.
   *
   * It happens to get all of them correct, and that is precisely why every one
   * is still reported: a run that is right by luck and a run that is right by
   * construction look identical from the outside, and only one of them is
   * safe to merge without reading.
   */
  it("migrates consumer C, and flags every untyped rewrite it made", async () => {
    const result = await migrateConsumerC();

    expect(result.changedFiles).toContain("src/donations.ts");
    expect(result.changedFiles).toContain("src/invariant-units.ts");

    // Every edit has a report beside it. Nothing about an untyped call site is
    // proven, so nothing about it is applied quietly.
    expect(result.manual.length).toBeGreaterThan(5);
    expect(
      result.manual.every((site) =>
        /untyped|nothing proves|did not come from this codebase|not from this codebase/.test(
          site.reason,
        ),
      ),
    ).toBe(true);
  });

  it("keeps consumer C's rewrites inside the operation they belong to", async () => {
    const result = await migrateConsumerC();
    const source = await readFile(join(result.dir, "src/donations.ts"), "utf8");

    // The payment gains the field the contract now requires.
    expect(source).toContain('capture_method: "automatic"');
    // The refund does not, because the Change was never scoped to it. A URL
    // match on its own would have put it in both.
    expect(source).toContain("body: JSON.stringify({ payment: id })");

    expect(source).toContain("amount_cents: toMinorUnits(amount)");
    expect(source).toContain('fromMinorUnits(payload["amount_cents"] as number)');
    expect(source).toContain('payload["status"] === "paid"');
    // And the caller now declares the contract it actually speaks.
    expect(source).not.toContain('"acme-version": "2026-03-01"');
  });

  it("passes against the new canonical API with no adapter at all", async () => {
    const migrated = await migrateConsumerC();
    provider = await startProvider({ build: "head" });

    const result = await runMigratedSuite(`${migrated.dir}/src`, {
      ACME_BASE_URL: provider.baseUrl,
      ACME_API_KEY: "sk_test_delta",
    });

    expect(result.ran, result.output).toBe(true);
    expect(result.passed, result.output).toBe(true);
    expect(result.succeeded).toBeGreaterThan(0);
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

/**
 * Step 4: the compatibility layer ends.
 *
 * Every version-adapter built in production has the same problem, which is
 * that it never stops growing: nobody can prove a consumer stopped needing a
 * transform, so every old contract is served forever and each breaking change
 * is paid for again on every release after it.
 *
 * The counters are what make an ending possible, and this is the whole loop in
 * one test: real traffic from a consumer on the oldest contract, through the
 * adapter, into a ledger, and out as a recommendation that only becomes true
 * once that consumer has gone.
 */
describe("step 4: the old contract is retired", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "invariant-retire-"));
    for (const entry of ["invariant.yaml", "invariant", "openapi"]) {
      await cp(join(REPO_ROOT, "fixtures/provider-acme", entry), join(root, entry), {
        recursive: true,
      });
    }
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function recordRealTraffic(): Promise<{ ledger: string; now: number }> {
    const ledger = join(root, "usage.jsonl");
    const now = Math.floor(Date.now() / 1000);
    const events: UsageEvent[] = [];

    provider = await startProvider({
      build: "head",
      program: ACME_PROGRAM,
      onUsage: (event) => events.push(event),
    });

    // A consumer still written against the oldest contract, using the shapes
    // that contract described.
    const created = await fetch(`${provider.baseUrl}/v1/charges`, {
      method: "POST",
      headers: {
        authorization: "Bearer sk_test_alpha",
        "content-type": "application/json",
      },
      body: JSON.stringify({ amount: 49.99, currency: "usd", source: "tok_visa" }),
    });
    expect(created.status).toBe(201);

    await appendLedger(
      ledger,
      events.flatMap((event) =>
        [...event.changes].map(([changeId, count]) => ({
          consumer: hashConsumer(event.consumer ?? "unknown"),
          contract: event.contract,
          changeId,
          count,
          lastSeen: now,
        })),
      ),
    );

    expect(events.length).toBeGreaterThan(0);
    return { ledger, now };
  }

  it("will not retire a contract while someone is still being served by it", async () => {
    const { ledger, now } = await recordRealTraffic();
    const config = await loadConfig(join(root, "invariant.yaml"));

    const report = assessRetirement(config, await readLedger(ledger), { now });

    expect(report.retirable).toEqual([]);
    expect(report.contracts[0]?.verdict).toBe("active");
    expect(report.contracts[0]?.reason).toContain("still served");
  });

  it("recommends retirement once the last consumer has been gone long enough", async () => {
    const { ledger, now } = await recordRealTraffic();
    const config = await loadConfig(join(root, "invariant.yaml"));

    // The same evidence, read ninety days later. Nothing about the provider
    // changed; the only thing that moved is how long the silence has lasted.
    const report = assessRetirement(config, await readLedger(ledger), {
      now: now + 90 * 86_400,
    });

    expect(report.retirable).toEqual(["2026-01-15"]);
    expect(renderRetirement(report)).toContain("Safe to stop serving: 2026-01-15");
  });

  it("refuses to read a missing ledger as an empty one", async () => {
    const config = await loadConfig(join(root, "invariant.yaml"));

    // No counters at all is not evidence that nobody is there, and treating it
    // as such would retire a contract and break every caller on it.
    const report = assessRetirement(
      config,
      await readLedger(join(root, "nothing.jsonl")),
      {},
    );

    expect(report.retirable).toEqual([]);
    expect(report.contracts[0]?.verdict).toBe("never-seen");
  });
});
