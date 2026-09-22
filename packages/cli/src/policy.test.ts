/**
 * The two gate settings a provider controls, at each of their levels.
 *
 * They were parsed and never read, so a provider who wrote `block` got `warn`.
 * Each case here is a setting doing what its name says.
 */
import type { Change } from "@invariant-app/ir";
import { describe, expect, it } from "vitest";
import type { GateLevel, InvariantConfig } from "./config.ts";
import { applyGatePolicy } from "./policy.ts";
import type { UsageRecord } from "./usage.ts";

const NOW = 1_760_000_000;
const DAY = 86_400;

function config(declaredLossy: GateLevel, unmigratable: GateLevel): InvariantConfig {
  return {
    root: "/",
    api: "acme",
    currentSpec: "/head.json",
    currentLabel: "2026-09-20",
    releasedSpecs: new Map([["2026-03-01", "/2026-03-01.json"]]),
    invariantDir: "/invariant",
    contractHeader: undefined,
    build: undefined,
    gate: { declaredLossy, unmigratableWithActiveConsumers: unmigratable },
  } as InvariantConfig;
}

const lossy = (acknowledged: boolean): Change => ({
  irVersion: 1,
  id: "chg_capture_method",
  summary: "Capture method became explicit.",
  scopes: [{ schema: "#/components/schemas/PaymentCreateParams" }],
  ops: [{ op: "add", path: "/capture_method", value: "automatic" }],
  assertions: {
    side_effects_unchanged: true,
    ...(acknowledged ? { loss_acknowledged: true } : {}),
  },
});

const retire: Change = {
  irVersion: 1,
  id: "chg_refunds_retired",
  summary: "Refunds are issued from the dashboard.",
  ops: [{ op: "retire", endpoint: { method: "post", path: "/v1/refunds" } }],
  assertions: { side_effects_unchanged: true },
};

const seen = (daysAgo: number): UsageRecord[] => [
  {
    consumer: "c1",
    contract: "2026-03-01",
    changeId: "chg_x",
    count: 3,
    lastSeen: NOW - daysAgo * DAY,
  },
];

const pending = (change: Change) => [{ changes: [change], pending: true }];

describe("gate.declaredLossy", () => {
  it("blocks an unacknowledged lossy Change when set to block", () => {
    const outcome = applyGatePolicy(
      config("block", "block"),
      pending(lossy(false)),
      [],
      NOW,
    );
    expect(outcome.blocks.join("\n")).toContain("chg_capture_method");
  });

  it("warns when set to warn", () => {
    const outcome = applyGatePolicy(
      config("warn", "block"),
      pending(lossy(false)),
      [],
      NOW,
    );
    expect(outcome.blocks).toEqual([]);
    expect(outcome.warnings.join("\n")).toContain("loss_acknowledged");
  });

  it("says nothing when set to allow", () => {
    const outcome = applyGatePolicy(
      config("allow", "block"),
      pending(lossy(false)),
      [],
      NOW,
    );
    expect(outcome).toEqual({ blocks: [], warnings: [] });
  });

  it("is satisfied by an acknowledgement at any level", () => {
    const outcome = applyGatePolicy(
      config("block", "block"),
      pending(lossy(true)),
      [],
      NOW,
    );
    expect(outcome).toEqual({ blocks: [], warnings: [] });
  });

  it("never blocks over a step that was already released", () => {
    const outcome = applyGatePolicy(
      config("block", "block"),
      [{ changes: [lossy(false)], pending: false }],
      [],
      NOW,
    );
    expect(outcome.blocks).toEqual([]);
    expect(outcome.warnings).toHaveLength(1);
  });
});

describe("gate.unmigratableWithActiveConsumers", () => {
  it("blocks a retirement while an old contract is still in use", () => {
    const outcome = applyGatePolicy(
      config("warn", "block"),
      pending(retire),
      seen(2),
      NOW,
    );
    expect(outcome.blocks.join("\n")).toContain("2026-03-01");
  });

  it("does not block once the old contract has been quiet for the window", () => {
    const outcome = applyGatePolicy(
      config("warn", "block"),
      pending(retire),
      seen(45),
      NOW,
    );
    expect(outcome.blocks).toEqual([]);
  });

  it("warns instead when set to warn", () => {
    const outcome = applyGatePolicy(
      config("warn", "warn"),
      pending(retire),
      seen(2),
      NOW,
    );
    expect(outcome.blocks).toEqual([]);
    expect(outcome.warnings.join("\n")).toContain("been used in the last 30 days");
  });

  it("does not treat a missing ledger as proof nobody is left", () => {
    const outcome = applyGatePolicy(
      config("warn", "block"),
      pending(retire),
      undefined,
      NOW,
    );
    expect(outcome.blocks).toEqual([]);
    expect(outcome.warnings.join("\n")).toContain("no usage ledger");
  });

  it("leaves behaviour changes to the provider code that serves them", () => {
    const behavior: Change = {
      irVersion: 1,
      id: "chg_capture_timing",
      summary: "Capture happens later.",
      ops: [{ op: "behavior", flag: "late_capture" }],
      assertions: { side_effects_unchanged: false },
    };
    const outcome = applyGatePolicy(
      config("warn", "block"),
      pending(behavior),
      seen(1),
      NOW,
    );
    expect(outcome.blocks).toEqual([]);
  });
});
