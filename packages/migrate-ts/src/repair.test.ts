/**
 * Assisted repair, with a stand-in for the model that records what it is
 * sent: the function a site is in, and never anything else of the consumer.
 */
import type { Change } from "@invariant-app/ir";
import { buildPlan } from "@invariant-app/migrate-core";
import { describe, expect, it } from "vitest";
import { migrate, type RepairRequest } from "./index.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;
const CONSUMER = `${ROOT}fixtures/consumer-pinned/`;
const FILE = `${CONSUMER}src/subscriptions.ts`;

const gone: Change = {
  irVersion: 1,
  id: "chg_gone_subscription_discount",
  summary: "`discount` is no longer in `subscription`.",
  scopes: [{ schema: "#/components/schemas/subscription" }],
  ops: [{ op: "remove", path: "/discount", restore: null }],
};

const COUPON_OF = `export async function couponOf(id: string): Promise<string | undefined> {
  const subscription = await pay.subscriptions.retrieve(id);
  return subscription.discount?.coupon;
}`;

function run(answer: (request: RepairRequest) => string | undefined) {
  const sent: RepairRequest[] = [];
  const types = { subscription: "Pay.Subscription" };
  const result = migrate({
    repoDir: CONSUMER,
    generated: [`${CONSUMER}sdk/`],
    sources: [FILE],
    plan: buildPlan([gone], {
      package: "paysdk",
      upgradeTo: { package: "paysdk", version: "2.0.0", types },
      types,
      accessors: [],
    }),
    repair: async (request) => {
      sent.push(request);
      return answer(request);
    },
  });
  return { result, sent };
}

describe("assisted repair", () => {
  it("sends the model the Change, why, and the enclosing function only", async () => {
    const { result, sent } = run(() => undefined);
    await result;
    expect(sent).toEqual([
      {
        change: gone,
        reasons: [
          "`discount` is no longer in the contract, and nothing was declared in its place",
        ],
        file: "src/subscriptions.ts",
        enclosing: COUPON_OF,
      },
    ]);
    // Not the client made at the top of the file, its key, nor the next function.
    expect(JSON.stringify(sent)).not.toMatch(/sk_test|new Pay|renewsAt|import/);
  });

  it("keeps a rewrite that type-checks, labelled as the model's, and takes the site off the list", async () => {
    const rewritten = COUPON_OF.replace(
      "return subscription.discount?.coupon;",
      "return subscription.items[0] ? undefined : undefined;",
    );
    const { result } = run(() => rewritten);
    const done = await result;
    expect(done.manual).toEqual([]);
    expect(done.repairs).toEqual([
      expect.objectContaining({
        file: FILE,
        changeId: "chg_gone_subscription_discount",
        author: "model",
        replacement: rewritten,
      }),
    ]);
    expect(done.files.get(FILE)).toContain(rewritten);
    expect(done.files.get(FILE)).toContain('const pay = new Pay("sk_test");');
  });

  it.each([
    [
      "a rewrite with a new type error",
      COUPON_OF.replace("discount?.coupon", "coupon_code"),
    ],
    [
      "a rewrite that reaches past the function",
      `${COUPON_OF}\nexport const leaked = pay;`,
    ],
    ["a rewrite that is no longer a function", "const couponOf = 1;"],
  ])("throws away %s, and leaves the site with a person", async (_name, answer) => {
    const { result } = run(() => answer);
    const done = await result;
    expect(done.repairs).toEqual([]);
    expect(done.manual).toEqual([
      expect.objectContaining({ file: FILE, line: 7, changeId: gone.id }),
    ]);
    expect(done.files.has(FILE)).toBe(false);
  });

  it("asks no model at all when none is given", async () => {
    const types = { subscription: "Pay.Subscription" };
    const done = await migrate({
      repoDir: CONSUMER,
      generated: [`${CONSUMER}sdk/`],
      sources: [FILE],
      plan: buildPlan([gone], {
        package: "paysdk",
        upgradeTo: { package: "paysdk", version: "2.0.0", types },
        types,
        accessors: [],
      }),
    });
    expect(done.repairs).toEqual([]);
    expect(done.manual).toHaveLength(1);
  });
});
