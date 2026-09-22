/**
 * E9 against real traffic, rather than against a hand-written ledger.
 *
 * The unit tests for the evidence take records as given. This takes the other
 * half: that a running service actually produces them, through the ordinary
 * middleware, without the provider writing any reporting code. If the runtime
 * does not emit these, E9 is a file format and nothing else.
 */

import { type OutcomeRecord, outcomeEvidence } from "@invariant-app/cli";
import type { OutcomeEvent } from "@invariant-app/runtime";
import { beforeEach, describe, expect, it } from "vitest";
import { ACME_PROGRAM, createAcmeApp } from "./index.ts";

let outcomes: OutcomeEvent[] = [];

type Fetcher = (request: Request) => Response | Promise<Response>;

function head(flags?: () => { disabledContracts?: string[] }): Fetcher {
  outcomes = [];
  const { fetch } = createAcmeApp({
    build: "head",
    program: ACME_PROGRAM,
    onOutcome: (event) => outcomes.push(event),
    ...(flags ? { flags } : {}),
  });
  return fetch;
}

function call(
  app: Fetcher,
  method: string,
  path: string,
  init: { body?: unknown; version?: string } = {},
): Promise<Response> {
  const raw = init.body === undefined ? undefined : JSON.stringify(init.body);
  const headers: Record<string, string> = { authorization: "Bearer sk_test_alpha" };
  if (raw !== undefined) headers["content-type"] = "application/json";
  if (init.version) headers["acme-version"] = init.version;

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

/** Folds the events a run produced into the ledger shape the gate reads. */
function ledger(): OutcomeRecord[] {
  const counts = new Map<string, { record: OutcomeRecord; count: number }>();

  for (const event of outcomes) {
    const record: OutcomeRecord = {
      contract: event.contract,
      operation: event.operation,
      direction: event.direction,
      outcome: event.outcome,
      count: 0,
      ...(event.reason === undefined ? {} : { reason: event.reason }),
    };
    const key = `${record.contract}\u0000${record.operation}\u0000${record.direction}\u0000${record.outcome}\u0000${record.reason ?? ""}`;
    const found = counts.get(key);
    if (found) found.count += 1;
    else counts.set(key, { record, count: 1 });
  }

  return [...counts.values()].map(({ record, count }) => ({ ...record, count }));
}

beforeEach(() => {
  outcomes = [];
});

describe("what a running service reports", () => {
  it("records both directions of an ordinary adapted request", async () => {
    const app = head();
    const response = await call(app, "POST", "/v1/charges", {
      body: { amount: 49.99, currency: "usd", source: "tok_visa" },
      version: "2026-01-15",
    });
    expect(response.status).toBe(201);

    // Both halves, because a rate over responses needs responses counted.
    expect(outcomes.map((event) => `${event.direction}:${event.outcome}`)).toEqual([
      "request:adapted",
      "response:adapted",
    ]);
    expect(outcomes[0]?.contract).toBe("2026-01-15");
  });

  it("stays silent for a caller already on the current contract", async () => {
    const app = head();
    await call(app, "POST", "/v1/payments", {
      body: {
        amount_cents: 4999,
        currency: "usd",
        payment_method: { token: "tok_visa" },
        capture_method: "automatic",
      },
      version: "2026-09-20",
    });

    // Nothing was adapted, so nothing is reported. Counting these would put a
    // denominator in the rate that no transform ever contributed to, and the
    // objective would look met however badly the old contracts were doing.
    expect(outcomes).toEqual([]);
  });

  /**
   * A request that cannot be expressed in the canonical contract. The handler
   * never runs, so this costs the caller a retry and nothing more, and the
   * evidence has to keep it separate from the expensive kind.
   */
  it("records a refusal when the request will not translate", async () => {
    const app = head();
    const response = await call(app, "POST", "/v1/charges", {
      // Three decimal places, against a contract declared to two. `scale10`
      // refuses rather than rounding somebody's money.
      body: { amount: 49.999, currency: "usd", source: "tok_visa" },
      version: "2026-01-15",
    });

    expect(response.status).toBe(400);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.direction).toBe("request");
    expect(outcomes[0]?.outcome).toBe("refused");
  });

  it("records a caller turned away by the kill switch", async () => {
    const app = head(() => ({ disabledContracts: ["2026-01-15"] }));
    const response = await call(app, "GET", "/v1/charges/ch_missing", {
      version: "2026-01-15",
    });

    expect(response.status).toBe(400);
    expect(outcomes[0]?.reason).toBe("UnsupportedContractError");

    // And it reaches the evidence, which is the point: a kill switch left on
    // by accident is indistinguishable from the consumers having left, and
    // "nobody is calling this any more" is what retires a contract.
    const [evidence] = outcomeEvidence(["2026-01-15"], ledger());
    expect(evidence?.detail?.join(" ")).toContain("UnsupportedContractError");
  });

  it("turns a healthy run into passing evidence", async () => {
    const app = head();
    for (let index = 0; index < 5; index += 1) {
      await call(app, "POST", "/v1/charges", {
        body: { amount: 10.5, currency: "usd", source: "tok_visa" },
        version: "2026-01-15",
      });
    }

    const [evidence] = outcomeEvidence(["2026-01-15"], ledger());
    expect(evidence?.result).toBe("pass");
    expect(evidence?.summary).toContain("5 requests and 5 responses adapted");
    expect(evidence?.summary).toContain("0 responses failed");
  });
});
