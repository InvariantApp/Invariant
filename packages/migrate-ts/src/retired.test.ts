/**
 * Calls to an operation the provider retired: Stripe's GET
 * /v1/invoices/upcoming, which stripe-node calls as
 * `invoices.retrieveUpcoming`.
 */
import type { Change } from "@invariant-app/ir";
import { describe, expect, it } from "vitest";
import { migrate } from "./index.ts";
import { buildPlan } from "./plan.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;
const CONSUMER = `${ROOT}fixtures/consumer-pinned/`;

const retired: Change = {
  irVersion: 1,
  id: "chg_retired_get_v1_invoices_upcoming",
  summary: "GET /v1/invoices/upcoming is gone.",
  ops: [
    {
      op: "retire",
      endpoint: { method: "get", path: "/v1/invoices/upcoming" },
      guidance: "preview it with POST /v1/invoices/create_preview",
    },
  ],
};

describe("an operation the provider retired", () => {
  it("is shown to a person at every call, with the provider's guidance, and nothing else is", async () => {
    const result = await migrate({
      repoDir: CONSUMER,
      generated: [`${CONSUMER}sdk/`],
      sources: [`${CONSUMER}src/invoices.ts`],
      plan: buildPlan([retired], {
        package: "paysdk",
        upgradeTo: { package: "paysdk", version: "2.0.0" },
        types: {},
        accessors: [],
        operations: {
          "get /v1/invoices/upcoming": {
            type: "Pay.InvoicesResource",
            method: "retrieveUpcoming",
          },
        },
      }),
    });
    expect(result.edits).toEqual([]);
    expect(result.manual).toEqual([
      expect.objectContaining({
        file: `${CONSUMER}src/invoices.ts`,
        line: 6,
        changeId: "chg_retired_get_v1_invoices_upcoming",
        reason:
          "`retrieveUpcoming` calls GET /v1/invoices/upcoming, which the provider retired; preview it with POST /v1/invoices/create_preview",
      }),
    ]);
  });
});
