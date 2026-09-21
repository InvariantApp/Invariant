import { describe, expect, it } from "vitest";
import { accessLogged } from "./access-log.ts";

describe("the access log", () => {
  it("says what was served, and never what was sent", async () => {
    const lines: Record<string, unknown>[] = [];
    let clock = 0;
    const handler = accessLogged(
      async () => {
        clock += 12.34;
        return new Response("{}", {
          status: 502,
          headers: { "invariant-contract": "2026-01-01", "invariant-error-id": "err_1" },
        });
      },
      (line) => lines.push(JSON.parse(line)),
      () => clock,
    );
    await handler(
      new Request("https://api.example.com/v1/payments/p_1?card=4242424242424242", {
        method: "POST",
        headers: { authorization: "Bearer sk_live_secret" },
        body: '{"amount":1}',
      }),
    );
    expect(lines).toEqual([
      {
        at: expect.any(String),
        method: "POST",
        path: "/v1/payments/p_1",
        status: 502,
        ms: 12.3,
        contract: "2026-01-01",
        errorId: "err_1",
      },
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/4242|sk_live|amount/);
  });
});
