/**
 * A folded value, as a caller actually receives it.
 *
 * A fold is the one transform that shows a caller something untrue. The API
 * produced a status their contract never named, and they are shown one it does
 * name instead. That is better than a response they cannot parse, and it is
 * still a stand-in, and a caller has no way to tell from the body alone.
 *
 * So the response says so. The header appears only when a fold fired, which
 * makes its absence mean something: no header, and every value in the body is
 * one the API really produced.
 */
import { createRuntime, FOLDED_HEADER } from "@invariant-app/runtime";
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
        "get /v1/payments/{id}": {
          response: {
            "2xx": [
              {
                k: "enum",
                path: "/status",
                map: { pending: "pending", done: "done", pending_review: "pending" },
                folded: ["pending_review"],
                c: "chg_status_vocabulary",
              },
            ],
          },
        },
      },
      behaviors: [],
    },
  },
};

function service(status: string) {
  const inv = createRuntime({
    program: PROGRAM,
    identity: [
      { kind: "header" as const, name: "payments-version" },
      { kind: "default" as const, label: "2026-09-20" },
    ],
  });
  const app = new Hono();
  app.use("/v1/*", adapt({ runtime: inv }));
  app.get("/v1/payments/:id", (c) => c.json({ id: c.req.param("id"), status }));
  return wrapFetch((request) => app.fetch(request), { runtime: inv });
}

const get = (version?: string) =>
  new Request("https://api.example.com/v1/payments/pay_1", {
    headers: version ? { "payments-version": version } : {},
  });

describe("a status the old contract never named", () => {
  it("reaches the old caller as the value the provider chose", async () => {
    const response = await service("pending_review")(get("2026-01-01"));
    expect(await response.json()).toEqual({ id: "pay_1", status: "pending" });
  });

  it("tells the caller the value was a stand-in", async () => {
    const response = await service("pending_review")(get("2026-01-01"));
    expect(response.headers.get(FOLDED_HEADER)).toBe("status");
  });

  it("says nothing when the value was real", async () => {
    // `pending` exists in both contracts. It maps to itself, and the caller was
    // shown exactly what the API produced, so there is nothing to disclose.
    const response = await service("pending")(get("2026-01-01"));
    expect(await response.json()).toEqual({ id: "pay_1", status: "pending" });
    expect(response.headers.get(FOLDED_HEADER)).toBeNull();
  });

  it("does not fold for a caller on the current contract", async () => {
    const response = await service("pending_review")(get("2026-09-20"));
    expect(await response.json()).toEqual({ id: "pay_1", status: "pending_review" });
    expect(response.headers.get(FOLDED_HEADER)).toBeNull();
  });
});
