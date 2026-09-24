/**
 * A connection a caller reuses, after a request whose body the proxy refused
 * without reading it to the end.
 *
 * Found by the soak (proving/soak): an old caller's body over the size the
 * proxy buffers was refused 413, and the rest of it held the connection, so
 * the next request the caller sent on it was never answered and the socket
 * was never closed.
 */
import { Agent, createServer, request, type Server } from "node:http";
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
        "post /v1/payments": {
          request: [{ k: "move", from: "/amount", to: "/amount_cents", c: "chg_cents" }],
        },
      },
      behaviors: [],
      retired: [],
    },
  },
};

let upstream: Server;
let proxy: Listening;

beforeAll(async () => {
  upstream = createServer((incoming, outgoing) => {
    incoming.resume();
    incoming.on("end", () => {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  proxy = await serve(
    createProxy({
      runtime: createRuntime({ program: PROGRAM, maxBodyBytes: 1024 }),
      upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    }),
    { port: 0 },
  );
});

afterAll(async () => {
  await proxy.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

function post(agent: Agent, body: string): Promise<{ status: number; reused: boolean }> {
  const { port } = new URL(proxy.url);
  return new Promise((resolve, reject) => {
    const call = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/v1/payments",
        agent,
        headers: {
          "payments-version": "old",
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
      },
      (response) => {
        response.resume();
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, reused: call.reusedSocket }),
        );
      },
    );
    call.setTimeout(5_000, () => call.destroy(new Error("no answer in 5s")));
    call.on("error", reject);
    call.end(body);
  });
}

describe("a connection after a body the proxy refused unread", () => {
  it("answers the next request the caller sends", async () => {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const refused = await post(
      agent,
      JSON.stringify({ amount: 1, note: "x".repeat(256 * 1024) }),
    );
    expect(refused.status).toBe(413);
    const next = await post(agent, JSON.stringify({ amount: 1 }));
    expect(next.status).toBe(200);
    agent.destroy();
  });
});
