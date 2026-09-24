/**
 * A provider whose answer breaks off, as a crashing or redeployed server's
 * does, is the provider's failure and said to be.
 *
 * Found by the soak (proving/soak): an upstream that dropped its connection
 * halfway through a body the proxy had to translate was answered 500, the
 * proxy's own internal error, which pages whoever runs the proxy for
 * something only the provider can fix.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRuntime } from "@invariant-app/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProxy } from "./proxy.ts";
import { type Listening, serve } from "./server.ts";

const PROGRAM = {
  irVersion: 2,
  api: "payments",
  currentLabel: "new",
  current: "sha256:head",
  identity: [
    { kind: "header", name: "payments-version" },
    { kind: "default", label: "new" },
  ],
  contracts: {
    old: {
      label: "old",
      routes: [],
      sites: {
        "get /v1/payments": {
          response: {
            "2xx": [{ k: "move", from: "/amount_cents", to: "/amount", c: "chg_cents" }],
          },
        },
      },
      behaviors: [],
      retired: [],
    },
  },
};

const BODY = JSON.stringify({ id: "pay_1", amount_cents: 1234, note: "x".repeat(4096) });

let upstream: Server;
let proxy: Listening;

beforeAll(async () => {
  upstream = createServer((incoming, outgoing) => {
    outgoing.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(BODY)),
    });
    if (incoming.headers["chaos"] === "slow") {
      // Half now, the rest long after the proxy stopped waiting.
      outgoing.write(BODY.slice(0, 100));
      setTimeout(() => outgoing.end(BODY.slice(100)), 2_000).unref();
      return;
    }
    outgoing.write(BODY.slice(0, BODY.length / 2), () => incoming.socket.destroy());
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  proxy = await serve(
    createProxy({
      runtime: createRuntime({ program: PROGRAM }),
      upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      upstreamTimeoutMs: 500,
    }),
    { port: 0 },
  );
});

afterAll(async () => {
  await proxy.close();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

describe("an answer that breaks off", () => {
  it("is the provider's failure to an old caller whose answer is translated", async () => {
    const response = await fetch(`${proxy.url}/v1/payments`, {
      headers: { "payments-version": "old" },
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { type: "api_error", code: "invariant_upstream_unavailable" },
    });
  });

  it("is a timeout when the rest of it comes too late", async () => {
    const response = await fetch(`${proxy.url}/v1/payments`, {
      headers: { "payments-version": "old", chaos: "slow" },
    });
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({
      error: { code: "invariant_upstream_unavailable" },
    });
  });

  it("reaches a current caller cut short, as it was streamed", async () => {
    const response = await fetch(`${proxy.url}/v1/payments`);
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();
  });
});
