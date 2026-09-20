/**
 * Deciding when a contract can stop being served.
 *
 * The dangerous direction is retiring something someone still needs, so most of
 * these are about refusing to. A compatibility layer that never ends is a cost;
 * one that ends too early is an outage.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";
import { assessRetirement, renderRetirement, retireContracts } from "./retire.ts";
import { aggregate, hashConsumer, type UsageRecord } from "./usage.ts";

const FIXTURE = new URL("../../../fixtures/provider-acme/", import.meta.url).pathname;
const NOW = 1_800_000_000;
const DAY = 86_400;

let scratch: string | undefined;

afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

async function copyProvider(): Promise<string> {
  scratch = await mkdtemp(join(tmpdir(), "invariant-retire-"));
  for (const entry of ["invariant.yaml", "invariant", "openapi"]) {
    await cp(join(FIXTURE, entry), join(scratch, entry), { recursive: true });
  }
  return scratch;
}

/** A provider serving three contracts, so chain order can be exercised. */
async function threeContracts() {
  const config = await loadConfig(`${FIXTURE}invariant.yaml`);
  config.releasedSpecs.set("2026-06-01", `${FIXTURE}openapi/head.json`);
  return config;
}

function seen(contract: string, daysAgo: number, consumer = "acct_alpha"): UsageRecord {
  return {
    consumer: hashConsumer(consumer),
    contract,
    changeId: "chg_money_in_minor_units",
    count: 12,
    lastSeen: NOW - daysAgo * DAY,
  };
}

describe("deciding what can be retired", () => {
  it("keeps a contract that is still carrying traffic", async () => {
    const config = await loadConfig(`${FIXTURE}invariant.yaml`);
    const report = assessRetirement(config, [seen("2026-01-15", 2)], { now: NOW });

    expect(report.retirable).toEqual([]);
    expect(report.contracts[0]?.verdict).toBe("active");
    expect(report.contracts[0]?.reason).toContain("1 consumer still served");
  });

  it("reports one nobody has used for longer than the window", async () => {
    const config = await loadConfig(`${FIXTURE}invariant.yaml`);
    const report = assessRetirement(
      config,
      [seen("2026-01-15", 95), seen("2026-03-01", 1, "acct_bravo")],
      { now: NOW },
    );

    expect(report.retirable).toEqual(["2026-01-15"]);
    expect(report.contracts[0]?.quietDays).toBe(95);
  });

  /**
   * The failure that would hurt most, kept separate from idleness.
   *
   * No records at all is far more likely to mean the counters never reached
   * this tool than that every consumer left. Retiring on that basis would
   * break exactly the integrations the product exists to protect.
   */
  it("refuses to treat silence as absence when nothing was ever recorded", async () => {
    const config = await loadConfig(`${FIXTURE}invariant.yaml`);
    const report = assessRetirement(config, [], { now: NOW });

    expect(report.retirable).toEqual([]);
    expect(report.contracts[0]?.verdict).toBe("never-seen");
    expect(report.contracts[0]?.reason).toContain("usage sink");
    expect(renderRetirement(report)).toContain("Nothing to retire");
  });

  /**
   * Contracts form a chain, and a program for an old one is built by walking
   * every step from it to current. Removing a step from the middle would break
   * the chain for everything older than it.
   *
   * Three contracts are needed to show it, because the newest served one is
   * never a candidate and the fixture only serves two.
   */
  it("will not retire a contract while an older one is still in use", async () => {
    const config = await threeContracts();
    const report = assessRetirement(
      config,
      [seen("2026-01-15", 1), seen("2026-03-01", 200, "acct_bravo")],
      { now: NOW },
    );

    // The middle one has been quiet for two hundred days and still cannot go
    // first, because the oldest is carrying traffic that routes through it.
    expect(report.contracts[1]?.verdict).toBe("idle");
    expect(report.retirable).toEqual([]);
  });

  it("retires a run of quiet contracts in order, stopping at the first in use", async () => {
    const config = await threeContracts();
    const report = assessRetirement(
      config,
      [seen("2026-01-15", 300), seen("2026-03-01", 200, "acct_bravo")],
      { now: NOW },
    );

    expect(report.retirable).toEqual(["2026-01-15", "2026-03-01"]);
  });

  it("never retires the contract a caller who says nothing is served", async () => {
    const config = await loadConfig(`${FIXTURE}invariant.yaml`);
    const report = assessRetirement(config, [seen("2026-01-15", 400)], { now: NOW });

    const current = report.contracts.find((entry) => entry.contract === report.current);
    expect(current?.verdict).toBe("active");
    expect(report.retirable).not.toContain(report.current);
  });

  it("counts every consumer and keeps the most recent sighting", () => {
    const folded = aggregate([
      seen("2026-01-15", 10, "acct_alpha"),
      seen("2026-01-15", 2, "acct_alpha"),
      seen("2026-01-15", 5, "acct_bravo"),
    ]);

    expect(folded).toHaveLength(2);
    const alpha = folded.find((row) => row.consumer === hashConsumer("acct_alpha"));
    expect(alpha?.count).toBe(24);
    expect(alpha?.lastSeen).toBe(NOW - 2 * DAY);
  });

  it("records a hash of the consumer's key and never the key", () => {
    const record = seen("2026-01-15", 1, "sk_test_alpha");
    expect(record.consumer).not.toContain("sk_test");
    expect(record.consumer).toBe(hashConsumer("sk_test_alpha"));
  });
});

describe("writing the retirement", () => {
  /**
   * The fixture's oldest contract is also its identity default, which is the
   * ordinary arrangement: the fallback is whatever the oldest supported caller
   * speaks. Removing it from the served list without moving the default first
   * points every caller who declares nothing at a contract that is no longer
   * there.
   */
  it("refuses to retire the contract the identity default still names", async () => {
    const root = await copyProvider();
    await expect(
      retireContracts(join(root, "invariant.yaml"), ["2026-01-15"]),
    ).rejects.toThrow(/caller who declares nothing/);

    // And nothing was written, so the provider is not left half way.
    const config = await loadConfig(join(root, "invariant.yaml"));
    expect([...config.releasedSpecs.keys()]).toEqual(["2026-01-15", "2026-03-01"]);
  });

  it("removes only the retired contract and leaves the comments alone", async () => {
    const root = await copyProvider();
    const path = join(root, "invariant.yaml");
    // Move the default forward first, which is what the refusal above asks for.
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace(
        /(kind: default\n\s*label: )"2026-01-15"/,
        '$1"2026-03-01"',
      ),
      "utf8",
    );
    const before = await readFile(path, "utf8");

    const { removed } = await retireContracts(path, ["2026-01-15"]);
    const after = await readFile(path, "utf8");

    expect(removed).toEqual(["2026-01-15"]);
    expect(after).not.toContain("2026-01-15");
    expect(after).toContain("2026-03-01");

    // A provider's configuration has their comments in it. A tool that
    // reformats the file to change one line produces a diff nobody reviews.
    for (const line of before
      .split("\n")
      .filter((entry) => entry.trim().startsWith("#"))) {
      expect(after).toContain(line);
    }

    // And the file still loads, with one fewer contract served.
    const config = await loadConfig(path);
    expect([...config.releasedSpecs.keys()]).toEqual(["2026-03-01"]);
  });

  it("says so rather than silently doing nothing when the label is not there", async () => {
    const root = await copyProvider();
    await expect(
      retireContracts(join(root, "invariant.yaml"), ["2025-01-01"]),
    ).rejects.toThrow(/do not appear|none of/);
  });
});
