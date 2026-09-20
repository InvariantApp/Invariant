/**
 * Acme payments API at HEAD, the canonical current contract.
 *
 * Changes from 2026-03-01, all structurally breaking:
 *  - `amount` (major units, decimal) became `amount_cents` (minor units, integer)
 *  - the status vocabulary became paid / failed / processing
 *  - `capture_method` became a required request field and a response field
 */
import { Hono } from "hono";
import type { AcmeStore, CaptureMethod, Payment, Refund } from "../store.ts";
import {
  invalidRequest,
  isPlainObject,
  notFound,
  readJsonBody,
  readLimit,
  SUPPORTED_CURRENCIES,
} from "../support.ts";

const CAPTURE_METHODS: readonly CaptureMethod[] = ["automatic", "manual"];

function payment(value: Payment): Record<string, unknown> {
  return {
    id: value.id,
    object: "payment",
    amount_cents: value.amountMinor,
    currency: value.currency,
    payment_method: { token: value.paymentMethodToken },
    capture_method: value.captureMethod,
    status: value.status,
    description: value.description,
    created: value.created,
  };
}

function refund(value: Refund): Record<string, unknown> {
  return {
    id: value.id,
    object: "refund",
    payment: value.paymentId,
    amount_cents: value.amountMinor,
    status: value.status,
    created: value.created,
  };
}

export function buildHead(store: AcmeStore): Hono {
  const app = new Hono();

  app.post("/v1/payments", async (c) => {
    const body = await readJsonBody(c);
    if (!body) return invalidRequest(c, "Request body must be a JSON object.");

    const amountCents = body["amount_cents"];
    if (
      typeof amountCents !== "number" ||
      !Number.isSafeInteger(amountCents) ||
      amountCents <= 0
    ) {
      return invalidRequest(
        c,
        "A positive integer `amount_cents` is required.",
        "amount_cents",
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

    const captureMethod = body["capture_method"];
    if (
      typeof captureMethod !== "string" ||
      !(CAPTURE_METHODS as readonly string[]).includes(captureMethod)
    ) {
      return invalidRequest(
        c,
        `\`capture_method\` must be one of ${CAPTURE_METHODS.join(", ")}.`,
        "capture_method",
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
      amountMinor: amountCents,
      currency,
      paymentMethodToken: token,
      captureMethod: captureMethod as CaptureMethod,
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
    const amountCents = body["amount_cents"];
    if (
      amountCents !== undefined &&
      (typeof amountCents !== "number" ||
        !Number.isSafeInteger(amountCents) ||
        amountCents <= 0)
    ) {
      return invalidRequest(
        c,
        "`amount_cents` must be a positive integer.",
        "amount_cents",
      );
    }

    const result = store.createRefund({
      paymentId,
      ...(amountCents === undefined ? {} : { amountMinor: amountCents }),
    });
    if ("error" in result) return notFound(c, "No such payment.");
    return c.json(refund(result), 201);
  });

  return app;
}
