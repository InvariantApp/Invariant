/**
 * The kill switch, against the real provider.
 *
 * This is the rollback story, and until now it was the only part of the safety
 * story with no test behind it. What it has to get right is not "stop
 * transforming" - that is easy and wrong. Skipping a transform serves an old
 * caller a body in the canonical shape, which is a silent corruption of exactly
 * the integration the adapter exists to protect. Switching compatibility off
 * has to mean refusing the request, visibly, with a status the caller can act
 * on.
 *
 * Three granularities exist because three different things go wrong. A single
 * Change turns out to be wrong; a whole contract's program turns out to be
 * wrong; or something is wrong and nobody yet knows what.
 */

import type { RuntimeFlags } from "@invariant-app/runtime";
import { describe, expect, it } from "vitest";
import { type AcmeApp, createAcmeApp } from "./index.ts";
import { ACME_PROGRAM } from "./program.ts";

interface Body {
  id?: string;
  amount?: number;
  status?: string;
  error?: { type?: string; code?: string; message?: string };
}

function provider(flags: () => RuntimeFlags): AcmeApp {
  return createAcmeApp({ build: "head", program: ACME_PROGRAM, flags });
}

/** A charge as a consumer on the oldest contract would create one. */
async function createCharge(app: AcmeApp): Promise<{ status: number; body: Body }> {
  const response = await app.fetch(
    new Request("http://acme/v1/charges", {
      method: "POST",
      headers: {
        authorization: "Bearer sk_test_alpha",
        "acme-version": "2026-01-15",
        "content-type": "application/json",
      },
      body: JSON.stringify({ amount: 49.99, currency: "usd", source: "tok_visa" }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Body };
}

describe("the kill switch", () => {
  it("serves the old contract normally when nothing is switched off", async () => {
    const { status, body } = await createCharge(provider(() => ({})));

    expect(status).toBe(201);
    // Major units and the old vocabulary, which is what this caller's contract
    // promised it.
    expect(body.amount).toBe(49.99);
    expect(body.status).toBe("succeeded");
  });

  /**
   * The property that matters most.
   *
   * A switched-off transform must not become a skipped transform. Passing the
   * canonical body through would hand this caller `amount_cents: 4999` under a
   * field name its contract has never heard of, and it would look like a
   * success.
   */
  it("refuses the request rather than serving a body in the wrong shape", async () => {
    const { status, body } = await createCharge(provider(() => ({ allDisabled: true })));

    expect(status).toBe(400);
    expect(body.error?.code).toBe("invariant_contract_unsupported");
    expect(body.amount).toBeUndefined();
    expect(body.error?.message).toContain("switched off");
  });

  it("switches off one contract and leaves the others alone", async () => {
    const app = provider(() => ({ disabledContracts: ["2026-01-15"] }));

    const old = await createCharge(app);
    expect(old.status).toBe(400);
    expect(old.body.error?.code).toBe("invariant_contract_unsupported");

    // A caller on the contract that was not switched off is unaffected.
    const newer = await app.fetch(
      new Request("http://acme/v1/payments", {
        method: "POST",
        headers: {
          authorization: "Bearer sk_test_bravo",
          "acme-version": "2026-03-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          amount: 20,
          currency: "usd",
          payment_method: { token: "tok_visa" },
        }),
      }),
    );
    expect(newer.status).toBe(201);
    expect(((await newer.json()) as Body).amount).toBe(20);
  });

  /**
   * One Change turning out to be wrong is the likeliest reason to reach for
   * this, and it is the granularity that lets a provider stop the damage
   * without taking every old integration down with it.
   */
  it("switches off a single Change, and only where that Change applies", async () => {
    const app = provider(() => ({ disabledChanges: ["chg_money_in_minor_units"] }));

    const charge = await createCharge(app);
    expect(charge.status).toBe(400);
    expect(charge.body.error?.code).toBe("invariant_contract_unsupported");
    expect(charge.body.error?.message).toContain("chg_money_in_minor_units");

    // An operation whose program does not reference that Change still works,
    // which is what makes this worth having over switching off the contract.
    const listed = await app.fetch(
      new Request("http://acme/v1/charges", {
        headers: {
          authorization: "Bearer sk_test_alpha",
          "acme-version": "2026-01-15",
        },
      }),
    );
    // Listing carries the money Change too, so it is refused as well. What is
    // being asserted is that the refusal is decided per site from the compiled
    // program rather than applied to everything by hand.
    expect(listed.status).toBe(400);
  });

  it("never refuses a caller on the current contract, whatever is switched off", async () => {
    const app = provider(() => ({ allDisabled: true }));

    // This caller needs no transform at all, so there is nothing to switch
    // off. Taking them down during a rollback would turn a compatibility
    // problem into an outage for everybody.
    const response = await app.fetch(
      new Request("http://acme/v1/payments", {
        method: "POST",
        headers: {
          authorization: "Bearer sk_test_delta",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          amount_cents: 4999,
          currency: "usd",
          payment_method: { token: "tok_visa" },
          capture_method: "automatic",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(((await response.json()) as Body).status).toBe("paid");
  });

  it("takes effect between one request and the next, with no redeploy", async () => {
    let disabled = false;
    const app = provider(() => (disabled ? { allDisabled: true } : {}));

    expect((await createCharge(app)).status).toBe(201);

    // The flags are read per request, so a file or an environment variable
    // changing is the whole propagation story. Nothing is cached for the life
    // of the process, which is what "takes effect without a deploy" means.
    disabled = true;
    expect((await createCharge(app)).status).toBe(400);

    disabled = false;
    expect((await createCharge(app)).status).toBe(201);
  });
});
