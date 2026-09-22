/**
 * The proxy with the kill switch, counters and heartbeat connected, as a
 * provider runs it: a switch flipped on the control plane stops an old
 * contract without a deploy, and what the proxy adapted is counted and sent.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "@invariant-app/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, parseConfig, type SidecarConfig } from "./config.ts";
import { createProxy } from "./proxy.ts";
import { servicesFor } from "./services.ts";

const OLD = "2026-01-01";
const PROGRAM = {
  irVersion: 2,
  compiledBy: "@invariant-app/compiler@0.1.0",
  minRuntime: "0.1.0",
  api: "payments",
  currentLabel: "2026-09-20",
  current: "sha256:head",
  contracts: {
    [OLD]: {
      label: OLD,
      routes: [],
      sites: {
        "post /v1/payments": {
          request: [
            { k: "move", from: "/amount", to: "/amount_cents", c: "chg_minor_units" },
          ],
        },
      },
      behaviors: [],
      retired: [],
    },
  },
};

/** A control plane that records what it is sent and serves the flags it holds. */
function controlPlane(flags: Record<string, unknown> = {}) {
  const received: { path: string; body: unknown; headers: Headers }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const text = request.body ? await request.text() : "";
    received.push({
      path,
      body: text ? JSON.parse(text) : undefined,
      headers: request.headers,
    });
    if (path === "/v1/flags") {
      return Response.json({ flags, updatedAt: 1 }, { headers: { etag: '"f1"' } });
    }
    if (path === "/v1/ingest") return Response.json({ accepted: 1, ignored: 0 });
    if (path === "/v1/heartbeat") return new Response(null, { status: 204 });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, received };
}

function upstream() {
  return (async () => Response.json({ ok: true })) as unknown as typeof fetch;
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "invariant-sidecar-services-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const records: Record<string, unknown>[] = [];

const base = {
  program: "program.json",
  upstream: "http://127.0.0.1:9",
  identity: [
    { kind: "header", name: "payments-version" },
    { kind: "default", label: "2026-09-20" },
  ],
};

function running(config: SidecarConfig, plane: ReturnType<typeof controlPlane>) {
  const services = servicesFor(config, {
    env: { INVARIANT_TOKEN: "tok_test" },
    fetch: plane.fetchImpl,
    log: () => {},
    record: (line) => records.push(JSON.parse(line)),
  });
  const runtime = createRuntime({
    program: PROGRAM,
    ...(config.identity ? { identity: config.identity } : {}),
    ...(services.flags ? { flags: services.flags } : {}),
    onUsage: services.onUsage,
    onOutcome: services.onOutcome,
  });
  services.started({ text: JSON.stringify(PROGRAM), currentLabel: runtime.currentLabel });
  const proxy = createProxy({
    runtime,
    upstream: config.upstream,
    fetch: upstream(),
    ...(config.metricsPath === null
      ? {}
      : { metrics: { path: config.metricsPath, render: services.metrics.render } }),
  });
  return { services, proxy };
}

const pay = () =>
  new Request("https://api.example.com/v1/payments", {
    method: "POST",
    headers: { "content-type": "application/json", "payments-version": OLD },
    body: JSON.stringify({ amount: 1999 }),
  });

describe("the proxy's counters", () => {
  it("are scraped from beside the health check, labelled without a path", async () => {
    const { proxy } = running(parseConfig(base, dir), controlPlane());
    expect((await proxy(pay())).status).toBe(200);
    const unknown = await proxy(
      new Request("https://api.example.com/v1/payments/p_123", {
        headers: { "payments-version": "1999-01-01" },
      }),
    );
    expect(unknown.status).toBe(400);

    const scrape = await proxy(
      new Request("https://api.example.com/__invariant/metrics"),
    );
    expect(scrape.headers.get("content-type")).toContain("text/plain");
    const text = await scrape.text();
    expect(text).toContain(
      `invariant_adapted_total{contract="${OLD}",direction="request"} 1`,
    );
    expect(text).toContain(
      `invariant_change_applied_total{contract="${OLD}",change="chg_minor_units"} 1`,
    );
    expect(text).toContain(
      'invariant_unsupported_contract_total{contract="1999-01-01"} 1',
    );
    expect(text).not.toContain("p_123");
  });

  it("can be turned off", async () => {
    const { proxy } = running(
      parseConfig({ ...base, metricsPath: null }, dir),
      controlPlane(),
    );
    const scrape = await proxy(
      new Request("https://api.example.com/__invariant/metrics"),
    );
    // Passed on to the provider like any other path.
    expect(await scrape.json()).toEqual({ ok: true });
  });
});

describe("the proxy connected to its control plane", () => {
  const config = (file = "usage.jsonl") =>
    parseConfig(
      {
        ...base,
        controlPlane: { url: "https://control-plane.test", tokenEnv: "INVARIANT_TOKEN" },
        flags: { remote: { pollMs: 60_000 } },
        telemetry: { controlPlane: true, file: join(dir, file) },
      },
      dir,
    );

  it("stops serving a contract switched off there, without a deploy", async () => {
    const plane = controlPlane({ disabledContracts: [OLD] });
    const { services, proxy } = running(config("switched.jsonl"), plane);
    await services.ready();
    const refused = await proxy(pay());
    expect(refused.status).toBe(400);
    const id = refused.headers.get("invariant-error-id");
    expect(id).toMatch(/^err_/);
    // The operator can find what the caller quotes.
    expect(records.at(-1)).toMatchObject({
      event: "refused",
      errorId: id,
      contract: OLD,
      reason: "UnsupportedContractError",
    });
    await services.close();
  });

  it("sends what it adapted, a heartbeat, and the same counters to the file", async () => {
    const plane = controlPlane();
    const { services, proxy } = running(config(), plane);
    expect((await proxy(pay())).status).toBe(200);
    await services.close();

    const ingest = plane.received.find((entry) => entry.path === "/v1/ingest");
    expect(ingest?.headers.get("authorization")).toBe("Bearer tok_test");
    expect(ingest?.body).toMatchObject({
      usage: [{ contract: OLD, changeId: "chg_minor_units", count: 1 }],
      outcomes: [{ contract: OLD, direction: "request", outcome: "adapted", count: 1 }],
    });
    const beat = plane.received.find((entry) => entry.path === "/v1/heartbeat");
    expect(beat?.body).toMatchObject({
      runtime: { binding: "proxy" },
      program: { compiledBy: "@invariant-app/compiler@0.1.0", minRuntime: "0.1.0" },
    });
    const lines = (await readFile(join(dir, "usage.jsonl"), "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).kind).sort()).toEqual([
      "outcome",
      "usage",
    ]);
  });

  it("logs and counts a caller naming a contract that does not exist", async () => {
    const plane = controlPlane();
    const { services, proxy } = running(config("unknown.jsonl"), plane);
    const refused = await proxy(
      new Request("https://api.example.com/v1/payments", {
        method: "POST",
        headers: { "content-type": "application/json", "payments-version": "1999-01-01" },
        body: "{}",
      }),
    );
    expect(refused.status).toBe(400);
    expect(records.at(-1)).toMatchObject({
      event: "refused",
      errorId: refused.headers.get("invariant-error-id"),
      contract: "1999-01-01",
    });
    await services.close();
    const ingest = plane.received.find((entry) => entry.path === "/v1/ingest");
    expect(ingest?.body).toMatchObject({
      outcomes: [{ contract: "1999-01-01", outcome: "refused", count: 1 }],
    });
  });

  it("is refused before it starts when the token it names is not set", () => {
    expect(() => servicesFor(config(), { env: {} })).toThrow(
      /INVARIANT_TOKEN, which is not set/,
    );
  });
});

describe("the configuration for it", () => {
  const parse = (extra: Record<string, unknown>) => () =>
    parseConfig({ ...base, ...extra }, dir);

  it("will not send a token anywhere but over https", () => {
    expect(
      parse({ controlPlane: { url: "http://control-plane.test", tokenEnv: "T" } }),
    ).toThrow(/must be https/);
    expect(
      parse({ controlPlane: { url: "http://127.0.0.1:8787", tokenEnv: "T" } }),
    ).not.toThrow();
  });

  it("asks for the control plane before reading flags or sending counters to it", () => {
    expect(parse({ flags: { remote: {} } })).toThrow(/set "controlPlane" too/);
    expect(parse({ telemetry: { controlPlane: true } })).toThrow(
      /set "controlPlane" too/,
    );
  });

  it("refuses a setting it does not know, however deep", () => {
    expect(parse({ flags: { remote: { every: 5 } } })).toThrow(ConfigError);
    expect(parse({ telemetry: { sink: "x" } })).toThrow(
      /Unknown setting "telemetry.sink"/,
    );
  });

  it("reads a local file of flags with no control plane at all", () => {
    const config = parseConfig({ ...base, flags: { file: "flags.json" } }, dir);
    expect(config.flags).toEqual({ file: join(dir, "flags.json") });
  });
});
