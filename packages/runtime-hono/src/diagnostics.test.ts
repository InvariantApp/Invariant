/**
 * A refusal a caller can quote, and a body that cannot hold a worker.
 *
 * A caller who was refused has one thing to give the provider's support:
 * what they were sent. Every refusal and failure now carries an id in
 * `Invariant-Error-Id`, and the outcome event the provider logs carries the
 * same one, so the two can be put together without a body or a guess.
 */
import {
  createRuntime,
  type OutcomeEvent,
  TimeBudgetError,
  TransformError,
} from "@invariant/runtime";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { adapt, wrapFetch } from "./index.ts";

const OLD = "2026-01-01";
const HEADER = "payments-version";

const PROGRAM = {
  irVersion: 2,
  api: "payments",
  currentLabel: "2026-09-20",
  current: "sha256:head",
  contracts: {
    [OLD]: {
      label: OLD,
      routes: [],
      sites: {
        "post /v1/things": {
          request: [
            {
              k: "enum",
              path: "/status",
              map: { open: "active" },
              c: "chg_status",
            },
          ],
          response: {
            "2xx": [
              {
                k: "enum",
                path: "/status",
                map: { active: "open" },
                c: "chg_status",
              },
            ],
          },
        },
        "post /v1/lists": {
          request: [
            {
              k: "within",
              path: "/items/*",
              block: [{ k: "move", from: "/a", to: "/b", c: "chg_items" }],
              c: "chg_items",
            },
          ],
        },
      },
      behaviors: [],
      retired: [],
    },
  },
};

function service(options: { disabled?: string[]; timeBudgetMs?: number } = {}) {
  const outcomes: OutcomeEvent[] = [];
  const runtime = createRuntime({
    program: PROGRAM,
    identity: [
      { kind: "header" as const, name: HEADER },
      { kind: "default" as const, label: "2026-09-20" },
    ],
    onOutcome: (event) => outcomes.push(event),
    flags: () => ({ disabledContracts: options.disabled ?? [] }),
    ...(options.timeBudgetMs === undefined
      ? {}
      : { limits: { maxMatches: 10_000, timeBudgetMs: options.timeBudgetMs } }),
  });
  const app = new Hono();
  app.use("/v1/*", adapt({ runtime }));
  app.post("/v1/things", (c) => c.json({ status: "archived" }));
  app.post("/v1/lists", (c) => c.json({ ok: true }));
  return {
    fetch: wrapFetch((request) => app.fetch(request), { runtime }),
    outcomes,
    runtime,
  };
}

const post = (path: string, body: unknown) =>
  new Request(`https://api.example.com${path}`, {
    method: "POST",
    headers: { [HEADER]: OLD, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("a refusal a caller can quote", () => {
  it("is sent with the id the provider's outcome event carries, for a request", async () => {
    const { fetch, outcomes } = service();
    const refused = await fetch(post("/v1/things", { status: "paused" }));
    expect(refused.status).toBe(400);
    const id = refused.headers.get("invariant-error-id");
    expect(id).toMatch(/^err_[0-9a-f]{24}$/);
    expect(outcomes.at(-1)).toMatchObject({ outcome: "refused", errorId: id });
  });

  it("and for a response that could not be expressed", async () => {
    const { fetch, outcomes } = service();
    const failed = await fetch(post("/v1/things", { status: "open" }));
    expect(failed.status).toBe(502);
    const id = failed.headers.get("invariant-error-id");
    expect(id).toMatch(/^err_/);
    expect(outcomes.at(-1)).toMatchObject({ outcome: "failed", errorId: id });
  });

  it("and for a contract switched off", async () => {
    const { fetch, outcomes } = service({ disabled: [OLD] });
    const refused = await fetch(post("/v1/things", { status: "open" }));
    const id = refused.headers.get("invariant-error-id");
    expect(id).toMatch(/^err_/);
    expect(outcomes.at(-1)).toMatchObject({
      reason: "UnsupportedContractError",
      errorId: id,
    });
  });

  it("is a different id for each refusal", async () => {
    const { fetch } = service();
    const ids = await Promise.all(
      [1, 2].map(async () =>
        (await fetch(post("/v1/things", { status: "paused" }))).headers.get(
          "invariant-error-id",
        ),
      ),
    );
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe("a body that takes too long", () => {
  const items = Array.from({ length: 2000 }, (_, index) => ({ a: index }));

  it("is refused as too large to translate, not finished late", async () => {
    const { fetch, outcomes } = service({ timeBudgetMs: 0 });
    const refused = await fetch(post("/v1/lists", { items }));
    expect(refused.status).toBe(413);
    expect(outcomes.at(-1)).toMatchObject({ reason: "TimeBudgetError" });
  });

  it("is translated when the budget allows it, and the default does", async () => {
    const { fetch } = service();
    expect((await fetch(post("/v1/lists", { items }))).status).toBe(200);
  });

  it("is a transform error a binding already knows how to answer", () => {
    expect(new TimeBudgetError("chg", 5)).toBeInstanceOf(TransformError);
  });
});
