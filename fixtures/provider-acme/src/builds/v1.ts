/**
 * Acme payments API as it existed at contract 2026-01-15.
 *
 * Wire shape: charges, `amount` in major currency units, a flat `source`
 * token, and the original status vocabulary.
 */
import { Hono } from "hono";
import type { AcmeStore, Payment, PaymentStatus, Refund } from "../store.ts";
import {
  invalidRequest,
  MINOR_UNIT_EXPONENT,
  notFound,
  readJsonBody,
  readLimit,
  SUPPORTED_CURRENCIES,
  toMajor,
  toMinor,
} from "../support.ts";

const WIRE_STATUS: Record<PaymentStatus, string> = {
  paid: "succeeded",
  failed: "failed",
  processing: "pending",
};

function charge(payment: Payment): Record<string, unknown> {
  return {
    id: payment.id,
    object: "charge",
    amount: toMajor(payment.amountMinor),
    currency: payment.currency,
    source: payment.paymentMethodToken,
    status: WIRE_STATUS[payment.status],
    description: payment.description,
    created: payment.created,
  };
}

function refund(value: Refund): Record<string, unknown> {
  return {
    id: value.id,
    object: "refund",
    charge: value.paymentId,
    amount: toMajor(value.amountMinor),
    status: value.status,
    created: value.created,
  };
}

export function buildV1(store: AcmeStore): Hono {
  const app = new Hono();

  app.post("/v1/charges", async (c) => {
    const body = await readJsonBody(c);
    if (!body) return invalidRequest(c, "Request body must be a JSON object.");

    const amount = body["amount"];
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
      return invalidRequest(c, "A positive `amount` is required.", "amount");
    }
    const scaled = amount * 10 ** MINOR_UNIT_EXPONENT;
    if (!Number.isInteger(Math.round(scaled * 1000) / 1000)) {
      return invalidRequest(
        c,
        `\`amount\` supports at most ${MINOR_UNIT_EXPONENT} decimal places.`,
        "amount",
      );
    }

    const currency = body["currency"];
    if (
      typeof currency !== "string" ||
      !(SUPPORTED_CURRENCIES as readonly string[]).includes(currency.toLowerCase())
    ) {
      return invalidRequest(
        c,
        `\`currency\` must be one of ${SUPPORTED_CURRENCIES.join(", ")}.`,
        "currency",
      );
    }

    const source = body["source"];
    if (typeof source !== "string" || source.length === 0) {
      return invalidRequest(c, "A `source` token is required.", "source");
    }

    const description = body["description"];
    if (
      description !== undefined &&
      description !== null &&
      typeof description !== "string"
    ) {
      return invalidRequest(c, "`description` must be a string.", "description");
    }

    const created = store.createPayment({
      amountMinor: toMinor(amount),
      currency,
      paymentMethodToken: source,
      captureMethod: "automatic",
      description: (description as string | null | undefined) ?? null,
    });
    return c.json(charge(created), 201);
  });

  app.get("/v1/charges/:id", (c) => {
    const found = store.getPayment(c.req.param("id"));
    if (!found) return notFound(c, "No such charge.");
    return c.json(charge(found), 200);
  });

  app.get("/v1/charges", (c) => {
    const { data, hasMore } = store.listPayments(readLimit(c.req.query("limit")));
    return c.json({ object: "list", data: data.map(charge), has_more: hasMore }, 200);
  });

  app.post("/v1/refunds", async (c) => {
    const body = await readJsonBody(c);
    if (!body) return invalidRequest(c, "Request body must be a JSON object.");

    const chargeId = body["charge"];
    if (typeof chargeId !== "string" || chargeId.length === 0) {
      return invalidRequest(c, "A `charge` id is required.", "charge");
    }
    const amount = body["amount"];
    if (amount !== undefined && (typeof amount !== "number" || amount <= 0)) {
      return invalidRequest(c, "`amount` must be a positive number.", "amount");
    }

    const result = store.createRefund({
      paymentId: chargeId,
      ...(amount === undefined ? {} : { amountMinor: toMinor(amount) }),
    });
    if ("error" in result) return notFound(c, "No such charge.");
    return c.json(refund(result), 201);
  });

  return app;
}
