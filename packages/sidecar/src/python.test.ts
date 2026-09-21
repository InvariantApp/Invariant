/**
 * A real Python API, behind the real proxy, over real sockets.
 *
 * This is the claim the sidecar exists to make true: a provider whose API is
 * not written in Node can put Invariant in front of it without changing a line
 * of their own code. The Python server below serves only the current contract
 * and has never heard of Invariant. Every old caller reaches it through the
 * proxy, and the proxy is the only thing that knows there was an old contract
 * at all.
 *
 * The in-memory tests cover what a request becomes. These cover what only a
 * network can: streaming a large body through without holding it, the proxy
 * surviving the provider going away, and the socket lifecycle around both.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRuntime, FOLDED_HEADER } from "@invariant/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProxy } from "./proxy.ts";
import { type Listening, serve } from "./server.ts";

const PROGRAM = {
  irVersion: 2,
  api: "payments",
  currentLabel: "2026-09-20",
  current: "sha256:head",
  contracts: {
    "2026-01-01": {
      label: "2026-01-01",
      routes: [
        {
          from: { method: "post", path: "/v1/charges" },
          to: { method: "post", path: "/v1/payments" },
          c: "chg_rename_charges",
        },
      ],
      sites: {
        "post /v1/payments": {
          request: [
            { k: "move", from: "/amount", to: "/amount_cents", c: "chg_minor_units" },
          ],
          response: {
            "2xx": [
              {
                k: "enum",
                path: "/status",
                map: { done: "done", review: "done" },
                folded: ["review"],
                c: "chg_status",
              },
              { k: "move", from: "/amount_cents", to: "/amount", c: "chg_minor_units" },
            ],
          },
        },
      },
      behaviors: [],
    },
  },
};

let python: ChildProcess;
let proxy: Listening;

async function startPython(): Promise<number> {
  python = spawn(
    "python3",
    [fileURLToPath(new URL("./python-upstream.py", import.meta.url))],
    {
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  return new Promise((resolve, reject) => {
    python.once("error", reject);
    python.stdout?.once("data", (chunk: Buffer) =>
      resolve(Number(chunk.toString().trim())),
    );
  });
}

beforeAll(async () => {
  const port = await startPython();
  proxy = await serve(
    createProxy({
      runtime: createRuntime({
        program: PROGRAM,
        identity: [
          { kind: "header", name: "payments-version" },
          { kind: "default", label: "2026-09-20" },
        ],
        maxBodyBytes: 1024 * 1024,
      }),
      upstream: `http://127.0.0.1:${port}`,
      upstreamTimeoutMs: 5000,
    }),
    { port: 0 },
  );
});

afterAll(async () => {
  await proxy?.close();
  python?.kill();
});

const call = (path: string, init: RequestInit & { version?: string } = {}) => {
  const { version, headers, ...rest } = init;
  return fetch(`${proxy.url}${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(version ? { "payments-version": version } : {}),
      ...(headers as Record<string, string>),
    },
  });
};

describe("a Python API that has never heard of Invariant", () => {
  it("serves a caller written against a contract it no longer speaks", async () => {
    const response = await call("/v1/charges", {
      method: "POST",
      version: "2026-01-01",
      body: JSON.stringify({ amount: 500 }),
    });
    const body = (await response.json()) as Record<string, unknown>;

    // The old caller sent `amount` to `/v1/charges`; Python received
    // `amount_cents` at `/v1/payments`.
    expect(body["received"]).toEqual({ amount_cents: 500 });
    // And the old caller got `amount` back, in the shape they wrote against.
    expect(body["amount"]).toBe(500);
    expect(body["amount_cents"]).toBeUndefined();
    expect(response.headers.get("invariant-contract")).toBe("2026-01-01");
  });

  it("marks a value the old contract could not name", async () => {
    const response = await call("/v1/charges", {
      method: "POST",
      version: "2026-01-01",
      body: JSON.stringify({ amount: 5000 }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("done");
    expect(response.headers.get(FOLDED_HEADER)).toBe("status");
  });

  it("leaves a current caller exactly as it was", async () => {
    const response = await call("/v1/payments", {
      method: "POST",
      version: "2026-09-20",
      body: JSON.stringify({ amount_cents: 500 }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["amount_cents"]).toBe(500);
    expect(response.headers.get("invariant-contract")).toBeNull();
  });

  it("never lets a caller hand the provider an internal header", async () => {
    const response = await call("/v1/payments", {
      method: "POST",
      version: "2026-09-20",
      headers: { "x-invariant-contract-hint": "2026-01-01" },
      body: JSON.stringify({ amount_cents: 1 }),
    });
    expect(
      ((await response.json()) as Record<string, unknown>)["saw_internal_header"],
    ).toBe(false);
  });
});

describe("bodies the proxy has no work for", () => {
  it("streams an upload three times the buffering limit straight through", async () => {
    // The limit applies to bodies the proxy has to rewrite. Anything else is
    // passed through as it arrives, so a large upload costs nothing here.
    const upload = "a".repeat(3 * 1024 * 1024);
    const response = await call("/v1/upload", {
      method: "POST",
      version: "2026-09-20",
      headers: { "content-type": "application/octet-stream" },
      body: upload,
    });
    expect(((await response.json()) as { bytes: number }).bytes).toBe(upload.length);
  });

  it("streams a large response back intact", async () => {
    const response = await call("/v1/big", { version: "2026-09-20" });
    const body = (await response.json()) as { items: string[] };
    expect(body.items).toHaveLength(20000);
  });

  it("passes the provider's own error page through untouched", async () => {
    const response = await call("/down-page");
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("<h1>maintenance</h1>");
  });
});

describe("the proxy around the provider", () => {
  it("reports what it is running without troubling the provider", async () => {
    const response = await fetch(`${proxy.url}/__invariant/health`);
    expect(await response.json()).toMatchObject({ status: "ok", current: "2026-09-20" });
  });

  it("says the API is unreachable when it goes away, and keeps serving", async () => {
    python.kill();
    await new Promise((resolve) => python.once("exit", resolve));

    const response = await call("/v1/payments", {
      method: "POST",
      version: "2026-09-20",
      body: "{}",
    });
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "invariant_upstream_unavailable",
    );
    // The proxy itself is still up and answering.
    expect((await fetch(`${proxy.url}/__invariant/health`)).status).toBe(200);
  });
});
