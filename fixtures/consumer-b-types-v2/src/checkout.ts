/**
 * Consumer B: invoice checkout built against Acme contract 2026-03-01 using
 * openapi-typescript types and openapi-fetch. Field names reach the wire as
 * typed object-literal properties, which is what makes the call sites
 * resolvable from the schema.
 */
import createClient, { type Client } from "openapi-fetch";
import type { components, paths } from "./acme-types.ts";

export type Payment = components["schemas"]["Payment"];
export type PaymentCreateParams = components["schemas"]["PaymentCreateParams"];
export type Refund = components["schemas"]["Refund"];
export type AcmeClient = Client<paths>;

export interface AcmeOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

export function createAcmeClient(options: AcmeOptions): AcmeClient {
  return createClient<paths>({
    baseUrl: options.baseUrl,
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      "acme-version": "2026-03-01",
    },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

export class CheckoutError extends Error {
  readonly status: number;
  readonly param: string | undefined;

  constructor(status: number, message: string, param?: string) {
    super(message);
    this.name = "CheckoutError";
    this.status = status;
    this.param = param;
  }
}

export interface LineItem {
  sku: string;
  /** Unit price in major currency units. */
  unitPrice: number;
  quantity: number;
}

export function invoiceTotal(items: LineItem[]): number {
  const cents = items.reduce(
    (sum, item) => sum + Math.round(item.unitPrice * 100) * item.quantity,
    0,
  );
  return cents / 100;
}

export async function payInvoice(
  client: AcmeClient,
  items: LineItem[],
  token: string,
): Promise<Payment> {
  const { data, error, response } = await client.POST("/v1/payments", {
    body: {
      amount: invoiceTotal(items),
      currency: "usd",
      payment_method: { token },
      description: `Invoice for ${items.length} line items`,
    },
  });
  if (error) {
    throw new CheckoutError(response.status, error.error.message, error.error.param);
  }
  return data;
}

/** A fixed-price checkout, so the amount is a literal at the call site. */
export async function paySetupFee(client: AcmeClient, token: string): Promise<Payment> {
  const { data, error, response } = await client.POST("/v1/payments", {
    body: {
      amount: 199.0,
      currency: "usd",
      payment_method: { token },
      description: "One-time setup fee",
    },
  });
  if (error) {
    throw new CheckoutError(response.status, error.error.message, error.error.param);
  }
  return data;
}

export async function fetchPayment(
  client: AcmeClient,
  id: string,
): Promise<Payment | null> {
  const { data, error } = await client.GET("/v1/payments/{id}", {
    params: { path: { id } },
  });
  if (error) return null;
  return data;
}

export async function refundPayment(
  client: AcmeClient,
  payment: Payment,
  amount?: number,
): Promise<Refund> {
  const { data, error, response } = await client.POST("/v1/refunds", {
    body: { payment: payment.id, amount: amount ?? payment.amount },
  });
  if (error) {
    throw new CheckoutError(response.status, error.error.message, error.error.param);
  }
  return data;
}

export function settledRevenue(payments: Payment[]): number {
  return payments
    .filter((payment) => payment.status === "succeeded")
    .reduce((sum, payment) => sum + payment.amount, 0);
}

export function receiptLine(payment: Payment): string {
  const { amount, currency, status } = payment;
  return `${payment.id} ${amount.toFixed(2)} ${currency} ${status}`;
}
