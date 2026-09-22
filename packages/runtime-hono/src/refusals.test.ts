/**
 * What a caller hears when a transform cannot be done, through this binding.
 *
 * The response side had never been exercised here, and it did not work. After
 * the handler has run, Hono ignores a Response returned from middleware, so
 * every refusal on the way out was dropped and the caller received the body
 * the handler wrote, shaped for a contract they do not speak, with a 200. That
 * is the one outcome the runtime exists to prevent.
 */
import { createRuntime } from "@invariant-app/runtime";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { adapt, wrapFetch } from "./index.ts";

const PROGRAM = {
  irVersion: 2,
  api: "payments",
  currentLabel: "2026-09-20",
  current: "sha256:head",
  contracts: {
    "2026-01-01": {
      label: "2026-01-01",
      routes: [],
      sites: {
        "post /v1/batch": {
          request: [
            {
              k: "move",
              from: "/items/*/amount",
              to: "/items/*/amount_cents",
              c: "chg_a",
            },
          ],
          response: {
            "2xx": [
              { k: "move", from: "/amount_cents", to: "/amount", c: "chg_a" },
              { k: "enum", path: "/status", map: { paid: "succeeded" }, c: "chg_b" },
            ],
          },
        },
      },
      behaviors: [],
      retired: [],
    },
  },
};

function service(upstreamBody: string) {
  const inv = createRuntime({
    program: PROGRAM,
    identity: [
      { kind: "header" as const, name: "payments-version" },
      { kind: "default" as const, label: "2026-09-20" },
    ],
    limits: { maxMatches: 3 },
  });
  const app = new Hono();
  app.use("/v1/*", adapt({ runtime: inv }));
  app.post("/v1/batch", (c) =>
    c.body(upstreamBody, 200, { "content-type": "application/json" }),
  );
  return wrapFetch((request) => app.fetch(request), { runtime: inv });
}

const batch = (count: number) =>
  new Request("https://api.example.com/v1/batch", {
    method: "POST",
    headers: { "payments-version": "2026-01-01", "content-type": "application/json" },
    body: JSON.stringify({ items: Array.from({ length: count }, () => ({ amount: 1 })) }),
  });

describe("refusals through the Hono binding", () => {
  it("refuses a request wider than the fan-out cap as too large", async () => {
    const response = await service('{"amount_cents":1}')(batch(4));
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invariant_body_too_large");
  });

  it("refuses a response it cannot translate rather than sending it as is", async () => {
    const response = await service('{"amount_cents":1,"status":"disputed"}')(batch(1));
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain("invariant_response_not_translatable");
    expect(text).not.toContain("disputed");
    expect(response.headers.get("invariant-contract")).toBe("2026-01-01");
  });

  it("answers 502 when the provider's own response is not JSON", async () => {
    const response = await service("<html>oops</html>")(batch(1));
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invariant_response_not_translatable");
  });
});
