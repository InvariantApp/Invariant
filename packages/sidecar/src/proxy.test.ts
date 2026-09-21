/**
 * The proxy, against an upstream it cannot see into.
 *
 * The upstream here is a plain function standing in for an API in any
 * language, which is the point: this proxy knows nothing about how the
 * provider is built. A separate test puts a real Python server behind it.
 *
 * The failure cases are held to the same standard as the working ones, because
 * this sits in the path of every request a provider serves.
 */
import { createRuntime, FOLDED_HEADER } from "@invariant/runtime";
import { describe, expect, it } from "vitest";
import { createProxy, targetFor } from "./proxy.ts";

const PROGRAM = {
  irVersion: 1,
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
                map: { pending: "pending", done: "done", review: "pending" },
                folded: ["review"],
                c: "chg_status",
              },
              { k: "move", from: "/amount_cents", to: "/amount", c: "chg_minor_units" },
            ],
          },
        },
      },
      behaviors: [],
      retired: [
        {
          method: "post",
          path: "/v1/refunds",
          guidance: "Use POST /v1/payments/{id}/reverse instead.",
          c: "chg_retired_refunds",
        },
        {
          method: "post",
          path: "/v1/{name}:cancel",
          c: "chg_retired_cancel",
        },
      ],
    },
  },
};

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** An upstream that records what it was sent and answers as told. */
function upstream(answer: (seen: Seen) => Response | Promise<Response>) {
  const calls: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const seen: Seen = {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: request.body ? await request.text() : "",
    };
    calls.push(seen);
    return answer(seen);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function proxyWith(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return createProxy({
    runtime: createRuntime({
      program: PROGRAM,
      identity: [
        { kind: "header", name: "payments-version" },
        { kind: "default", label: "2026-09-20" },
      ],
    }),
    upstream: "http://api.internal:8080",
    fetch: fetchImpl,
    ...extra,
  });
}

const jsonAnswer = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const post = (path: string, body: unknown, version?: string, headers = {}) =>
  new Request(`https://api.example.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(version ? { "payments-version": version } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });

describe("bodies the program does not describe", () => {
  it("passes a form request on untouched rather than parsing it as JSON", async () => {
    const { fetchImpl, calls } = upstream(() => jsonAnswer({ amount_cents: 1 }));
    const response = await proxyWith(fetchImpl)(
      new Request("https://api.example.com/v1/charges", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "payments-version": "2026-01-01",
        },
        body: "amount=500",
      }),
    );
    expect(response.status).toBe(200);
    expect(calls[0]?.body).toBe("amount=500");
  });

  it("refuses a request encoding it cannot decode", async () => {
    const { fetchImpl, calls } = upstream(() => jsonAnswer({}));
    const response = await proxyWith(fetchImpl)(
      post("/v1/charges", { amount: 500 }, "2026-01-01", {
        "content-encoding": "compress",
      }),
    );
    expect(response.status).toBe(415);
    expect(calls).toHaveLength(0);
  });
});

describe("an old caller, through the proxy", () => {
  it("reaches the new endpoint in the new shape", async () => {
    const { fetchImpl, calls } = upstream(() =>
      jsonAnswer({ id: "pay_1", amount_cents: 500, status: "done" }),
    );
    await proxyWith(fetchImpl)(post("/v1/charges", { amount: 500 }, "2026-01-01"));

    expect(calls[0]?.url).toBe("http://api.internal:8080/v1/payments");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ amount_cents: 500 });
  });

  it("is answered in the shape it was written against", async () => {
    const { fetchImpl } = upstream(() =>
      jsonAnswer({ id: "pay_1", amount_cents: 500, status: "done" }),
    );
    const response = await proxyWith(fetchImpl)(
      post("/v1/charges", { amount: 500 }, "2026-01-01"),
    );

    expect(await response.json()).toEqual({ id: "pay_1", amount: 500, status: "done" });
    expect(response.headers.get("invariant-contract")).toBe("2026-01-01");
  });

  it("is told when a value it was shown is a stand-in", async () => {
    const { fetchImpl } = upstream(() =>
      jsonAnswer({ id: "pay_1", amount_cents: 500, status: "review" }),
    );
    const response = await proxyWith(fetchImpl)(
      post("/v1/charges", { amount: 500 }, "2026-01-01"),
    );

    expect(((await response.json()) as { status: string }).status).toBe("pending");
    expect(response.headers.get(FOLDED_HEADER)).toBe("status");
  });

  it("is told plainly that an endpoint is gone, and what to use instead", async () => {
    const { fetchImpl, calls } = upstream(() => jsonAnswer({}));
    const response = await proxyWith(fetchImpl)(post("/v1/refunds", {}, "2026-01-01"));

    expect(response.status).toBe(410);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invariant_endpoint_retired");
    expect(body.error.message).toContain("Use POST /v1/payments/{id}/reverse instead.");
    // The provider never sees a request for an operation that no longer exists.
    expect(calls).toHaveLength(0);
  });

  // Google's APIs, and every API following its design guide, name custom
  // methods with a colon after a path parameter. Rig C found a retired one
  // reaching the provider as a 404 instead of being answered 410.
  it("is told a custom method is gone when the parameter shares its segment", async () => {
    const { fetchImpl, calls } = upstream(() => jsonAnswer({}));
    const response = await proxyWith(fetchImpl)(
      post("/v1/operations-42:cancel", {}, "2026-01-01"),
    );

    expect(response.status).toBe(410);
    expect(calls).toHaveLength(0);
  });

  it("is refused for a contract that does not exist", async () => {
    const { fetchImpl, calls } = upstream(() => jsonAnswer({}));
    const response = await proxyWith(fetchImpl)(post("/v1/payments", {}, "1999-01-01"));
    // Served as current, this caller would get the newest shape of everything
    // with no clue why. Refused, they are told the one thing that is wrong.
    expect(response.status).toBe(400);
    expect(
      ((await response.json()) as { error: { message: string } }).error.message,
    ).toContain("1999-01-01");
    expect(calls).toHaveLength(0);
  });
});

describe("numbers a double cannot hold", () => {
  // Found by the Rig F fuzzers. The provider was sent {"amount_cents":null}.
  it("reach the provider, and come back, exactly as they were written", async () => {
    const { fetchImpl, calls } = upstream(
      () =>
        new Response('{"amount_cents":1e400,"status":"pending"}', {
          headers: { "content-type": "application/json" },
        }),
    );
    const response = await proxyWith(fetchImpl)(
      new Request("https://api.example.com/v1/charges", {
        method: "POST",
        headers: { "content-type": "application/json", "payments-version": "2026-01-01" },
        body: '{"amount":1e400}',
      }),
    );

    expect(calls[0]?.body).toBe('{"amount_cents":1e400}');
    expect(await response.text()).toBe('{"status":"pending","amount":1e400}');
  });
});

describe("a current caller, through the proxy", () => {
  it("is passed through untouched, body and all", async () => {
    const { fetchImpl, calls } = upstream(() =>
      jsonAnswer({ id: "pay_1", amount_cents: 500, status: "review" }),
    );
    const response = await proxyWith(fetchImpl)(
      post("/v1/payments", { amount_cents: 500 }, "2026-09-20"),
    );

    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ amount_cents: 500 });
    expect(await response.json()).toEqual({
      id: "pay_1",
      amount_cents: 500,
      status: "review",
    });
    expect(response.headers.get(FOLDED_HEADER)).toBeNull();
    expect(response.headers.get("invariant-contract")).toBeNull();
  });
});

describe("what the proxy will not let through", () => {
  it("never lets a caller choose a different host", () => {
    const base = new URL("http://api.internal:8080");
    expect(targetFor(base, "//evil.example/steal", "")?.host).toBe("api.internal:8080");
  });

  it("never lets a path climb out of the provider's base path", () => {
    const base = new URL("http://api.internal:8080/api");
    expect(targetFor(base, "/v1/payments", "")?.pathname).toBe("/api/v1/payments");
    // A path arriving from a parsed URL is already normalised, but this check
    // does not rely on that: an escape is refused outright, not rewritten.
    expect(targetFor(base, "/../admin", "")).toBeUndefined();
  });

  it("drops headers claiming to be internal before the provider sees them", async () => {
    const { fetchImpl, calls } = upstream(() => jsonAnswer({}));
    await proxyWith(fetchImpl)(
      post("/v1/payments", {}, "2026-09-20", {
        "x-invariant-contract-hint": "2026-01-01",
      }),
    );
    expect(
      Object.keys(calls[0]?.headers ?? {}).some((h) => h.startsWith("x-invariant")),
    ).toBe(false);
  });

  it("does not pass on headers that belong to one connection", async () => {
    const { fetchImpl, calls } = upstream(() => jsonAnswer({}));
    await proxyWith(fetchImpl)(
      post("/v1/payments", {}, "2026-09-20", {
        connection: "keep-alive, x-private-hop",
        "keep-alive": "timeout=5",
        "x-private-hop": "secret",
        te: "trailers",
      }),
    );
    const sent = calls[0]?.headers ?? {};
    expect(sent["keep-alive"]).toBeUndefined();
    expect(sent["x-private-hop"]).toBeUndefined();
    expect(sent["te"]).toBeUndefined();
  });

  it("refuses a body over the limit even when no length was declared", async () => {
    const { fetchImpl, calls } = upstream(() => jsonAnswer({}));
    const big = "x".repeat(2048);
    const streamed = new Request("https://api.example.com/v1/charges", {
      method: "POST",
      headers: { "content-type": "application/json", "payments-version": "2026-01-01" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ amount: big })));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    const response = await proxyWith(fetchImpl, { maxBodyBytes: 1024 })(streamed);

    expect(response.status).toBe(413);
    expect(calls).toHaveLength(0);
  });
});

describe("when the provider misbehaves", () => {
  it("says the API could not be reached, rather than hanging", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const response = await proxyWith(failing)(post("/v1/payments", {}, "2026-09-20"));
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "invariant_upstream_unavailable",
    );
  });

  it("gives up after the timeout and says so", async () => {
    const slow = ((_input: unknown, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })),
        );
      })) as unknown as typeof fetch;
    const response = await proxyWith(slow, { upstreamTimeoutMs: 50 })(
      post("/v1/payments", {}, "2026-09-20"),
    );
    expect(response.status).toBe(504);
  });

  it("passes an HTML error page through rather than mangling it", async () => {
    const { fetchImpl } = upstream(
      () =>
        new Response("<h1>Service Unavailable</h1>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    const response = await proxyWith(fetchImpl)(
      post("/v1/charges", { amount: 1 }, "2026-01-01"),
    );
    expect(await response.text()).toBe("<h1>Service Unavailable</h1>");
  });

  it("refuses to hand an old caller a body it cannot express", async () => {
    const { fetchImpl } = upstream(() =>
      jsonAnswer({ id: "pay_1", amount_cents: 1, status: "unheard_of" }),
    );
    const response = await proxyWith(fetchImpl)(
      post("/v1/charges", { amount: 1 }, "2026-01-01"),
    );
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "invariant_response_not_translatable",
    );
  });

  it("does not follow a redirect on the caller's behalf", async () => {
    const { fetchImpl } = upstream(
      () =>
        new Response(null, { status: 302, headers: { location: "https://elsewhere/x" } }),
    );
    const response = await proxyWith(fetchImpl)(post("/v1/payments", {}, "2026-09-20"));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://elsewhere/x");
  });

  it("does not pass on an encoding the body no longer has", async () => {
    const { fetchImpl } = upstream(() =>
      jsonAnswer({ ok: true }, 200, { "content-encoding": "gzip" }),
    );
    const response = await proxyWith(fetchImpl)(post("/v1/payments", {}, "2026-09-20"));
    expect(response.headers.get("content-encoding")).toBeNull();
  });
});

describe("the health check", () => {
  it("reports the build this proxy is running, without touching the provider", async () => {
    const { fetchImpl, calls } = upstream(() => jsonAnswer({}));
    const response = await proxyWith(fetchImpl)(
      new Request("https://api.example.com/__invariant/health"),
    );
    expect(await response.json()).toEqual({
      status: "ok",
      current: "2026-09-20",
      digest: "sha256:head",
    });
    expect(calls).toHaveLength(0);
  });
});
