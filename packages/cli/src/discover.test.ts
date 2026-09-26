/**
 * A release found by a consumer with no account, and trusted only on the
 * provider's word.
 *
 * Every request goes to a fake network in this process: the provider's
 * domain serving its document, and a service serving bundles, honestly or
 * not. What is proved is that the service can withhold a release but never
 * make one trusted, and that each request is held to HTTPS, its own host, a
 * size and a time limit. Keys are generated for each run.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBundle,
  buildWellKnown,
  type DsseEnvelope,
  generateSigningKey,
  signBundle,
  UntrustedBundleError,
  type WellKnownDocument,
} from "@invariant-app/bundle";
import type { Change, CompiledProgram } from "@invariant-app/ir";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DiscoveryError,
  fetchWellKnown,
  fileCache,
  guardedFetch,
  memoryCache,
  providerHost,
  resolveRelease,
} from "./discover.ts";
import { DEFAULT_SERVICE_URL } from "./service.ts";

const WELL_KNOWN = "https://acme.example/.well-known/invariant.json";
const SERVICE = "https://bundles.test";

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/** A network of fake hosts: each request is answered by the handler for its URL, or 404. */
function network(routes: Record<string, Handler>) {
  const calls: string[] = [];
  const send = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.toString());
    const handler = routes[url.toString()] ?? routes[`${url.origin}${url.pathname}`];
    if (!handler) return new Response("not here", { status: 404 });
    return handler(url, init);
  }) as typeof fetch;
  return { fetch: send, calls };
}

const json =
  (value: unknown, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json", ...headers },
    });

const PROGRAM: CompiledProgram = {
  irVersion: 2,
  compiledBy: "test",
  minRuntime: "0.1.0",
  api: "acme-payments",
  current: "sha256:aaaa",
  currentLabel: "2026-09-20",
  contracts: {},
};

const change = (id: string): Change => ({
  irVersion: 1,
  id,
  summary: id,
  scopes: [{ schema: "#/components/schemas/Payment" }],
  ops: [{ op: "move", from: `/${id}`, to: `/${id}_next` }],
});

function release(from: string, to: string, privateKeyPem: string, api = "acme-payments") {
  const { bundle, digest } = buildBundle({
    api,
    from: { label: from, digest: "sha256:1" },
    to: { label: to, digest: "sha256:2" },
    source: { repo: "acme/payments", commit: "c0ffee" },
    changes: [change(`chg_${to.replaceAll("-", "_")}`)],
    evidence: [],
    program: PROGRAM,
    gate: { result: "pass", unexplained: [] },
  });
  return { envelope: signBundle(bundle, digest, privateKeyPem), digest, from, to };
}

const seconds = (iso: string) => Date.parse(iso) / 1000;
const current = generateSigningKey();
const revoked = generateSigningKey();
const stranger = generateSigningKey();
const document: WellKnownDocument = buildWellKnown({
  apis: ["acme-payments"],
  keys: [
    { publicKeyPem: current.publicKeyPem, addedAt: "2026-01-01T00:00:00Z" },
    {
      publicKeyPem: revoked.publicKeyPem,
      addedAt: "2025-01-01T00:00:00Z",
      revoked: true,
    },
  ],
});
const now = () => new Date("2026-09-26T00:00:00Z");

/** A service publishing `bundles`, listing each with the key and time given. */
function service(
  base: string,
  bundles: {
    envelope: DsseEnvelope;
    digest: string;
    from: string;
    to: string;
    publishedAt?: string;
    serve?: DsseEnvelope;
  }[],
): Record<string, Handler> {
  const routes: Record<string, Handler> = {
    [`${base}/public/v1/apis/acme-payments/bundles`]: json(
      {
        bundles: bundles.map((entry) => ({
          digest: entry.digest,
          from: entry.from,
          to: entry.to,
          keyid: entry.envelope.signatures[0]?.keyid,
          publishedAt: seconds(entry.publishedAt ?? "2026-09-20T00:00:00Z"),
        })),
      },
      { "cache-control": "public, max-age=60" },
    ),
  };
  for (const entry of bundles) {
    routes[`${base}/public/v1/apis/acme-payments/bundles/${entry.digest}`] = json(
      entry.serve ?? entry.envelope,
    );
  }
  return routes;
}

describe("the provider's document", () => {
  it("is read from its own domain over https", async () => {
    const { fetch, calls } = network({ [WELL_KNOWN]: json(document) });
    const found = await fetchWellKnown("Acme.Example.", { fetch });
    expect(found.url).toBe(WELL_KNOWN);
    expect(found.document).toEqual(document);
    expect(calls).toEqual([WELL_KNOWN]);
  });

  it.each([
    "http://acme.example",
    "acme.example/keys",
    "127.0.0.1",
    "localhost",
    "acme.example:8443",
    "",
  ])("is never looked for at %j, which is not a domain", (provider) => {
    expect(() => providerHost(provider)).toThrow(DiscoveryError);
  });

  it("is refused when the domain has none, or serves something else", async () => {
    await expect(fetchWellKnown("acme.example", network({}))).rejects.toThrow(
      /answered 404: the provider publishes no signing keys/,
    );
    await expect(
      fetchWellKnown("acme.example", network({ [WELL_KNOWN]: json({ version: 1 }) })),
    ).rejects.toThrow(/not a document this build can read/);
  });

  it("follows a redirect on its own host, and no other", async () => {
    const moved = (location: string) => () =>
      new Response(null, { status: 301, headers: { location } });
    const same = network({
      [WELL_KNOWN]: moved("/keys/invariant.json"),
      "https://acme.example/keys/invariant.json": json(document),
    });
    expect((await fetchWellKnown("acme.example", same)).document).toEqual(document);

    for (const location of [
      "https://cdn.elsewhere.example/invariant.json",
      "http://acme.example/.well-known/invariant.json",
      "https://acme.example:8443/.well-known/invariant.json",
    ]) {
      await expect(
        fetchWellKnown("acme.example", network({ [WELL_KNOWN]: moved(location) })),
      ).rejects.toThrow(/only redirects on the same host are followed/);
    }

    const loop = network({ [WELL_KNOWN]: moved(WELL_KNOWN) });
    await expect(fetchWellKnown("acme.example", loop)).rejects.toThrow(
      /redirected more than 3 times/,
    );
  });

  it("is read no further than 64 KiB, whether or not it says how long it is", async () => {
    const big = JSON.stringify({ ...document, padding: "x".repeat(70_000) });
    const declared = network({ [WELL_KNOWN]: () => new Response(big) });
    await expect(fetchWellKnown("acme.example", declared)).rejects.toThrow(
      /at most 65536/,
    );
    const streamed = network({
      [WELL_KNOWN]: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let index = 0; index < 20; index++) {
                controller.enqueue(new TextEncoder().encode("x".repeat(8_192)));
              }
              controller.close();
            },
          }),
        ),
    });
    await expect(fetchWellKnown("acme.example", streamed)).rejects.toThrow(
      /more than 65536/,
    );
  });

  it("is given up on after the time limit", async () => {
    const hanging = network({
      [WELL_KNOWN]: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    });
    const started = Date.now();
    await expect(
      fetchWellKnown("acme.example", { ...hanging, timeoutMs: 50 }),
    ).rejects.toThrow(/could not be read/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("is kept for a few minutes, less when the provider says so, and never when it says not to", async () => {
    let clock = 0;
    const cache = memoryCache(() => clock);
    const kept = network({ [WELL_KNOWN]: json(document) });
    await fetchWellKnown("acme.example", { ...kept, cache });
    await fetchWellKnown("acme.example", { ...kept, cache });
    expect(kept.calls).toHaveLength(1);
    clock += 5 * 60 * 1000 + 1;
    await fetchWellKnown("acme.example", { ...kept, cache });
    expect(kept.calls).toHaveLength(2);

    const brief = network({
      [WELL_KNOWN]: json(document, { "cache-control": "max-age=10" }),
    });
    const briefCache = memoryCache(() => clock);
    await fetchWellKnown("acme.example", { ...brief, cache: briefCache });
    clock += 11_000;
    await fetchWellKnown("acme.example", { ...brief, cache: briefCache });
    expect(brief.calls).toHaveLength(2);

    const never = network({
      [WELL_KNOWN]: json(document, { "cache-control": "no-store" }),
    });
    const neverCache = memoryCache(() => clock);
    await fetchWellKnown("acme.example", { ...never, cache: neverCache });
    await fetchWellKnown("acme.example", { ...never, cache: neverCache });
    expect(never.calls).toHaveLength(2);
  });
});

describe("a published release", () => {
  const first = release("2026-01-15", "2026-06-01", current.privateKeyPem);
  const second = release("2026-06-01", "2026-09-20", current.privateKeyPem);

  it("is read from the service and opened with the provider's keys, step by step", async () => {
    const { fetch, calls } = network({
      [WELL_KNOWN]: json(document),
      ...service(SERVICE, [
        { ...first, publishedAt: "2026-06-01T00:00:00Z" },
        { ...second, publishedAt: "2026-09-20T00:00:00Z" },
      ]),
    });
    const resolved = await resolveRelease(
      {
        provider: "acme.example",
        api: "acme-payments",
        since: "2026-01-15",
        service: SERVICE,
      },
      { fetch, now },
    );
    expect(resolved.steps.map((step) => `${step.from} -> ${step.to}`)).toEqual([
      "2026-01-15 -> 2026-06-01",
      "2026-06-01 -> 2026-09-20",
    ]);
    expect(resolved.changes.map((entry) => entry.id)).toEqual([
      "chg_2026_06_01",
      "chg_2026_09_20",
    ]);
    expect(resolved.steps[1]).toMatchObject({
      digest: second.digest,
      publishedAt: "2026-09-20T00:00:00.000Z",
    });
    expect(resolved.wellKnown).toBe(WELL_KNOWN);
    expect(calls[0]).toBe(WELL_KNOWN);

    // One step by default: the newest, or the one named by label or digest.
    const newest = await resolveRelease(
      { provider: "acme.example", api: "acme-payments", service: SERVICE },
      { fetch, now },
    );
    expect(newest.steps.map((step) => step.to)).toEqual(["2026-09-20"]);
    const named = await resolveRelease(
      {
        provider: "acme.example",
        api: "acme-payments",
        to: first.digest,
        service: SERVICE,
      },
      { fetch, now },
    );
    expect(named.steps.map((step) => step.to)).toEqual(["2026-06-01"]);
  });

  it("is refused when a key the provider does not list signed it, whatever the service says", async () => {
    const forged = release("2026-06-01", "2026-09-20", stranger.privateKeyPem);
    const listing = service(SERVICE, [forged]);
    // The service even claims the provider's own key signed it.
    listing[`${SERVICE}/public/v1/apis/acme-payments/bundles`] = json({
      bundles: [
        {
          digest: forged.digest,
          from: forged.from,
          to: forged.to,
          keyid: document.keys.find((key) => !key.revoked)?.keyid,
          publishedAt: seconds("2026-09-20T00:00:00Z"),
        },
      ],
    });
    const { fetch } = network({ [WELL_KNOWN]: json(document), ...listing });
    const attempt = resolveRelease(
      { provider: "acme.example", api: "acme-payments", service: SERVICE },
      { fetch, now },
    );
    await expect(attempt).rejects.toThrow(UntrustedBundleError);
    await expect(attempt).rejects.toThrow(
      /no key the provider vouches for signed this bundle, whatever served it.*is not a key https:\/\/acme\.example\/\.well-known\/invariant\.json lists/,
    );
  });

  it("is refused when the provider revoked the key that signed it", async () => {
    const old = release("2026-06-01", "2026-09-20", revoked.privateKeyPem);
    const { fetch } = network({
      [WELL_KNOWN]: json(document),
      ...service(SERVICE, [old]),
    });
    await expect(
      resolveRelease(
        { provider: "acme.example", api: "acme-payments", service: SERVICE },
        { fetch, now },
      ),
    ).rejects.toThrow(/revoked it/);
  });

  it("is refused when the service serves something other than it listed", async () => {
    const other = release("2026-06-01", "2026-09-20", current.privateKeyPem);
    const swapped = release("2026-01-15", "2026-06-01", current.privateKeyPem);
    const { fetch } = network({
      [WELL_KNOWN]: json(document),
      ...service(SERVICE, [{ ...other, serve: swapped.envelope }]),
    });
    await expect(
      resolveRelease(
        { provider: "acme.example", api: "acme-payments", service: SERVICE },
        { fetch, now },
      ),
    ).rejects.toThrow(/listed .* and served/);
  });

  it("is refused when the service says it was published in the future, or before its key", async () => {
    const future = network({
      [WELL_KNOWN]: json(document),
      ...service(SERVICE, [{ ...second, publishedAt: "2027-01-01T00:00:00Z" }]),
    });
    await expect(
      resolveRelease(
        { provider: "acme.example", api: "acme-payments", service: SERVICE },
        { ...future, now },
      ),
    ).rejects.toThrow(/which has not happened yet/);
    const early = network({
      [WELL_KNOWN]: json(document),
      ...service(SERVICE, [{ ...second, publishedAt: "2025-06-01T00:00:00Z" }]),
    });
    await expect(
      resolveRelease(
        { provider: "acme.example", api: "acme-payments", service: SERVICE },
        { ...early, now },
      ),
    ).rejects.toThrow(/before the key was added/);
  });

  it("is refused for an API the provider does not list, before the service is asked", async () => {
    const { fetch, calls } = network({ [WELL_KNOWN]: json(document) });
    await expect(
      resolveRelease(
        { provider: "acme.example", api: "globex", service: SERVICE },
        { fetch, now },
      ),
    ).rejects.toThrow(/does not list the API globex/);
    expect(calls).toEqual([WELL_KNOWN]);
  });

  it("says so when no chain of releases reaches the contract the consumer speaks", async () => {
    const { fetch } = network({
      [WELL_KNOWN]: json(document),
      ...service(SERVICE, [second]),
    });
    await expect(
      resolveRelease(
        {
          provider: "acme.example",
          api: "acme-payments",
          since: "2025-01-01",
          service: SERVICE,
        },
        { fetch, now },
      ),
    ).rejects.toThrow(
      /no chain of published releases .* leads from 2025-01-01 to 2026-09-20; it stops at 2026-06-01/,
    );
  });

  it("is read from the service named on the command line, in the job, by the provider, or the hosted one", async () => {
    const hosts = [
      "https://cli.test",
      "https://job.test",
      "https://provider.test",
      DEFAULT_SERVICE_URL,
    ];
    const routes: Record<string, Handler> = {
      [WELL_KNOWN]: json({ ...document, bundles: { url: "https://provider.test" } }),
      "https://plain.example/.well-known/invariant.json": json(document),
    };
    for (const host of hosts) Object.assign(routes, service(host, [second]));
    const { fetch } = network(routes);
    const spec = { provider: "acme.example", api: "acme-payments" };
    const from = async (options: object, extra: object = {}) =>
      (await resolveRelease({ ...spec, ...extra }, { fetch, now, ...options })).service;
    expect(
      await from({ service: "https://cli.test" }, { service: "https://job.test" }),
    ).toBe("https://cli.test");
    expect(await from({}, { service: "https://job.test" })).toBe("https://job.test");
    expect(await from({})).toBe("https://provider.test");
    expect(await from({}, { provider: "plain.example" })).toBe(DEFAULT_SERVICE_URL);
  });

  it("is read from a service over https, or plain http on this machine only", async () => {
    const { fetch } = network({
      [WELL_KNOWN]: json(document),
      ...service("http://127.0.0.1:8787", [second]),
    });
    const spec = { provider: "acme.example", api: "acme-payments" };
    await expect(
      resolveRelease({ ...spec, service: "http://127.0.0.1:8787" }, { fetch, now }),
    ).resolves.toMatchObject({ service: "http://127.0.0.1:8787" });
    await expect(
      resolveRelease({ ...spec, service: "http://bundles.test" }, { fetch, now }),
    ).rejects.toThrow(/is not https/);
  });

  it("is cached once verified, and verified again when read back", async () => {
    let clock = Date.parse("2026-09-26T00:00:00Z");
    const cache = memoryCache(() => clock);
    const { fetch, calls } = network({
      [WELL_KNOWN]: json(document),
      ...service(SERVICE, [second]),
    });
    const spec = { provider: "acme.example", api: "acme-payments", service: SERVICE };
    await resolveRelease(spec, { fetch, now, cache });
    const asked = calls.length;
    await resolveRelease(spec, { fetch, now, cache });
    expect(calls).toHaveLength(asked);
    // Past the keys' and the listing's lifetime, both are asked for again;
    // the bundle, whose name is its digest, is not.
    clock += 6 * 60 * 1000;
    await resolveRelease(spec, { fetch, now, cache });
    expect(calls.slice(asked)).toEqual([
      WELL_KNOWN,
      `${SERVICE}/public/v1/apis/acme-payments/bundles`,
    ]);
  });
});

describe("a guarded fetch", () => {
  it("hands back an answer with no body as one", async () => {
    const get = guardedFetch(
      network({ "https://a.test/x": () => new Response(null, { status: 204 }) }).fetch,
      { maxBytes: 10, timeoutMs: 1_000 },
    );
    expect((await get("https://a.test/x")).status).toBe(204);
  });
});

describe("the cache on disk", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "invariant-discovery-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps an entry until it expires, and one that cannot be written is not kept", async () => {
    let clock = 0;
    const cache = fileCache(dir, () => clock);
    await cache.set("a", "one", 1_000);
    await cache.set("b", "two", 0);
    expect(await cache.get("a")).toBe("one");
    expect(await cache.get("b")).toBeUndefined();
    clock = 1_001;
    expect(await cache.get("a")).toBeUndefined();
    // A directory that cannot be made, since a file is where it would go.
    await writeFile(join(dir, "a-file"), "");
    const unwritable = fileCache(join(dir, "a-file", "cache"));
    await unwritable.set("a", "one", 1_000);
    expect(await unwritable.get("a")).toBeUndefined();
  });
});
