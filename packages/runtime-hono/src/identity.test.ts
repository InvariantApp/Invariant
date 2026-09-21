/**
 * A caller naming a contract that does not exist.
 *
 * The design says it three times: an unknown label is refused. The runtime
 * quietly ignored it instead and served the caller as current, so a typo in a
 * version header, or a label for a contract since retired from the program,
 * got the newest shape of every response with nothing to say why. That is the
 * exact breakage this product exists to prevent, arriving through its own
 * front door.
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
    "2026-01-01": { label: "2026-01-01", routes: [], sites: {}, behaviors: [] },
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
  app.get("/v1/payments", (c) => c.json({ data: [] }));
  return wrapFetch((request) => app.fetch(request), { runtime: inv });
}

const list = (version?: string) =>
  new Request("https://api.example.com/v1/payments", {
    headers: version ? { "payments-version": version } : {},
  });

describe("a contract nobody has heard of", () => {
  it("is refused, rather than silently served as current", async () => {
    const response = await service()(list("2026-01-O1"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invariant_contract_unsupported");
    // Naming the value is the whole help: a typo is obvious once it is quoted.
    expect(body.error.message).toContain("2026-01-O1");
  });

  it("still lets a caller who names no contract through, as the default", async () => {
    expect((await service()(list())).status).toBe(200);
  });

  it("still serves a contract that exists", async () => {
    expect((await service()(list("2026-01-01"))).status).toBe(200);
    expect((await service()(list("2026-09-20"))).status).toBe(200);
  });
});
