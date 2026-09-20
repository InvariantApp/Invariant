/**
 * Consumer C: a donation widget backend that calls Acme contract 2026-03-01
 * over raw fetch. There is no SDK and no generated types here, so nothing about
 * these call sites is checkable against the provider's schema. That is exactly
 * why a migration has to treat them as lower confidence and ask for review.
 */

export interface AcmeConfig {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

export interface DonationResult {
  id: string;
  /** Donated amount in major currency units. */
  amount: number;
  currency: string;
  status: string;
  acknowledged: boolean;
}

export class DonationError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "DonationError";
    this.status = status;
  }
}

const SUGGESTED_AMOUNTS = [5.0, 25.0, 100.0];

export function suggestedAmounts(): number[] {
  return [...SUGGESTED_AMOUNTS];
}

function request(config: AcmeConfig): typeof globalThis.fetch {
  return config.fetch ?? globalThis.fetch;
}

export async function donate(
  config: AcmeConfig,
  amount: number,
  token: string,
  note?: string,
): Promise<DonationResult> {
  const response = await request(config)(`${config.baseUrl}/v1/payments`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "acme-version": "2026-03-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      amount,
      currency: "usd",
      payment_method: { token },
      description: note ?? "Donation",
    }),
  });

  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const error = payload["error"] as { message?: string } | undefined;
    throw new DonationError(response.status, error?.message ?? "Donation failed");
  }

  return {
    id: payload["id"] as string,
    amount: payload["amount"] as number,
    currency: payload["currency"] as string,
    status: payload["status"] as string,
    acknowledged: payload["status"] === "succeeded",
  };
}

export async function lookupDonation(
  config: AcmeConfig,
  id: string,
): Promise<DonationResult | null> {
  const response = await request(config)(`${config.baseUrl}/v1/payments/${id}`, {
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "acme-version": "2026-03-01",
    },
  });
  if (!response.ok) return null;

  const payload = (await response.json()) as Record<string, unknown>;
  return {
    id: payload["id"] as string,
    amount: payload["amount"] as number,
    currency: payload["currency"] as string,
    status: payload["status"] as string,
    acknowledged: payload["status"] === "succeeded",
  };
}

export async function refundDonation(
  config: AcmeConfig,
  id: string,
): Promise<{ id: string; amount: number }> {
  const response = await request(config)(`${config.baseUrl}/v1/refunds`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "acme-version": "2026-03-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ payment: id }),
  });

  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const error = payload["error"] as { message?: string } | undefined;
    throw new DonationError(response.status, error?.message ?? "Refund failed");
  }
  return { id: payload["id"] as string, amount: payload["amount"] as number };
}

export function campaignProgress(
  donations: DonationResult[],
  goal: number,
): { raised: number; percent: number } {
  const raised = donations
    .filter((donation) => donation.acknowledged)
    .reduce((sum, donation) => sum + donation.amount, 0);
  return { raised, percent: Math.min(100, Math.round((raised / goal) * 100)) };
}
