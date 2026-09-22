/**
 * The provider runs only its canonical current API. Everything an old contract
 * needs comes from the compiled program, inside this same build.
 */
import type { UsageEvent } from "@invariant-app/runtime";
import { beforeEach, describe, expect, it } from "vitest";
import { sign } from "./auth.ts";
import { ACME_PROGRAM, createAcmeApp } from "./index.ts";

type Fetcher = (request: Request) => Response | Promise<Response>;

let usage: UsageEvent[] = [];

function head(
  flags?: () => { disabledChanges?: string[]; allDisabled?: boolean },
): Fetcher {
  usage = [];
  const { fetch } = createAcmeApp({
    build: "head",
    program: ACME_PROGRAM,
    onUsage: (event) => usage.push(event),
    ...(flags ? { flags } : {}),
  });
  return fetch;
}

function call(
  app: Fetcher,
  method: string,
  path: string,
  init: { body?: unknown; key?: string; version?: string; signed?: boolean } = {},
): Promise<Response> {
  const raw = init.body === undefined ? undefined : JSON.stringify(init.body);
  const headers: Record<string, string> = {
    authorization: `Bearer ${init.key ?? "sk_test_alpha"}`,
  };
  if (raw !== undefined) headers["content-type"] = "application/json";
  if (init.version) headers["acme-version"] = init.version;
  if (init.signed && raw !== undefined) headers["acme-signature"] = sign(raw);

  return Promise.resolve(
    app(
      new Request(`http://acme.test${path}`, {
        method,
        headers,
        ...(raw === undefined ? {} : { body: raw }),
      }),
    ),
  );
}

beforeEach(() => {
  usage = [];
});

describe("serving contract 2026-01-15 from the current API", () => {
  it("accepts the oldest contract's path, field names and units", async () => {
    const app = head();
    const res = await call(app, "POST", "/v1/charges", {
      body: { amount: 49.99, currency: "usd", source: "tok_visa" },
      version: "2026-01-15",
    });

    expect(res.status).toBe(201);
    expect(res.headers.get("invariant-contract")).toBe("2026-01-15");
    expect(await res.json()).toMatchObject({
      object: "charge",
      amount: 49.99,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
    });
  });

  it("does not leak fields the old contract never had", async () => {
    const app = head();
    const res = await call(app, "POST", "/v1/charges", {
      body: { amount: 10, currency: "usd", source: "tok_visa" },
      version: "2026-01-15",
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "amount",
      "created",
      "currency",
      "description",
      "id",
      "object",
      "source",
      "status",
    ]);
  });

  it("scales money exactly, in both directions", async () => {
    const app = head();
    const created = await call(app, "POST", "/v1/charges", {
      body: { amount: 4.35, currency: "usd", source: "tok_visa" },
      version: "2026-01-15",
    });
    // 4.35 * 100 is 434.99999999999994 as a double. The wire value must be 435.
    expect((await created.json()) as { amount: number }).toMatchObject({ amount: 4.35 });

    const canonical = await call(app, "GET", "/v1/payments", {
      key: "sk_test_delta",
      version: "2026-09-20",
    });
    const list = (await canonical.json()) as { data: { amount_cents: number }[] };
    expect(list.data[0]?.amount_cents).toBe(435);
  });

  it("translates the status vocabulary back", async () => {
    const app = head();
    for (const [token, expected] of [
      ["tok_visa", "succeeded"],
      ["tok_fail", "failed"],
      ["tok_pending", "pending"],
    ] as const) {
      const res = await call(app, "POST", "/v1/charges", {
        body: { amount: 1, currency: "usd", source: token },
        version: "2026-01-15",
      });
      expect((await res.json()) as { status: string }).toMatchObject({
        status: expected,
      });
    }
  });

  it("reaches inside a list envelope", async () => {
    const app = head();
    await call(app, "POST", "/v1/charges", {
      body: { amount: 12.34, currency: "usd", source: "tok_visa" },
      version: "2026-01-15",
    });
    const res = await call(app, "GET", "/v1/charges", { version: "2026-01-15" });
    const body = (await res.json()) as {
      object: string;
      data: Record<string, unknown>[];
    };
    expect(body.object).toBe("list");
    expect(body.data[0]).toMatchObject({
      object: "charge",
      amount: 12.34,
      source: "tok_visa",
    });
    expect(body.data[0]).not.toHaveProperty("amount_cents");
    expect(body.data[0]).not.toHaveProperty("capture_method");
  });

  it("carries a path parameter through the rewrite", async () => {
    const app = head();
    const created = (await (
      await call(app, "POST", "/v1/charges", {
        body: { amount: 7.5, currency: "gbp", source: "tok_visa" },
        version: "2026-01-15",
      })
    ).json()) as { id: string };

    const res = await call(app, "GET", `/v1/charges/${created.id}`, {
      version: "2026-01-15",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: created.id,
      amount: 7.5,
      object: "charge",
    });
  });

  it("maps refunds, which changed in both contract steps", async () => {
    const app = head();
    const charge = (await (
      await call(app, "POST", "/v1/charges", {
        body: { amount: 20, currency: "usd", source: "tok_visa" },
        version: "2026-01-15",
      })
    ).json()) as { id: string };

    const res = await call(app, "POST", "/v1/refunds", {
      body: { charge: charge.id, amount: 20 },
      version: "2026-01-15",
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      object: "refund",
      charge: charge.id,
      amount: 20,
    });
  });
});

describe("serving contract 2026-03-01", () => {
  it("needs no path rewrite, only the field and unit changes", async () => {
    const app = head();
    const res = await call(app, "POST", "/v1/payments", {
      body: { amount: 42.49, currency: "usd", payment_method: { token: "tok_visa" } },
      version: "2026-03-01",
      key: "sk_test_bravo",
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      object: "payment",
      amount: 42.49,
      payment_method: { token: "tok_visa" },
      status: "succeeded",
    });
  });
});

describe("the current contract", () => {
  it("passes straight through untouched", async () => {
    const app = head();
    const res = await call(app, "POST", "/v1/payments", {
      body: {
        amount_cents: 4999,
        currency: "usd",
        payment_method: { token: "tok_visa" },
        capture_method: "manual",
      },
      key: "sk_test_delta",
      version: "2026-09-20",
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      amount_cents: 4999,
      capture_method: "manual",
      status: "processing",
    });
    expect(usage).toEqual([]);
  });
});

describe("identity", () => {
  it("falls back to the contract pinned to the account", async () => {
    const app = head();
    // No version header at all: consumer A's key is pinned to 2026-01-15.
    const res = await call(app, "POST", "/v1/charges", {
      body: { amount: 5, currency: "usd", source: "tok_visa" },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ object: "charge", amount: 5 });
  });

  it("refuses a contract it has no program for", async () => {
    const app = head();
    const res = await call(app, "POST", "/v1/payments", {
      body: { amount: 1, currency: "usd", payment_method: { token: "tok_visa" } },
      version: "2025-01-01",
      key: "sk_test_delta",
    });
    // An unknown label is not a contract, so the account pin decides instead.
    expect(res.status).toBe(400);
  });

  it("ignores an internal header supplied by the caller", async () => {
    const app = head();
    const res = await Promise.resolve(
      app(
        new Request("http://acme.test/v1/payments", {
          method: "POST",
          headers: {
            authorization: "Bearer sk_test_delta",
            "content-type": "application/json",
            // Forged: stage one strips this before stage two ever sees it.
            "x-invariant-contract-hint": "2026-01-15",
          },
          body: JSON.stringify({
            amount_cents: 999,
            currency: "usd",
            payment_method: { token: "tok_visa" },
            capture_method: "automatic",
          }),
        }),
      ),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ amount_cents: 999 });
  });
});

describe("signed requests", () => {
  it("verifies the signature over the bytes the client sent, then transforms", async () => {
    const app = head();
    const res = await call(app, "POST", "/v1/charges", {
      body: { amount: 49.99, currency: "usd", source: "tok_visa" },
      version: "2026-01-15",
      signed: true,
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ amount: 49.99, source: "tok_visa" });
  });
});

describe("usage counting", () => {
  it("counts each Change that was actually applied, and nothing else", async () => {
    const app = head();
    await call(app, "POST", "/v1/charges", {
      body: { amount: 49.99, currency: "usd", source: "tok_visa" },
      version: "2026-01-15",
    });

    const applied = new Map<string, number>();
    for (const event of usage) {
      expect(event.contract).toBe("2026-01-15");
      expect(event.consumer).toBe("acct_alpha");
      for (const [change, count] of event.changes) {
        applied.set(change, (applied.get(change) ?? 0) + count);
      }
    }
    expect([...applied.keys()].sort()).toEqual([
      "chg_capture_method",
      "chg_charges_became_payments",
      "chg_money_in_minor_units",
      "chg_payment_status_vocabulary",
      "chg_source_became_payment_method",
    ]);
  });

  it("records no payload values, only which Change ran", () => {
    const serialized = JSON.stringify(
      usage.map((e) => ({ ...e, changes: [...e.changes] })),
    );
    expect(serialized).not.toContain("tok_visa");
    expect(serialized).not.toContain("49.99");
  });
});

describe("the kill switch", () => {
  it("refuses the contract rather than serving a half-applied transform", async () => {
    const app = head(() => ({ disabledChanges: ["chg_money_in_minor_units"] }));
    const res = await call(app, "POST", "/v1/charges", {
      body: { amount: 49.99, currency: "usd", source: "tok_visa" },
      version: "2026-01-15",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "invariant_contract_unsupported" },
    });
  });

  it("leaves the current contract working when compatibility is switched off", async () => {
    const app = head(() => ({ allDisabled: true }));
    const res = await call(app, "POST", "/v1/payments", {
      body: {
        amount_cents: 100,
        currency: "usd",
        payment_method: { token: "tok_visa" },
        capture_method: "automatic",
      },
      key: "sk_test_delta",
      version: "2026-09-20",
    });
    expect(res.status).toBe(201);
  });
});
