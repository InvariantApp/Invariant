import type { OpenApiDocument } from "@invariant-app/contract";
import type { Change } from "@invariant-app/ir";
import type { Decision } from "@invariant-app/proposer";
import { describe, expect, it } from "vitest";
import { decidedRemovals, wireTags } from "./stripe.mts";

const tagged = (tag: string) => ({
  type: "object",
  properties: { object: { type: "string", enum: [tag] }, id: { type: "string" } },
});

const document = (version: string, schemas: Record<string, unknown>) =>
  ({
    openapi: "3.0.0",
    info: { title: "Stripe API", version },
    paths: {},
    components: { schemas },
  }) as unknown as OpenApiDocument;

describe("Stripe's tags", () => {
  it("names each schema by the tag its objects carry, and the version the newer one describes", () => {
    const before = document("2025-02-24.acacia", {
      // A deleted invoice carries the invoice's tag; the tag names the invoice.
      deleted_invoice: tagged("invoice"),
      invoice: tagged("invoice"),
      line_item: tagged("line_item"),
      event: tagged("event"),
      // A tag two schemas carry and neither is named after names neither.
      a_thing: tagged("thing"),
      another_thing: tagged("thing"),
      untagged: { type: "object", properties: { id: { type: "string" } } },
    });
    const after = document("2025-04-30.basil", {
      invoice: tagged("invoice"),
      invoice_payment: tagged("invoice_payment"),
    });
    expect(wireTags(before, after)).toEqual({
      property: "object",
      schemas: {
        invoice: "invoice",
        line_item: "line_item",
        event: "event",
        invoice_payment: "invoice_payment",
      },
      version: {
        schema: "event",
        property: "api_version",
        from: "2025-02-24.acacia",
        label: "2025-04-30.basil",
      },
    });
  });

  it("counts a field a response lost as gone, though what old callers get instead is a decision", () => {
    const decision = (field: string, op: "add" | "remove"): Decision => ({
      kind: "value",
      id: `chg_subscription_${field}_${op}`,
      schema: "subscription",
      field,
      pointer: `/${field}`,
      op: { op },
      shape: { name: field, pointer: `/${field}`, required: true } as never,
      summary: `\`${field}\` was removed from subscription.`,
      why: "Nothing in the new contract replaces it.",
    });
    const drafted: Change = {
      irVersion: 1,
      id: "chg_gone_subscription_discount",
      summary: "gone",
      scopes: [{ schema: "#/components/schemas/subscription" }],
      ops: [{ op: "remove", path: "/discount", restore: null }],
    };
    expect(
      decidedRemovals(
        [
          decision("current_period_end", "remove"),
          // Already drafted: not twice.
          decision("discount", "remove"),
          // A field gained is no loss.
          decision("billing_mode", "add"),
        ],
        [drafted],
      ),
    ).toEqual([
      {
        irVersion: 1,
        id: "chg_subscription_current_period_end_remove",
        summary:
          "`current_period_end` was removed from subscription. Nothing in the new contract replaces it.",
        scopes: [{ schema: "#/components/schemas/subscription" }],
        ops: [{ op: "remove", path: "/current_period_end", restore: null }],
      },
    ]);
  });
});
