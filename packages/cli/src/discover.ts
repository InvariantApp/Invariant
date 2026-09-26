/**
 * A provider's release, found without an account and trusted without the
 * service that served it.
 *
 * A consumer who is not on GitHub, or who wants to run a migration on their
 * own machine, names the provider's domain and the API. The bundles come from
 * the public, cached read endpoint of the service they were published to;
 * the keys that decide whether to believe them come from the provider's own
 * domain, at `/.well-known/invariant.json`, over HTTPS and nothing else. The
 * service is a cache, and a cache that is wrong, compromised or lying can
 * withhold a release but cannot make one trusted: a bundle whose signer the
 * provider's document does not vouch for is refused however it arrived.
 *
 * Everything that touches the network takes its `fetch` from the caller, so
 * the tests run against fakes and never the real network, and each request is
 * held to a size, a time limit, and redirects on the host it was sent to.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type DsseEnvelope,
  openWithWellKnown,
  parseWellKnown,
  UntrustedBundleError,
  WELL_KNOWN_PATH,
  type WellKnownDocument,
} from "@invariant-app/bundle";
import { type BundlePage, ControlPlaneError, createClient } from "@invariant-app/client";
import type { Change } from "@invariant-app/ir";
import { DEFAULT_SERVICE_URL } from "./service.ts";

export class DiscoveryError extends Error {
  override name = "DiscoveryError";
}

/** Where a release is published, as a job names it. */
export interface ReleaseSpec {
  /** The provider's domain, whose `/.well-known/invariant.json` lists its keys. */
  provider: string;
  /** The API, by the id its bundles carry. */
  api: string;
  /** The contract to migrate to, by label or by bundle digest (default: the newest published). */
  to?: string;
  /** The contract the consumer speaks today; every step from it to `to` is applied (default: one step). */
  since?: string;
  /** The service the bundles are read from (default: the one the provider names, else the hosted one). */
  service?: string;
}

/** One published step, as it was verified. */
export interface VerifiedStep {
  digest: string;
  from: string;
  to: string;
  keyid: string;
  /** When the service says it was published, which the key's validity was checked at. */
  publishedAt: string;
}

export interface ResolvedRelease {
  changes: Change[];
  steps: VerifiedStep[];
  /** The document the keys came from. */
  wellKnown: string;
  /** The service the bundles came from. */
  service: string;
}

/** A small store for what discovery reads, so a run repeated within minutes asks nobody. */
export interface DiscoveryCache {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
}

export interface DiscoveryOptions {
  fetch?: typeof fetch;
  cache?: DiscoveryCache;
  now?: () => Date;
  /** The service to read bundles from, overriding the job and the provider. */
  service?: string;
  /** Abandons one request after this long. Default 15 seconds. */
  timeoutMs?: number;
}

/** How long the provider's keys are believed without asking again: a revocation is felt within this. */
export const KEYS_TTL_MS = 5 * 60 * 1000;
/** How long a listing of published bundles is kept. */
export const LISTING_TTL_MS = 60 * 1000;
/** A verified bundle never changes, since its digest is its name. */
export const BUNDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The most the provider's document may be. A list of keys is a few kilobytes. */
export const MOST_WELL_KNOWN_BYTES = 64 * 1024;
/** The most one answer from the service may be: a page of summaries, or one bundle with its evidence. */
export const MOST_SERVICE_BYTES = 32 * 1024 * 1024;
const MOST_REDIRECTS = 3;
const MOST_PAGES = 100;
const MOST_STEPS = 64;
/** How far ahead of this machine's clock a publication time may be before it is a lie rather than skew. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A `fetch` held to what discovery allows: HTTPS (or plain HTTP to this
 * machine, when `loopback` allows it, for a service run locally), redirects
 * followed only on the same host and scheme and only a few of them, a time
 * limit on the whole exchange, and a body read no further than `maxBytes`.
 * A redirect to another host is refused rather than followed, because the
 * host is what a reader was told to trust, or at least to ask.
 */
export function guardedFetch(
  send: typeof fetch,
  rules: { maxBytes: number; timeoutMs: number; loopback?: boolean },
): typeof fetch {
  return async (input, init) => {
    let url = new URL(input instanceof Request ? input.url : String(input));
    allowed(url, rules.loopback ?? false);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(rules.timeoutMs)])
      : AbortSignal.timeout(rules.timeoutMs);
    for (let hop = 0; ; hop++) {
      const response = await send(url, { ...init, redirect: "manual", signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get("location");
        if (!location) throw new DiscoveryError(`${url} redirected nowhere`);
        const next = new URL(location, url);
        if (next.host !== url.host || next.protocol !== url.protocol) {
          throw new DiscoveryError(
            `${url} redirected to ${next.protocol}//${next.host}; only redirects on the same host are followed`,
          );
        }
        if (hop + 1 > MOST_REDIRECTS) {
          throw new DiscoveryError(`${url} redirected more than ${MOST_REDIRECTS} times`);
        }
        url = next;
        continue;
      }
      const body = await readAtMost(response, rules.maxBytes, url);
      // A status that has no body cannot be given one, even an empty one.
      const empty = [101, 204, 205, 304].includes(response.status);
      return new Response(empty ? null : body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
  };
}

function allowed(url: URL, loopback: boolean): void {
  if (url.protocol === "https:") return;
  if (loopback && url.protocol === "http:" && LOOPBACK.has(url.hostname)) return;
  throw new DiscoveryError(`${url} is not https, and nothing else is read`);
}

/** A body, refused as soon as it passes `most` bytes rather than after it has all arrived. */
async function readAtMost(
  response: Response,
  most: number,
  url: URL,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > most) {
    await response.body?.cancel().catch(() => undefined);
    throw new DiscoveryError(`${url} is ${declared} bytes; at most ${most} are read`);
  }
  if (!response.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > most) {
      await reader.cancel().catch(() => undefined);
      throw new DiscoveryError(
        `${url} is more than ${most} bytes; at most ${most} are read`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * How long an answer may be kept: the service's or the provider's own
 * `max-age` when it is shorter than ours, never when it says not to store.
 */
function ttlOf(headers: Headers, ours: number): number {
  const control = (headers.get("cache-control") ?? "").toLowerCase();
  if (/\b(no-store|no-cache|private)\b/.test(control)) return 0;
  const age = /\bmax-age=(\d+)/.exec(control);
  return age ? Math.min(Number(age[1]) * 1000, ours) : ours;
}

/** A provider named by its domain, as it would be in a URL: a DNS name, never an address or a path. */
export function providerHost(provider: string): string {
  const host = provider.trim().toLowerCase().replace(/\.$/, "");
  if (
    !/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/.test(
      host,
    )
  ) {
    throw new DiscoveryError(
      `the provider is named by its domain, such as api.example.com, not ${JSON.stringify(provider)}`,
    );
  }
  return host;
}

/** The provider's document, from its own domain, over HTTPS only. */
export async function fetchWellKnown(
  provider: string,
  options: DiscoveryOptions = {},
): Promise<{ document: WellKnownDocument; url: string }> {
  const url = `https://${providerHost(provider)}${WELL_KNOWN_PATH}`;
  const cached = await options.cache?.get(`well-known ${url}`);
  if (cached !== undefined) {
    // Checked again on the way out of the cache, which is only a file.
    return { document: parseWellKnown(JSON.parse(cached)), url };
  }
  const get = guardedFetch(options.fetch ?? fetch, {
    maxBytes: MOST_WELL_KNOWN_BYTES,
    timeoutMs: options.timeoutMs ?? 15_000,
  });
  let response: Response;
  try {
    response = await get(url, { headers: { accept: "application/json" } });
  } catch (error) {
    if (error instanceof DiscoveryError) throw error;
    throw new DiscoveryError(
      `${url} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status !== 200) {
    throw new DiscoveryError(
      `${url} answered ${response.status}: the provider publishes no signing keys there, so none of its bundles can be trusted`,
    );
  }
  const text = await response.text();
  let document: WellKnownDocument;
  try {
    document = parseWellKnown(JSON.parse(text));
  } catch (error) {
    throw new DiscoveryError(
      `${url} is not a document this build can read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const ttl = ttlOf(response.headers, KEYS_TTL_MS);
  if (ttl > 0) await options.cache?.set(`well-known ${url}`, text, ttl);
  return { document, url };
}

/** The service's base URL: https, or http to this machine for a service run locally. */
function serviceUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DiscoveryError(`the service is not a URL: ${url}`);
  }
  allowed(parsed, true);
  return url.replace(/\/+$/, "");
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * The Changes from `since` to `to`, from bundles the service publishes, each
 * opened only with a key the provider's own document vouches for at the time
 * it was published. A bundle that fails is never skipped in favour of the
 * next: what fails is refused, and the refusal says why.
 */
export async function resolveRelease(
  spec: ReleaseSpec,
  options: DiscoveryOptions = {},
): Promise<ResolvedRelease> {
  const now = options.now ?? (() => new Date());
  const { document, url: wellKnown } = await fetchWellKnown(spec.provider, options);
  if (!document.apis.includes(spec.api)) {
    throw new UntrustedBundleError(
      `${wellKnown} does not list the API ${spec.api}; it lists ${document.apis.join(", ")}`,
    );
  }
  const service = serviceUrl(
    options.service ?? spec.service ?? document.bundles?.url ?? DEFAULT_SERVICE_URL,
  );
  const client = createClient({
    baseUrl: service,
    fetch: guardedFetch(options.fetch ?? fetch, {
      maxBytes: MOST_SERVICE_BYTES,
      timeoutMs: options.timeoutMs ?? 15_000,
      loopback: true,
    }),
    timeoutMs: options.timeoutMs ?? 15_000,
  });
  const cache = options.cache;

  const summaries: BundlePage["bundles"] = [];
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= MOST_PAGES) {
      throw new DiscoveryError(
        `${service} listed more than ${MOST_PAGES} pages of bundles`,
      );
    }
    const key = `listing ${service} ${spec.api} ${cursor ?? ""}`;
    const hit = await cache?.get(key);
    let listed: BundlePage;
    if (hit !== undefined) {
      listed = JSON.parse(hit) as BundlePage;
    } else {
      listed = await withService(service, () =>
        client.listPublicBundles(spec.api, cursor === undefined ? {} : { cursor }),
      );
      await cache?.set(key, JSON.stringify(listed), LISTING_TTL_MS);
    }
    if (!Array.isArray(listed?.bundles)) {
      throw new DiscoveryError(`${service} answered a listing with no bundles in it`);
    }
    summaries.push(...listed.bundles);
    if (!listed.next) break;
    cursor = listed.next;
  }
  if (summaries.length === 0) {
    throw new DiscoveryError(`${service} has published no bundles for ${spec.api}`);
  }

  const newestFirst = [...summaries].sort((a, b) => b.publishedAt - a.publishedAt);
  const target =
    spec.to === undefined
      ? newestFirst[0]
      : DIGEST.test(spec.to)
        ? newestFirst.find((summary) => summary.digest === spec.to)
        : newestFirst.find((summary) => summary.to === spec.to);
  if (!target) {
    throw new DiscoveryError(
      `${service} has no published bundle for ${spec.api} ${spec.to}; it has ${[...new Set(newestFirst.map((summary) => summary.to))].join(", ")}`,
    );
  }

  const open = async (
    summary: (typeof summaries)[number],
  ): Promise<{
    step: VerifiedStep;
    changes: Change[];
  }> => {
    if (!DIGEST.test(summary.digest)) {
      throw new DiscoveryError(
        `${service} listed a bundle whose digest is not one: ${summary.digest}`,
      );
    }
    const publishedAt = new Date(summary.publishedAt * 1000);
    if (!Number.isFinite(publishedAt.getTime())) {
      throw new DiscoveryError(
        `${service} listed ${summary.digest} with no time it was published`,
      );
    }
    if (publishedAt.getTime() > now().getTime() + CLOCK_SKEW_MS) {
      throw new UntrustedBundleError(
        `refused: ${service} says ${summary.digest} was published at ${publishedAt.toISOString()}, which has not happened yet`,
      );
    }
    const key = `bundle ${service} ${spec.api} ${summary.digest}`;
    const hit = await cache?.get(key);
    const envelope =
      hit !== undefined
        ? (JSON.parse(hit) as DsseEnvelope)
        : ((await withService(service, () =>
            client.getPublicBundle(spec.api, summary.digest),
          )) as unknown as DsseEnvelope);
    const opened = openWithWellKnown(envelope, document, {
      api: spec.api,
      signedAt: publishedAt,
      source: wellKnown,
    });
    // The listing is the service's word; the bundle is the provider's. They
    // have to agree, or the service answered with something it did not list.
    if (
      opened.digest !== summary.digest ||
      opened.bundle.to.label !== summary.to ||
      opened.bundle.from.label !== summary.from
    ) {
      throw new UntrustedBundleError(
        `refused: ${service} listed ${summary.digest} (${summary.from} -> ${summary.to}) and served ${opened.digest} (${opened.bundle.from.label} -> ${opened.bundle.to.label})`,
      );
    }
    if (hit === undefined) await cache?.set(key, JSON.stringify(envelope), BUNDLE_TTL_MS);
    return {
      step: {
        digest: opened.digest,
        from: opened.bundle.from.label,
        to: opened.bundle.to.label,
        keyid: opened.keyid,
        publishedAt: publishedAt.toISOString(),
      },
      changes: opened.bundle.changes,
    };
  };

  // Walk back from the target to the contract the consumer speaks, one
  // published step at a time, each opened on its own merits.
  const steps: { step: VerifiedStep; changes: Change[] }[] = [await open(target)];
  const seen = new Set([target.digest]);
  while (spec.since !== undefined && steps[0]?.step.from !== spec.since) {
    const from = steps[0]?.step.from;
    const previous = newestFirst.find((summary) => summary.to === from);
    if (!previous || seen.has(previous.digest) || steps.length >= MOST_STEPS) {
      throw new DiscoveryError(
        `no chain of published releases for ${spec.api} leads from ${spec.since} to ${steps.at(-1)?.step.to}; it stops at ${from}`,
      );
    }
    seen.add(previous.digest);
    steps.unshift(await open(previous));
  }
  return {
    changes: steps.flatMap((entry) => entry.changes),
    steps: steps.map((entry) => entry.step),
    wellKnown,
    service,
  };
}

async function withService<T>(service: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ControlPlaneError) {
      throw new DiscoveryError(
        error.status === 0
          ? error.message
          : `${service} answered ${error.status}: ${error.message}`,
      );
    }
    throw error;
  }
}

/** A cache held in this process only. */
export function memoryCache(now: () => number = Date.now): DiscoveryCache {
  const entries = new Map<string, { value: string; until: number }>();
  return {
    async get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.until <= now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    async set(key, value, ttlMs) {
      if (ttlMs > 0) entries.set(key, { value, until: now() + ttlMs });
    },
  };
}

/**
 * A cache on disk, one file per entry named by the hash of its key, so a
 * `migrate` run again a minute later asks nobody. Nothing read from it is
 * believed on that account: the provider's document is parsed again and every
 * bundle verified again, so the cache saves requests and never decides trust.
 */
export function fileCache(dir: string, now: () => number = Date.now): DiscoveryCache {
  const path = (key: string) =>
    join(dir, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);
  return {
    async get(key) {
      try {
        const entry = JSON.parse(await readFile(path(key), "utf8")) as {
          key: string;
          until: number;
          value: string;
        };
        return entry.key === key && entry.until > now() ? entry.value : undefined;
      } catch {
        return undefined;
      }
    },
    async set(key, value, ttlMs) {
      if (ttlMs <= 0) return;
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        // Written aside and renamed, so a reader never sees half an entry.
        const target = path(key);
        const aside = `${target}.${process.pid}.tmp`;
        await writeFile(aside, JSON.stringify({ key, until: now() + ttlMs, value }), {
          mode: 0o600,
        });
        await rename(aside, target);
      } catch {
        // A cache that cannot be written is a cache that is not used.
      }
    },
  };
}

/** Where the CLI keeps its discovery cache: the platform's cache directory. */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const base =
    env["XDG_CACHE_HOME"] ||
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Caches")
      : process.platform === "win32"
        ? env["LOCALAPPDATA"] || join(homedir(), "AppData", "Local")
        : join(homedir(), ".cache"));
  return join(base, "invariant", "discovery");
}
