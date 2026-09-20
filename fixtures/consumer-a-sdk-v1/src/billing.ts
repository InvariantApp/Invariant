/**
 * Consumer A: a subscription biller built against Acme contract 2026-01-15
 * using the nested-resource SDK.
 */
import {
  type AcmeClient,
  AcmeError,
  type Charge,
  type ChargeCreateParams,
  type Currency,
  type Refund,
} from "@acme/sdk-v1";

export interface Plan {
  id: string;
  name: string;
  /** Monthly price in major currency units. */
  price: number;
  currency: Currency;
}

export const PLANS: Record<string, Plan> = {
  starter: { id: "starter", name: "Starter", price: 9.99, currency: "usd" },
  growth: { id: "growth", name: "Growth", price: 49.99, currency: "usd" },
  scale: { id: "scale", name: "Scale", price: 249.0, currency: "usd" },
};

export interface Receipt {
  chargeId: string;
  planId: string;
  /** What the customer was billed, in major currency units. */
  billed: number;
  currency: Currency;
  settled: boolean;
}

export async function chargeSubscription(
  client: AcmeClient,
  planId: string,
  source: string,
): Promise<Receipt> {
  const plan = PLANS[planId];
  if (!plan) throw new Error(`Unknown plan: ${planId}`);

  const charge = await client.charges.create({
    amount: plan.price,
    currency: plan.currency,
    source,
    description: `${plan.name} subscription`,
  });

  const { amount, status } = charge;
  return {
    chargeId: charge.id,
    planId: plan.id,
    billed: amount,
    currency: charge.currency,
    settled: status === "succeeded",
  };
}

/** Prorated top-up: the amount is computed, not a literal. */
export async function chargeProrated(
  client: AcmeClient,
  planId: string,
  daysRemaining: number,
  source: string,
): Promise<Charge> {
  const plan = PLANS[planId];
  if (!plan) throw new Error(`Unknown plan: ${planId}`);

  const prorated = Math.round(plan.price * (daysRemaining / 30) * 100) / 100;
  const params: ChargeCreateParams = {
    amount: prorated,
    currency: plan.currency,
    source,
    description: `${plan.name} proration, ${daysRemaining} days`,
  };
  return client.charges.create(params);
}

/** Uses a spread, so the property is not written at the call site literally. */
export async function chargeWithOverrides(
  client: AcmeClient,
  base: ChargeCreateParams,
  overrides: Partial<ChargeCreateParams>,
): Promise<Charge> {
  return client.charges.create({ ...base, ...overrides });
}

export async function refundFully(client: AcmeClient, charge: Charge): Promise<Refund> {
  return client.refunds.create({ charge: charge.id, amount: charge.amount });
}

export function totalBilled(charges: Charge[]): number {
  return charges
    .filter((charge) => charge.status === "succeeded")
    .reduce((sum, charge) => sum + charge.amount, 0);
}

export function describeCharge(charge: Charge): string {
  return `${charge.id}: ${charge.amount.toFixed(2)} ${charge.currency.toUpperCase()} (${charge.status})`;
}

export function isRetryable(error: unknown): boolean {
  return error instanceof AcmeError && error.status >= 500;
}
