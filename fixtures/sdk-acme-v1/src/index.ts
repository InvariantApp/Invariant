/**
 * Acme SDK, generated for API contract 2026-01-15.
 *
 * The contract label is baked in at SDK release time, so the SDK version a
 * consumer depends on is what decides the wire contract it speaks.
 */

export const ACME_CONTRACT = "2026-01-15";

export type ChargeStatus = "succeeded" | "failed" | "pending";

export type Currency = "usd" | "eur" | "gbp";

export interface Charge {
  id: string;
  object: "charge";
  /** Charge amount in major currency units. */
  amount: number;
  currency: Currency;
  source: string;
  status: ChargeStatus;
  description: string | null;
  created: number;
}

export interface ChargeCreateParams {
  /** Charge amount in major currency units. */
  amount: number;
  currency: Currency;
  source: string;
  description?: string | null;
}

export interface ChargeList {
  object: "list";
  data: Charge[];
  has_more: boolean;
}

export interface ChargeListParams {
  limit?: number;
}

export interface Refund {
  id: string;
  object: "refund";
  charge: string;
  amount: number;
  status: "succeeded";
  created: number;
}

export interface RefundCreateParams {
  charge: string;
  amount?: number;
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
  readonly charges: Charges;
  readonly refunds: Refunds;

  constructor(options: AcmeClientOptions) {
    const transport = new Transport(options);
    this.charges = new Charges(transport);
    this.refunds = new Refunds(transport);
  }
}

class Charges {
  readonly #transport: Transport;

  constructor(transport: Transport) {
    this.#transport = transport;
  }

  create(params: ChargeCreateParams): Promise<Charge> {
    return this.#transport.request<Charge>("POST", "/v1/charges", { body: params });
  }

  retrieve(id: string): Promise<Charge> {
    return this.#transport.request<Charge>("GET", `/v1/charges/${id}`);
  }

  list(params: ChargeListParams = {}): Promise<ChargeList> {
    return this.#transport.request<ChargeList>("GET", "/v1/charges", {
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
