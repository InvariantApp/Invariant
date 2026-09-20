/**
 * Acme SDK, generated for the current API contract.
 *
 * Money crosses the wire in minor units as an integer. `toMinorUnits` and
 * `fromMinorUnits` are exported so callers never have to write float
 * arithmetic, and so a migration can wrap an existing major-unit expression
 * rather than trying to rewrite it.
 */

export const ACME_CONTRACT = "2026-09-20";

export type PaymentStatus = "paid" | "failed" | "processing";

export type CaptureMethod = "automatic" | "manual";

export type Currency = "usd" | "eur" | "gbp";

export interface PaymentMethod {
  token: string;
}

export interface Payment {
  id: string;
  object: "payment";
  /** Payment amount in minor currency units. */
  amount_cents: number;
  currency: Currency;
  payment_method: PaymentMethod;
  capture_method: CaptureMethod;
  status: PaymentStatus;
  description: string | null;
  created: number;
}

export interface PaymentCreateParams {
  /** Payment amount in minor currency units. */
  amount_cents: number;
  currency: Currency;
  payment_method: PaymentMethod;
  capture_method: CaptureMethod;
  description?: string | null;
}

export interface PaymentList {
  object: "list";
  data: Payment[];
  has_more: boolean;
}

export interface PaymentListParams {
  limit?: number;
}

export interface Refund {
  id: string;
  object: "refund";
  payment: string;
  amount_cents: number;
  status: "succeeded";
  created: number;
}

export interface RefundCreateParams {
  payment: string;
  amount_cents?: number;
}

export interface AcmeErrorBody {
  error: { type: string; message: string; param?: string };
}

export class AcmeError extends Error {
  readonly status: number;
  readonly type: string;
  readonly param: string | undefined;

  constructor(status: number, body: AcmeErrorBody) {
    super(body.error.message);
    this.name = "AcmeError";
    this.status = status;
    this.type = body.error.type;
    this.param = body.error.param;
  }
}

const SCALE = 100n;

/**
 * Convert a major-unit amount to minor units exactly. Accepts a number or a
 * decimal string and refuses anything with more precision than the currency
 * can carry, rather than rounding silently.
 */
export function toMinorUnits(major: number | string): number {
  const text = typeof major === "number" ? numberToDecimalString(major) : major.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new RangeError(`Not a decimal amount: ${String(major)}`);
  }
  const negative = text.startsWith("-");
  const [whole = "0", fraction = ""] = text.replace(/^-/, "").split(".");
  if (fraction.length > 2) {
    throw new RangeError(`Amount ${text} has more than 2 decimal places.`);
  }
  const scaled = BigInt(whole) * SCALE + BigInt(fraction.padEnd(2, "0") || "0");
  const signed = negative ? -scaled : scaled;
  if (
    signed > BigInt(Number.MAX_SAFE_INTEGER) ||
    signed < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    throw new RangeError(`Amount ${text} does not fit in a safe integer.`);
  }
  return Number(signed);
}

/** Convert minor units back to a major-unit number. */
export function fromMinorUnits(minor: number): number {
  if (!Number.isSafeInteger(minor)) {
    throw new RangeError(`Minor-unit amounts must be safe integers, got ${minor}`);
  }
  return Number(`${minor < 0 ? "-" : ""}${decimalParts(Math.abs(minor))}`);
}

function decimalParts(minor: number): string {
  const text = String(minor).padStart(3, "0");
  return `${text.slice(0, -2)}.${text.slice(-2)}`;
}

function numberToDecimalString(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError(`Not a finite amount: ${value}`);
  const text = String(value);
  if (text.includes("e") || text.includes("E")) {
    throw new RangeError(`Exponential amounts are not supported: ${text}`);
  }
  return text;
}

export interface AcmeClientOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

class Transport {
  readonly #options: AcmeClientOptions;

  constructor(options: AcmeClientOptions) {
    this.#options = options;
  }

  async request<T>(
    method: string,
    path: string,
    init: { body?: unknown; query?: Record<string, string | number | undefined> } = {},
  ): Promise<T> {
    const url = new URL(path, this.#options.baseUrl);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const doFetch = this.#options.fetch ?? globalThis.fetch;
    const response = await doFetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.#options.apiKey}`,
        "acme-version": ACME_CONTRACT,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

    const payload: unknown = await response.json();
    if (!response.ok) {
      throw new AcmeError(response.status, payload as AcmeErrorBody);
    }
    return payload as T;
  }
}

export class AcmeClient {
  readonly payments: Payments;
  readonly refunds: Refunds;

  constructor(options: AcmeClientOptions) {
    const transport = new Transport(options);
    this.payments = new Payments(transport);
    this.refunds = new Refunds(transport);
  }
}

class Payments {
  readonly #transport: Transport;

  constructor(transport: Transport) {
    this.#transport = transport;
  }

  create(params: PaymentCreateParams): Promise<Payment> {
    return this.#transport.request<Payment>("POST", "/v1/payments", { body: params });
  }

  retrieve(id: string): Promise<Payment> {
    return this.#transport.request<Payment>("GET", `/v1/payments/${id}`);
  }

  list(params: PaymentListParams = {}): Promise<PaymentList> {
    return this.#transport.request<PaymentList>("GET", "/v1/payments", {
      query: { limit: params.limit },
    });
  }
}

class Refunds {
  readonly #transport: Transport;

  constructor(transport: Transport) {
    this.#transport = transport;
  }

  create(params: RefundCreateParams): Promise<Refund> {
    return this.#transport.request<Refund>("POST", "/v1/refunds", { body: params });
  }
}
