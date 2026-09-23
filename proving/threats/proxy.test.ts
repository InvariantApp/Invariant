/**
 * The proxy, attacked from the network: request smuggling, header injection,
 * choosing where it connects, spoofed contract labels, and bodies built to
 * make it work.
 *
 * Every test here talks to `invariant-sidecar` started from its CLI on a local
 * port, in front of an upstream that records what reaches it. The claim each
 * test checks is the one a provider relies on: what the caller sent either
 * arrives as one request the proxy understood, under the API it fronts, or
 * nothing arrives at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  firstStatus,
  lenientUpstream,
  rawExchange,
  recordingUpstream,
  refusedSidecar,
  type Sidecar,
  startSidecar,
  type Upstream,
} from "./harness.ts";

const OLD = "2026-01-01";
const header = (name: string) => ({
  in: "header",
  name,
  style: "simple",
  explode: false,
  type: "string",
});
const query = (name: string) => ({
  in: "query",
  name,
  style: "form",
  explode: true,
  type: "string",
});

/** One old contract: a renamed amount, a list whose items changed, a query parameter that became a header. */
const PROGRAM = {
  irVersion: 2,
  api: "threats",
  current: "sha256:threats",
  currentLabel: "2026-09-01",
  identity: [
    { kind: "header", name: "threats-version" },
    { kind: "default", label: "2026-09-01" },
  ],
  contracts: {
    [OLD]: {
      label: OLD,
      routes: [],
      behaviors: [],
      retired: [],
      sites: {
        "post /v1/items": {
          request: [
            { k: "move", from: "/amount", to: "/amount_cents", c: "chg_cents" },
            {
              k: "move",
              from: "/groups/*/lines/*/qty",
              to: "/groups/*/lines/*/quantity",
              c: "chg_quantity",
            },
          ],
          response: {
            "2xx": [{ k: "move", from: "/amount_cents", to: "/amount", c: "chg_cents" }],
          },
        },
        "get /v1/notes": {
          envelope: {
            instrs: [
              { k: "move", from: "/@query/note", to: "/@header/x-note", c: "chg_note" },
            ],
            params: { old: [query("note")], new: [header("x-note")] },
            body: false,
          },
        },
      },
    },
  },
};

let upstream: Upstream;
let proxy: Sidecar;
/** Where an attacker would like the proxy to connect instead. */
let internal: Upstream;

beforeAll(async () => {
  upstream = await recordingUpstream((arrival) =>
    arrival.url.endsWith("/redirect")
      ? { status: 302, headers: { location: `${internal.url}/latest/meta-data` } }
      : { body: arrival.body || '{"ok":true}' },
  );
  internal = await recordingUpstream();
  proxy = await startSidecar(PROGRAM, {
    upstream: `${upstream.url}/api`,
    maxBodyBytes: 64 * 1024,
  });
});

afterAll(async () => {
  await proxy?.stop();
  await upstream?.close();
  await internal?.close();
});

beforeEach(() => {
  upstream.seen.length = 0;
  internal.seen.length = 0;
});

/** A request whose framing only a lenient parser would read. */
const smuggles: [string, string][] = [
  [
    "Content-Length and Transfer-Encoding together",
    "POST /v1/items HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\nGET /admin HTTP/1.1\r\nHost: x\r\n\r\n",
  ],
  [
    "two Content-Lengths that disagree",
    "POST /v1/items HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\nContent-Length: 40\r\n\r\n{}GET /admin HTTP/1.1\r\nHost: x\r\n\r\n",
  ],
  [
    "Transfer-Encoding with a space before its colon",
    "POST /v1/items HTTP/1.1\r\nHost: x\r\nTransfer-Encoding : chunked\r\n\r\n0\r\n\r\n",
  ],
  [
    "a Transfer-Encoding that is not chunked last",
    "POST /v1/items HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked, identity\r\n\r\n0\r\n\r\n",
  ],
  [
    "a chunk size that is not hexadecimal",
    "POST /v1/items HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n{}\r\n0\r\n\r\n",
  ],
  [
    "a header line ended by a bare line feed",
    "GET /v1/items HTTP/1.1\r\nHost: x\r\nX-A: a\nInjected: b\r\n\r\n",
  ],
  [
    "a header value holding a bare carriage return",
    "GET /v1/items HTTP/1.1\r\nHost: x\r\nX-A: a\rInjected: b\r\n\r\n",
  ],
  [
    "a header value holding a NUL",
    "GET /v1/items HTTP/1.1\r\nHost: x\r\nX-A: a\u0000b\r\n\r\n",
  ],
];

describe("request smuggling", () => {
  it.each(smuggles)(
    "%s is refused, and nothing reaches the upstream",
    async (_name, text) => {
      const answer = await rawExchange(proxy.port, [text]);
      expect(firstStatus(answer)).toBe(400);
      expect(upstream.seen).toEqual([]);
    },
  );

  it("forwards a pipelined pair as the two requests they are, both inside the API", async () => {
    // Framing the proxy does understand is re-framed by it on the way out, so
    // the upstream never has to agree with the caller about where one ends.
    const answer = await rawExchange(proxy.port, [
      "POST /v1/items HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}GET /v1/other HTTP/1.1\r\nHost: x\r\n\r\n",
    ]);
    expect(answer.match(/HTTP\/1\.1 200/g)).toHaveLength(2);
    expect(upstream.seen.map((arrival) => `${arrival.method} ${arrival.url}`)).toEqual([
      "POST /api/v1/items",
      "GET /api/v1/other",
    ]);
  });

  it("does not let an Upgrade handshake carry a second request past the proxy", async () => {
    // The upstream here answers `Upgrade: websocket` on an ordinary route as a
    // request and keeps reading, as most servers that are not Node's do.
    // Before the fix the proxy piped the caller's socket to the upstream's as
    // soon as the handshake was sent, and `GET /admin/secrets` then reached
    // the upstream outside `/api`, with a forged engine header, unexamined.
    const lenient = await lenientUpstream();
    const front = await startSidecar(PROGRAM, { upstream: `${lenient.url}/api` });
    const handshake =
      "GET /v1/stream HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n";
    const smuggled =
      "GET /admin/secrets HTTP/1.1\r\nHost: x\r\nX-Invariant-Contract-Hint: forged\r\n\r\n";
    try {
      // Sent after the upstream has had time to answer, and in the same packet
      // as the handshake, before it could have.
      for (const chunks of [[handshake, smuggled], [handshake + smuggled]]) {
        lenient.lines.length = 0;
        const answer = await rawExchange(front.port, chunks, { gapMs: 300 });
        expect(firstStatus(answer)).toBe(200);
        expect(answer.match(/HTTP\/1\.1 /g)).toHaveLength(1);
        expect(lenient.lines).toEqual(["GET /api/v1/stream HTTP/1.1"]);
      }
    } finally {
      await front.stop();
      await lenient.close();
    }
  });

  it("still passes a WebSocket through once the upstream agrees to switch", async () => {
    const lenient = await lenientUpstream({ switchProtocols: true });
    const front = await startSidecar(PROGRAM, { upstream: `${lenient.url}/api` });
    try {
      const answer = await rawExchange(
        front.port,
        [
          "GET /v1/stream HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
          "frames after the switch",
        ],
        { gapMs: 300 },
      );
      expect(firstStatus(answer)).toBe(101);
      expect(answer).toContain("echo: frames after the switch");
    } finally {
      await front.stop();
      await lenient.close();
    }
  });

  it("answers a request to switch to HTTP/2 in cleartext as if it had not asked", async () => {
    // An upstream that accepted `h2c` would take HTTP/2 frames naming any
    // path from the caller, so the upgrade is never passed on.
    const answer = await rawExchange(proxy.port, [
      "GET /v1/items HTTP/1.1\r\nHost: x\r\nConnection: Upgrade, HTTP2-Settings\r\nUpgrade: h2c\r\nHTTP2-Settings: AAMAAABkAARAAAAAAAIAAAAA\r\n\r\n",
    ]);
    expect(firstStatus(answer)).toBe(200);
    expect(upstream.seen).toHaveLength(1);
    expect(upstream.seen[0]?.headers["upgrade"]).toBeUndefined();
    expect(upstream.seen[0]?.headers["http2-settings"]).toBeUndefined();
  });
});

describe("header injection", () => {
  it("refuses a value that would break a header line when a program moves it into one", async () => {
    const answer = await fetch(`${proxy.url}/v1/notes?note=a%0D%0AHost:%20evil.example`, {
      headers: { "threats-version": OLD },
    });
    expect(answer.status).toBe(400);
    expect(((await answer.json()) as { error: { code: string } }).error.code).toBe(
      "invariant_request_not_translatable",
    );
    expect(upstream.seen).toEqual([]);
  });

  it("moves a plain value into the header as asked", async () => {
    const answer = await fetch(`${proxy.url}/v1/notes?note=hello`, {
      headers: { "threats-version": OLD },
    });
    expect(answer.status).toBe(200);
    expect(upstream.seen[0]?.headers["x-note"]).toBe("hello");
  });

  it("refuses headers larger than any real request sends, before reading a body", async () => {
    const answer = await rawExchange(proxy.port, [
      `GET /v1/items HTTP/1.1\r\nHost: x\r\nX-Big: ${"a".repeat(70_000)}\r\n\r\n`,
    ]);
    expect(firstStatus(answer)).toBe(431);
    expect(upstream.seen).toEqual([]);
  });

  it("answers a Host no URL can hold with 400, not 500", async () => {
    const answer = await rawExchange(proxy.port, [
      "GET /v1/items HTTP/1.1\r\nHost: a b\r\n\r\n",
    ]);
    expect(firstStatus(answer)).toBe(400);
    expect(upstream.seen).toEqual([]);
  });

  it("drops every header a caller forges in the engine's name", async () => {
    await fetch(`${proxy.url}/v1/items`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "threats-version": OLD,
        "x-invariant-contract-hint": "2026-09-01",
        "x-invariant-anything": "forged",
      },
      body: '{"amount":5}',
    });
    const names =
      upstream.seen[0]?.rawHeaders.filter((_, index) => index % 2 === 0) ?? [];
    expect(names.filter((name) => name.toLowerCase().startsWith("x-invariant-"))).toEqual(
      [],
    );
  });
});

/**
 * Headers a program may never address, and the proxy with a program that
 * tries: it refuses to start, so no request is ever served by it.
 */
const DENIED = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "x-api-key",
  "x-hub-signature-256",
  "x-client-secret",
];

describe("the headers no program may touch", () => {
  it.each(DENIED)(
    "the proxy will not start with a program that moves %s",
    async (name) => {
      const program = structuredClone(PROGRAM) as typeof PROGRAM;
      (program.contracts[OLD].sites as Record<string, unknown>)["get /v1/notes"] = {
        envelope: {
          instrs: [
            { k: "move", from: `/@header/${name}`, to: "/@header/x-moved", c: "chg_x" },
          ],
          params: { old: [header(name)], new: [header("x-moved")] },
          body: false,
        },
      };
      const refused = await refusedSidecar(program, { upstream: upstream.url });
      expect(refused.code).toBe(1);
      expect(refused.output).toMatch(
        new RegExp(`${name} header, which no program may touch`),
      );
    },
  );

  it("passes a caller's credentials through an adapted request exactly as sent", async () => {
    const credential = `Bearer ${"t".repeat(8)}.${Date.now()}`;
    await fetch(`${proxy.url}/v1/items`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "threats-version": OLD,
        authorization: credential,
      },
      body: '{"amount":5}',
    });
    expect(upstream.seen[0]?.headers["authorization"]).toBe(credential);
    expect(JSON.parse(upstream.seen[0]?.body ?? "{}")).toEqual({ amount_cents: 5 });
  });
});

describe("spoofed contract labels", () => {
  it("refuses a label no contract has, in the provider's shape, before the upstream", async () => {
    const answer = await fetch(`${proxy.url}/v1/items`, {
      method: "POST",
      headers: { "content-type": "application/json", "threats-version": "2099-01-01" },
      body: '{"amount":5}',
    });
    expect(answer.status).toBe(400);
    expect(answer.headers.get("invariant-error-id")).toBeTruthy();
    expect(((await answer.json()) as { error: { code: string } }).error.code).toBe(
      "invariant_contract_unsupported",
    );
    expect(upstream.seen).toEqual([]);
  });

  it.each([
    ["__proto__"],
    ["constructor"],
    ["toString"],
    ["hasOwnProperty"],
    ["../2026-01-01"],
  ])("refuses the label %s rather than reading it off an object", async (label) => {
    const answer = await fetch(`${proxy.url}/v1/items`, {
      method: "POST",
      headers: { "content-type": "application/json", "threats-version": label },
      body: '{"amount":5}',
    });
    expect(answer.status).toBe(400);
    expect(upstream.seen).toEqual([]);
  });
});

describe("choosing where the proxy connects", () => {
  it.each([
    [
      "an absolute-form request line",
      "GET http://169.254.169.254/latest HTTP/1.1\r\nHost: x\r\n\r\n",
      "/api/latest",
    ],
    [
      "a scheme-relative path",
      "GET //169.254.169.254/latest HTTP/1.1\r\nHost: x\r\n\r\n",
      "/api/latest",
    ],
    [
      "a Host naming somewhere else",
      "GET /v1/items HTTP/1.1\r\nHost: 169.254.169.254\r\n\r\n",
      "/api/v1/items",
    ],
    [
      "a Host carrying a path",
      "GET /v1/items HTTP/1.1\r\nHost: evil.example/steal?\r\n\r\n",
      "/api/v1/items",
    ],
    [
      "X-Forwarded-Host and Forwarded",
      "GET /v1/items HTTP/1.1\r\nHost: x\r\nX-Forwarded-Host: 169.254.169.254\r\nForwarded: host=169.254.169.254\r\n\r\n",
      "/api/v1/items",
    ],
    [
      "a path that climbs out of the base",
      "GET /../admin HTTP/1.1\r\nHost: x\r\n\r\n",
      "/api/admin",
    ],
    [
      "dot segments written in percent-encoding",
      "GET /%2e%2e/admin HTTP/1.1\r\nHost: x\r\n\r\n",
      "/api/admin",
    ],
    [
      "backslashes a server may read as slashes",
      "GET /\\..\\admin HTTP/1.1\r\nHost: x\r\n\r\n",
      "/api/admin",
    ],
  ])(
    "%s still reaches only the configured upstream, under its base path",
    async (_name, text, path) => {
      const answer = await rawExchange(proxy.port, [text]);
      expect(firstStatus(answer)).toBe(200);
      expect(upstream.seen.map((arrival) => arrival.url)).toEqual([path]);
      expect(upstream.seen[0]?.headers["host"]).toBe(new URL(upstream.url).host);
      expect(internal.seen).toEqual([]);
    },
  );

  it.each([
    ["an escaped slash after dots", "/..%2fadmin"],
    ["an escaped backslash after dots", "/..%5cadmin"],
    ["escaped dots and an escaped slash", "/%2e%2e%2fadmin"],
    ["the same through an upgrade", "/..%2fadmin"],
  ])(
    "refuses %s, which a server that decodes before routing reads as leaving the base",
    async (name, path) => {
      const upgrade = name.includes("upgrade")
        ? "Connection: Upgrade\r\nUpgrade: websocket\r\n"
        : "";
      const answer = await rawExchange(proxy.port, [
        `GET ${path} HTTP/1.1\r\nHost: x\r\n${upgrade}\r\n`,
      ]);
      expect(firstStatus(answer)).toBe(400);
      expect(upstream.seen).toEqual([]);
    },
  );

  it("passes a redirect to the caller rather than following it inside the network", async () => {
    const answer = await fetch(`${proxy.url}/v1/redirect`, { redirect: "manual" });
    expect(answer.status).toBe(302);
    expect(answer.headers.get("location")).toBe(`${internal.url}/latest/meta-data`);
    expect(internal.seen).toEqual([]);
  });

  it.each([
    ["file:///etc/passwd", "must be http or https"],
    ["gopher://127.0.0.1:6379/_INFO", "must be http or https"],
    ["ftp://127.0.0.1/", "must be http or https"],
    ["data:text/plain,hello", "must be http or https"],
    ["not a url", "is not a URL"],
  ])("will not start in front of the upstream %s", async (target, message) => {
    const refused = await refusedSidecar(PROGRAM, { upstream: target });
    expect(refused.code).toBe(1);
    expect(refused.output).toContain(message);
  });

  it("will not send its control-plane token anywhere but https", async () => {
    const refused = await refusedSidecar(PROGRAM, {
      upstream: upstream.url,
      controlPlane: { url: "http://collector.example", tokenEnv: "INVARIANT_TOKEN" },
    });
    expect(refused.code).toBe(1);
    expect(refused.output).toContain('"controlPlane.url" must be https');
  });

  it("will not take a token written into its configuration", async () => {
    const refused = await refusedSidecar(PROGRAM, {
      upstream: upstream.url,
      controlPlane: { url: "https://collector.example", token: "written-into-a-file" },
    });
    expect(refused.code).toBe(1);
    expect(refused.output).toContain('Unknown setting "controlPlane.token"');
  });
});

describe("bodies built to make the proxy work", () => {
  it("refuses a body over the cap on an adapted operation, before the upstream", async () => {
    const answer = await fetch(`${proxy.url}/v1/items`, {
      method: "POST",
      headers: { "content-type": "application/json", "threats-version": OLD },
      body: JSON.stringify({ amount: 1, padding: "x".repeat(100 * 1024) }),
    });
    expect(answer.status).toBe(413);
    expect(upstream.seen).toEqual([]);
  });

  it("refuses a body nested deeper than the runtime walks, without falling over", async () => {
    const answer = await fetch(`${proxy.url}/v1/items`, {
      method: "POST",
      headers: { "content-type": "application/json", "threats-version": OLD },
      body: `${"[".repeat(20_000)}${"]".repeat(20_000)}`,
    });
    expect(answer.status).toBe(413);
    expect(upstream.seen).toEqual([]);
    // Still serving.
    const after = await fetch(`${proxy.url}/__invariant/health`);
    expect(after.status).toBe(200);
  });

  it("refuses a body whose wildcards would match more places than the cap allows", async () => {
    // 101 groups of 101 lines is 10,201 places for one instruction, past the
    // runtime's 10,000: the work a request can cause is bounded by the cap,
    // not by the body.
    const groups = Array.from({ length: 101 }, () => ({
      lines: Array.from({ length: 101 }, () => ({ qty: 1 })),
    }));
    const answer = await fetch(`${proxy.url}/v1/items`, {
      method: "POST",
      headers: { "content-type": "application/json", "threats-version": OLD },
      body: JSON.stringify({ amount: 1, groups }),
    });
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(answer.status).toBeLessThan(500);
    expect(upstream.seen).toEqual([]);
  });

  it("carries __proto__ and constructor through as the data they are", async () => {
    const answer = await fetch(`${proxy.url}/v1/items`, {
      method: "POST",
      headers: { "content-type": "application/json", "threats-version": OLD },
      body: '{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}},"amount":7}',
    });
    expect(answer.status).toBe(200);
    const sent = JSON.parse(upstream.seen[0]?.body ?? "{}") as Record<string, unknown>;
    expect(Object.hasOwn(sent, "__proto__")).toBe(true);
    expect(sent["amount_cents"]).toBe(7);
    // And the proxy that parsed it still answers the next caller normally.
    const next = await fetch(`${proxy.url}/v1/items`, {
      method: "POST",
      headers: { "content-type": "application/json", "threats-version": OLD },
      body: '{"amount":8}',
    });
    expect(await next.json()).toEqual({ amount: 8 });
  });
});
