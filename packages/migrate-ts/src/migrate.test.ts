/**
 * Migrating a real consumer.
 *
 * Consumer A is the hardest of the three: it sits two contracts behind, uses a
 * nested-resource SDK, and reads amounts through literals, computed
 * expressions, spreads and destructuring. Everything asserted here comes from
 * the Changes the provider already confirmed, with no changelog anywhere in the
 * pipeline.
 */
import { loadPendingChanges, loadReleaseStep } from "@invariant-app/contract";
import type { Change } from "@invariant-app/ir";
import { beforeAll, describe, expect, it } from "vitest";
import { migrate } from "./index.ts";
import type { SymbolMap } from "./plan.ts";
import { buildPlan } from "./plan.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;
const FIXTURE = `${ROOT}fixtures/provider-acme/`;
const CONSUMER = `${ROOT}fixtures/consumer-a-sdk-v1/`;
const SDK_DIR = `${ROOT}fixtures/sdk-acme-v1/`;

/**
 * How the SDK generated for contract 2026-01-15 names what the contract
 * describes. A real deployment gets this from the compiler alongside the
 * program; the shape is the same either way.
 */
const SYMBOLS: SymbolMap = {
  package: "@acme/sdk-v1",
  upgradeTo: { package: "@acme/sdk-v3", version: "workspace:*" },
  types: {
    Payment: "Charge",
    PaymentCreateParams: "ChargeCreateParams",
    Refund: "Refund",
    RefundCreateParams: "RefundCreateParams",
    Charge: "Charge",
    ChargeCreateParams: "ChargeCreateParams",
  },
  accessors: [{ from: ["charges"], to: ["payments"] }],
  helpers: { toMinor: "toMinorUnits", fromMinor: "fromMinorUnits" },
};

let changes: Change[];
let migrated: Awaited<ReturnType<typeof migrate>>;
let billing: string;

beforeAll(async () => {
  const released = await loadReleaseStep(`${FIXTURE}invariant`, "2026-03-01");
  const pending = await loadPendingChanges(`${FIXTURE}invariant`);
  changes = [...released.changes, ...pending];

  migrated = await migrate({
    repoDir: CONSUMER,
    generated: [SDK_DIR],
    tsConfigFilePath: `${CONSUMER}tsconfig.json`,
    plan: buildPlan(changes, SYMBOLS),
  });
  billing = migrated.files.get(`${CONSUMER}src/billing.ts`) ?? "";
});

describe("migrating consumer A", () => {
  it("migrates the consumer's tests along with its code", () => {
    // A consumer's own test suite calls the provider too. Leaving it behind
    // would produce a pull request that cannot go green.
    expect(
      [...migrated.files.keys()].map((file) => file.slice(CONSUMER.length)).sort(),
    ).toEqual(["src/billing.test.ts", "src/billing.ts"]);
  });

  it("moves to the package built for the current contract", () => {
    expect(billing).toContain('from "@acme/sdk-v3"');
    expect(billing).not.toContain("@acme/sdk-v1");
  });

  it("renames the resource the endpoints moved to", () => {
    expect(billing).toContain("client.payments.create");
    expect(billing).not.toContain("client.charges");
  });

  it("converts a literal amount exactly, at build time", () => {
    // 12.5 becomes 1250 here rather than at runtime, and never through a float.
    const tests = migrated.files.get(`${CONSUMER}src/billing.test.ts`) ?? "";
    expect(tests).toContain("amount_cents: 1250");
    expect(tests).toContain("fromMinorUnits(charge.amount_cents)");
  });

  it("wraps a computed amount in the SDK's exact conversion", () => {
    expect(billing).toContain("amount_cents: toMinorUnits(prorated)");
    expect(billing).toContain("amount_cents: toMinorUnits(plan.price)");
    expect(billing).toMatch(/import \{[\s\S]*toMinorUnits[\s\S]*\} from "@acme\/sdk-v3"/);
  });

  it("converts an amount back where it is read", () => {
    expect(billing).toContain("fromMinorUnits(charge.amount_cents)");
  });

  it("keeps a destructured local meaning what it always meant", () => {
    // Renaming the binding alone would leave `amount` holding cents while every
    // use of it still means dollars, so the conversion is bound once.
    expect(billing).toContain("const { amount_cents, status } = charge;");
    expect(billing).toContain("const amount = fromMinorUnits(amount_cents);");
  });

  it("updates a value whose vocabulary changed", () => {
    expect(billing).toContain('status === "paid"');
    expect(billing).not.toContain('"succeeded"');
  });

  it("nests the token the way the contract now expects", () => {
    expect(billing).toContain("payment_method: { token: source }");
  });

  it("supplies the default a newly explicit field always had", () => {
    expect(billing).toContain('capture_method: "automatic"');
  });

  it("renames the types the consumer named", () => {
    expect(billing).toContain("Payment");
    expect(billing).not.toMatch(/\bCharge\b/);
  });

  it("introduces no new type errors", () => {
    const added = migrated.diagnosticsAfter.filter(
      (diagnostic) => !migrated.diagnosticsBefore.includes(diagnostic),
    );
    expect(added).toEqual([]);
  });

  it("carries provenance on every edit", () => {
    expect(migrated.edits.length).toBeGreaterThan(10);
    for (const edit of migrated.edits) {
      expect(edit.changeId).not.toBe("");
      expect(edit.reason).not.toBe("");
      // Nothing here was written by a model.
      expect(edit.author).toBe("codemod");
    }
    const ids = new Set(migrated.edits.map((edit) => edit.changeId));
    expect(ids).toContain("chg_money_in_minor_units");
    expect(ids).toContain("chg_source_became_payment_method");
    expect(ids).toContain("chg_capture_method");
  });

  it("reports anything it would not rewrite rather than skipping it", () => {
    for (const site of migrated.manual) {
      expect(site.file).not.toBe("");
      expect(site.line).toBeGreaterThan(0);
      expect(site.reason).not.toBe("");
    }
  });
});

describe("scope", () => {
  it("never edits a file outside the repository it was given", () => {
    // The type checker loads the whole import graph, which here reaches the
    // provider's own source. Editing anything out there would be damage, not
    // migration, so the boundary is asserted rather than assumed.
    for (const file of migrated.files.keys()) {
      expect(file.startsWith(CONSUMER)).toBe(true);
      expect(file.startsWith(SDK_DIR)).toBe(false);
    }
    for (const edit of migrated.edits) {
      expect(edit.file.startsWith(CONSUMER)).toBe(true);
    }
  });

  it("reports assembled text it will not guess at", () => {
    // A status baked into a template string has no type saying what it means,
    // so it is flagged with an exact location instead of being rewritten.
    const template = migrated.manual.find((site) => site.reason.includes("succeeded"));
    expect(template).toBeDefined();
    expect(template?.file.endsWith("billing.test.ts")).toBe(true);
    expect(template?.line).toBeGreaterThan(0);
  });
});
