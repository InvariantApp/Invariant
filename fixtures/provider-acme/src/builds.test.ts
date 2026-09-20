import { describe, expect, it } from "vitest";
import { createAcmeApp, sign } from "./index.ts";

function post(
  app: { fetch: (req: Request) => Response | Promise<Response> },
  path: string,
  body: unknown,
  init: { key?: string; signed?: boolean; headers?: Record<string, string> } = {},
): Promise<Response> {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${init.key ?? "sk_test_delta"}`,
    ...init.headers,
  };
  if (init.signed) headers["acme-signature"] = sign(raw);
  return Promise.resolve(
    app.fetch(
      new Request(`http://acme.test${path}`, { method: "POST", headers, body: raw }),
    ),
  );
}

describe("provider fixture builds", () => {
  it("serves charges with major-unit amounts at contract 2026-01-15", async () => {
    const { app } = createAcmeApp({ build: "2026-01-15" });
    const res = await post(app, "/v1/charges", {
      amount: 49.99,
      currency: "usd",
      source: "tok_visa",
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      object: "charge",
      amount: 49.99,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
    });
  });

  it("serves payments with a nested payment method at contract 2026-03-01", async () => {
    const { app } = createAcmeApp({ build: "2026-03-01" });
    const res = await post(app, "/v1/payments", {
      amount: 49.99,
      currency: "usd",
      payment_method: { token: "tok_visa" },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      object: "payment",
      amount: 49.99,
      payment_method: { token: "tok_visa" },
      status: "succeeded",
    });
  });

  it("serves minor units, the new status vocabulary and capture_method at head", async () => {
    const { app } = createAcmeApp({ build: "head" });
    const res = await post(app, "/v1/payments", {
      amount_cents: 4999,
      currency: "usd",
      payment_method: { token: "tok_visa" },
      capture_method: "automatic",
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      object: "payment",
      amount_cents: 4999,
      capture_method: "automatic",
      status: "paid",
    });
  });

  it("rejects a head request that omits capture_method", async () => {
    const { app } = createAcmeApp({ build: "head" });
    const res = await post(app, "/v1/payments", {
      amount_cents: 4999,
      currency: "usd",
      payment_method: { token: "tok_visa" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { type: "invalid_request_error", param: "capture_method" },
    });
  });

  it("verifies a body signature over the bytes the client sent", async () => {
    const { app } = createAcmeApp({ build: "head" });
    const body = {
      amount_cents: 4999,
      currency: "usd",
      payment_method: { token: "tok_visa" },
      capture_method: "automatic",
    };
    const ok = await post(app, "/v1/payments", body, { signed: true });
    expect(ok.status).toBe(201);

    const tampered = await app.fetch(
      new Request("http://acme.test/v1/payments", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer sk_test_delta",
          "acme-signature": sign(JSON.stringify({ ...body, amount_cents: 1 })),
        },
        body: JSON.stringify(body),
      }),
    );
    expect(tampered.status).toBe(401);
  });

  it("rejects an unauthenticated request", async () => {
    const { app } = createAcmeApp({ build: "head" });
    const res = await app.fetch(
      new Request("http://acme.test/v1/payments", { method: "GET" }),
    );
    expect(res.status).toBe(401);
  });

  it("reuses one store across reads and refunds", async () => {
    const { app } = createAcmeApp({ build: "head" });
    const created = (await (
      await post(app, "/v1/payments", {
        amount_cents: 2500,
        currency: "eur",
        payment_method: { token: "tok_visa" },
        capture_method: "manual",
      })
    ).json()) as { id: string; status: string };
    expect(created.status).toBe("processing");

    const fetched = await app.fetch(
      new Request(`http://acme.test/v1/payments/${created.id}`, {
        headers: { authorization: "Bearer sk_test_delta" },
      }),
    );
    expect(fetched.status).toBe(200);

    const refunded = await post(app, "/v1/refunds", { payment: created.id });
    expect(refunded.status).toBe(201);
    expect(await refunded.json()).toMatchObject({
      object: "refund",
      payment: created.id,
      amount_cents: 2500,
    });
  });
});
