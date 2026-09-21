/**
 * A retired endpoint, as an old caller actually reaches it.
 *
 * `retire` exists so that a caller hitting an operation that is gone gets told
 * so, with whatever the provider said to use instead. The engine raised the
 * right error and this adapter never caught it, so every such request surfaced
 * as an unexplained 500 and the provider's guidance never reached anybody. The
 * op was tested and the path a real request takes was not.
 */
import { createRuntime } from "@invariant/runtime";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { adapt, wrapFetch } from "./index.ts";

const PROGRAM = {
  irVersion: 1,
  api: "payments",
  currentLabel: "2026-09-20",
  current: "sha256:head",
  contracts: {
    "2026-01-01": {
      label: "2026-01-01",
      routes: [],
      sites: {},
      behaviors: [],
      retired: [
        {
          method: "post",
          path: "/v1/charges/{id}/capture",
          guidance: "Use POST /v1/payments/{id}/confirm instead.",
          c: "chg_retired_capture",
        },
      ],
    },
  },
};

function service() {
  const inv = createRuntime({
    program: PROGRAM,
    identity: [
      { kind: "header" as const, name: "payments-version" },
      { kind: "default" as const, label: "2026-09-20" },
    ],
  });
  const app = new Hono();
  app.use("/v1/*", adapt({ runtime: inv }));
  app.post("/v1/charges/:id/capture", (c) => c.json({ ok: true }));
  return wrapFetch((request) => app.fetch(request), { runtime: inv });
}

const capture = (version: string) =>
  new Request("https://api.example.com/v1/charges/ch_1/capture", {
    method: "POST",
    headers: { "payments-version": version, "content-type": "application/json" },
    body: "{}",
  });

describe("an endpoint the provider retired", () => {
  it("refuses an old caller with 410 rather than an unexplained 500", async () => {
    const response = await service()(capture("2026-01-01"));
    expect(response.status).toBe(410);
  });

  it("hands the caller the provider's guidance", async () => {
    const response = await service()(capture("2026-01-01"));
    const body = (await response.json()) as { error: { message: string; code: string } };
    expect(body.error.code).toBe("invariant_endpoint_retired");
    expect(body.error.message).toContain("Use POST /v1/payments/{id}/confirm instead.");
  });
});
