/**
 * Acme payments API as it existed at contract 2026-03-01.
 *
 * Changes from 2026-01-15: charges became payments (path and `object` value),
 * the flat `source` token moved under `payment_method`, and refunds refer to a
 * `payment` rather than a `charge`. Money is still in major units.
 */
import { Hono } from "hono";
import type { AcmeStore, Payment, PaymentStatus, Refund } from "../store.ts";
import {
  invalidRequest,
  isPlainObject,
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

function payment(value: Payment): Record<string, unknown> {
  return {
    id: value.id,
    object: "payment",
    amount: toMajor(value.amountMinor),
    currency: value.currency,
    payment_method: { token: value.paymentMethodToken },
    status: WIRE_STATUS[value.status],
    description: value.description,
    created: value.created,
  };
}

function refund(value: Refund): Record<string, unknown> {
  return {
    id: value.id,
    object: "refund",
    payment: value.paymentId,
    amount: toMajor(value.amountMinor),
    status: value.status,
    created: value.created,
  };
}

export function buildV2(store: AcmeStore): Hono {
  const app = new Hono();

  app.post("/v1/payments", async (c) => {
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

    const method = body["payment_method"];
    const token = isPlainObject(method) ? method["token"] : undefined;
    if (typeof token !== "string" || token.length === 0) {
      return invalidRequest(
        c,
        "A `payment_method.token` is required.",
        "payment_method.token",
      );
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
      paymentMethodToken: token,
      captureMethod: "automatic",
      description: (description as string | null | undefined) ?? null,
    });
    return c.json(payment(created), 201);
  });

  app.get("/v1/payments/:id", (c) => {
    const found = store.getPayment(c.req.param("id"));
    if (!found) return notFound(c, "No such payment.");
    return c.json(payment(found), 200);
  });

  app.get("/v1/payments", (c) => {
    const { data, hasMore } = store.listPayments(readLimit(c.req.query("limit")));
    return c.json({ object: "list", data: data.map(payment), has_more: hasMore }, 200);
  });

  app.post("/v1/refunds", async (c) => {
    const body = await readJsonBody(c);
    if (!body) return invalidRequest(c, "Request body must be a JSON object.");

    const paymentId = body["payment"];
    if (typeof paymentId !== "string" || paymentId.length === 0) {
      return invalidRequest(c, "A `payment` id is required.", "payment");
    }
    const amount = body["amount"];
    if (amount !== undefined && (typeof amount !== "number" || amount <= 0)) {
      return invalidRequest(c, "`amount` must be a positive number.", "amount");
    }

    const result = store.createRefund({
      paymentId,
      ...(amount === undefined ? {} : { amountMinor: toMinor(amount) }),
    });
    if ("error" in result) return notFound(c, "No such payment.");
    return c.json(refund(result), 201);
  });

  return app;
}
