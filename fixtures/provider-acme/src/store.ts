/**
 * Version-neutral domain store for the Acme payments fixture.
 *
 * The store holds the provider's internal representation, which has always kept
 * money in minor units and has always had a capture method. What changed across
 * contracts is only how that state was presented on the wire. Each build in
 * `src/builds` renders this state in the shape its contract promised.
 */

export type CaptureMethod = "automatic" | "manual";

/** Canonical internal status. Contracts spell these differently on the wire. */
export type PaymentStatus = "paid" | "failed" | "processing";

export interface Payment {
  id: string;
  amountMinor: number;
  currency: string;
  paymentMethodToken: string;
  captureMethod: CaptureMethod;
  status: PaymentStatus;
  description: string | null;
  created: number;
}

export interface Refund {
  id: string;
  paymentId: string;
  amountMinor: number;
  status: "succeeded";
  created: number;
}

export interface CreatePaymentInput {
  amountMinor: number;
  currency: string;
  paymentMethodToken: string;
  captureMethod: CaptureMethod;
  description?: string | null;
}

export interface CreateRefundInput {
  paymentId: string;
  amountMinor?: number;
}

/**
 * The token a caller passes decides the outcome, so scenarios are reproducible
 * without any randomness. Anything else succeeds.
 */
function outcomeFor(token: string): PaymentStatus {
  if (token.includes("fail")) return "failed";
  if (token.includes("pending")) return "processing";
  return "paid";
}

export class AcmeStore {
  readonly #payments = new Map<string, Payment>();
  readonly #refunds = new Map<string, Refund>();
  #seq = 0;
  #clock: number;

  constructor(options: { startClock?: number } = {}) {
    this.#clock = options.startClock ?? 1_760_000_000;
  }

  #nextId(prefix: string): string {
    this.#seq += 1;
    return `${prefix}_${String(this.#seq).padStart(6, "0")}`;
  }

  #tick(): number {
    this.#clock += 1;
    return this.#clock;
  }

  createPayment(input: CreatePaymentInput): Payment {
    const payment: Payment = {
      id: this.#nextId("pay"),
      amountMinor: input.amountMinor,
      currency: input.currency.toLowerCase(),
      paymentMethodToken: input.paymentMethodToken,
      captureMethod: input.captureMethod,
      status:
        input.captureMethod === "manual"
          ? "processing"
          : outcomeFor(input.paymentMethodToken),
      description: input.description ?? null,
      created: this.#tick(),
    };
    this.#payments.set(payment.id, payment);
    return payment;
  }

  getPayment(id: string): Payment | undefined {
    return this.#payments.get(id);
  }

  listPayments(limit: number): { data: Payment[]; hasMore: boolean } {
    const all = [...this.#payments.values()].reverse();
    return { data: all.slice(0, limit), hasMore: all.length > limit };
  }

  createRefund(input: CreateRefundInput): Refund | { error: "no_such_payment" } {
    const payment = this.#payments.get(input.paymentId);
    if (!payment) return { error: "no_such_payment" };
    const refund: Refund = {
      id: this.#nextId("re"),
      paymentId: payment.id,
      amountMinor: input.amountMinor ?? payment.amountMinor,
      status: "succeeded",
      created: this.#tick(),
    };
    this.#refunds.set(refund.id, refund);
    return refund;
  }

  getRefund(id: string): Refund | undefined {
    return this.#refunds.get(id);
  }
}
