/**
 * A field the contract dropped with nothing in its place: Stripe's
 * `subscription.discount`, gone in favour of a list the provider never
 * declared as its successor. There is nothing to rewrite it to, so every
 * place the consumer reads it is shown to a person, and nothing is edited.
 */
import type { Change } from "@invariant-app/ir";
import { buildPlan } from "@invariant-app/migrate-core";
import { describe, expect, it } from "vitest";
import { migrate } from "./index.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;
const CONSUMER = `${ROOT}fixtures/consumer-pinned/`;

const gone: Change = {
  irVersion: 1,
  id: "chg_gone_subscription_discount",
  summary: "`discount` is no longer in `subscription`.",
  scopes: [{ schema: "#/components/schemas/subscription" }],
  ops: [{ op: "remove", path: "/discount", restore: null }],
};

describe("a field the contract dropped", () => {
  it("is shown to a person wherever it is read, and nothing is edited", async () => {
    const types = { subscription: "Pay.Subscription" };
    const result = await migrate({
      repoDir: CONSUMER,
      generated: [`${CONSUMER}sdk/`],
      sources: [`${CONSUMER}src/subscriptions.ts`],
      plan: buildPlan([gone], {
        package: "paysdk",
        upgradeTo: { package: "paysdk", version: "2.0.0", types },
        types,
        accessors: [],
      }),
    });
    expect(result.edits).toEqual([]);
    expect(result.manual).toEqual([
      expect.objectContaining({
        file: `${CONSUMER}src/subscriptions.ts`,
        line: 7,
        changeId: "chg_gone_subscription_discount",
        reason:
          "`discount` is no longer in the contract, and nothing was declared in its place",
      }),
    ]);
  });

  it("is not guessed into a stand-in for a response when a field is gained", async () => {
    // Drafted for a schema only ever sent: its value is null because none is
    // ever sent, not because null is right for the consumer's fixture.
    const gained: Change = {
      irVersion: 1,
      id: "chg_subscription_billing_mode_added",
      summary: "`billing_mode` is new.",
      scopes: [{ schema: "#/components/schemas/subscription" }],
      ops: [{ op: "add", path: "/billing_mode", value: null }],
    };
    const types = { subscription: "Pay.Subscription" };
    const result = await migrate({
      repoDir: CONSUMER,
      generated: [`${CONSUMER}sdk/`],
      sources: [`${CONSUMER}src/fakes.ts`],
      plan: buildPlan([gained], {
        package: "paysdk",
        upgradeTo: { package: "paysdk", version: "2.0.0", types },
        types,
        accessors: [],
      }),
    });
    expect(result.edits).toEqual([]);
    expect(result.manual).toEqual([
      expect.objectContaining({
        file: `${CONSUMER}src/fakes.ts`,
        line: 4,
        reason:
          "this object stands for a response that now has `billing_mode`; add the value it should hold",
      }),
    ]);
  });

  it("is shown by name where nothing types it, and never where something does", async () => {
    const types = { subscription: "Pay.Subscription" };
    const result = await migrate({
      repoDir: CONSUMER,
      generated: [`${CONSUMER}sdk/`],
      sources: [`${CONSUMER}src/stubs.ts`],
      plan: buildPlan([gone], {
        package: "paysdk",
        upgradeTo: { package: "paysdk", version: "2.0.0", types },
        types,
        accessors: [],
      }),
    });
    expect(result.edits).toEqual([]);
    // The mock's stand-in and both reads of the payload; the consumer's own
    // row, typed as something else, is not the contract's field.
    expect(result.manual.map((site) => `${site.line} ${site.snippet}`)).toEqual([
      '5 discount: { coupon: "HALF" }',
      "11 payload.discount",
      '11 payload["discount"]',
    ]);
    expect(result.manual[0]?.reason).toBe(
      "nothing types this `discount`, so it is shown rather than rewritten; if it is the contract's field, `discount` is no longer in the contract, and nothing was declared in its place",
    );
  });

  it("is shown in a file that never imports the SDK where the types say the stand-in is handed to it", async () => {
    const types = { subscription: "Pay.Subscription" };
    const result = await migrate({
      repoDir: CONSUMER,
      generated: [`${CONSUMER}sdk/`],
      sources: [`${CONSUMER}src/handler-spec.ts`],
      plan: buildPlan([gone], {
        package: "paysdk",
        upgradeTo: { package: "paysdk", version: "2.0.0", types },
        types,
        accessors: [],
      }),
    });
    expect(result.edits).toEqual([]);
    expect(result.manual.map((site) => `${site.line} ${site.snippet}`)).toEqual([
      '6 discount: { coupon: "HALF" }',
    ]);
    expect(result.manual[0]?.reason).toMatch(
      /^nothing types this `discount`.*; this object is passed where the SDK's `.*Subscription` is expected$/,
    );
  });

  const nested = (change: Change, file: string) => {
    const types = { subscription: "Pay.Subscription" };
    return migrate({
      repoDir: CONSUMER,
      generated: [`${CONSUMER}sdk/`],
      sources: [`${CONSUMER}src/${file}`],
      plan: buildPlan([change], {
        package: "paysdk",
        upgradeTo: { package: "paysdk", version: "2.0.0", types },
        types,
        accessors: [],
      }),
    });
  };

  it("is found inside the type, in the object that holds it (Stripe's automatic_tax.liability)", async () => {
    const result = await nested(
      {
        irVersion: 1,
        id: "chg_subscription_automatic_tax_liability_added",
        summary: "`automatic_tax.liability` is new.",
        scopes: [{ schema: "#/components/schemas/subscription" }],
        ops: [{ op: "add", path: "/automatic_tax/liability", value: null }],
      },
      "fakes.ts",
    );
    expect(result.manual).toEqual([
      expect.objectContaining({
        line: 7,
        reason:
          "this object stands for a response that now has `liability`; add the value it should hold",
      }),
    ]);
  });

  it("is found inside a list's items, where it is read", async () => {
    const result = await nested(
      {
        irVersion: 1,
        id: "chg_gone_subscription_items_current_period_end",
        summary: "`items.*.current_period_end` is no longer in `subscription`.",
        scopes: [{ schema: "#/components/schemas/subscription" }],
        ops: [{ op: "remove", path: "/items/*/current_period_end", restore: null }],
      },
      "subscriptions.ts",
    );
    expect(result.manual).toEqual([
      expect.objectContaining({
        line: 12,
        reason:
          "`items.*.current_period_end` is no longer in the contract, and nothing was declared in its place",
      }),
    ]);
  });
});
