/**
 * The control plane, from the outside.
 *
 * Everything that talks to the hosted service goes through this: the CLI
 * publishing a bundle, a runtime reporting counters and polling flags, the
 * GitHub App reading what to migrate. It is written against `openapi.yaml`
 * beside it, whose types are generated into `schema.ts`, so a change to the
 * contract that this client does not follow fails to compile rather than
 * failing in production.
 *
 * No dependencies, because a runtime's telemetry uses it and a runtime sits in
 * a provider's request path. Nothing here throws on a network failure without
 * saying so in a typed error, and nothing retries on its own: the caller
 * decides, since a runtime flushing counters on shutdown and a person
 * publishing a release want different things.
 */
import type { components } from "./schema.ts";

export type { components, operations, paths } from "./schema.ts";

type Schemas = components["schemas"];
export type DsseEnvelope = Schemas["DsseEnvelope"];
export type BundlePublished = Schemas["BundlePublished"];
export type BundlePage = Schemas["BundlePage"];
export type IngestBatch = Schemas["IngestBatch"];
export type UsageRow = Schemas["UsageRow"];
export type OutcomeRow = Schemas["OutcomeRow"];
export type IngestResult = Schemas["IngestResult"];
export type Heartbeat = Schemas["Heartbeat"];
export type Flags = Schemas["Flags"];
export type FlagsState = Schemas["FlagsState"];
export type FlagsChange = Schemas["FlagsChange"];
export type FlagChangePage = Schemas["FlagChangePage"];
export type Contract = Schemas["Contract"];
export type ContractDetail = Schemas["ContractDetail"];
export type Impact = Schemas["Impact"];
export type ProposeRequest = Schemas["ProposeRequest"];
export type Proposal = Schemas["Proposal"];
export type ConsumerPage = Schemas["ConsumerPage"];
export type IntegrationPage = Schemas["IntegrationPage"];
export type SdkMap = Schemas["SdkMap"];
export type MigrationPage = Schemas["MigrationPage"];
export type MigrationStatus = Schemas["MigrationStatus"];
export type Token = Schemas["Token"];
export type IssuedToken = Schemas["IssuedToken"];
export type PublisherKey = Schemas["PublisherKey"];
export type Scope = Schemas["Scope"];
export type ErrorCode = Schemas["ErrorCode"];

/** The contract this client was written against, sent as `Invariant-Version`. */
export const CONTRACT_VERSION = "2026-09-21";

export interface ClientOptions {
  /** Where the control plane is, such as `https://api.example.com`. */
  baseUrl: string;
  /** A token issued for one API. Absent for the public reads. */
  token?: string;
  /** Substituted in tests, or to route through a provider's own proxy. */
  fetch?: typeof fetch;
  /** Abandons a call that takes longer than this. Default 10 seconds. */
  timeoutMs?: number;
}

/**
 * A call the control plane refused, or one that never reached it.
 *
 * `status` is 0 when there was no answer at all, which is the case a runtime
 * has to shrug off: the service being unreachable is not an incident for the
 * provider's own traffic.
 */
export class ControlPlaneError extends Error {
  readonly status: number;
  readonly code: ErrorCode | "unreachable" | "unexpected";
  readonly requestId: string | undefined;
  /** Seconds to wait before trying again, when the service said. */
  readonly retryAfter: number | undefined;
  constructor(
    message: string,
    details: {
      status: number;
      code: ControlPlaneError["code"];
      requestId?: string | undefined;
      retryAfter?: number | undefined;
      cause?: unknown;
    },
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "ControlPlaneError";
    this.status = details.status;
    this.code = details.code;
    this.requestId = details.requestId;
    this.retryAfter = details.retryAfter;
  }
}

interface Call {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string | undefined>;
  body?: unknown;
  /** Statuses that are answers rather than errors. */
  ok: readonly number[];
}

interface Answer {
  status: number;
  headers: Headers;
  body: unknown;
}

/** Page through a listing: pass `next` back as `cursor`. */
export interface Page {
  cursor?: string;
  limit?: number;
}

/** A path segment, escaped, with the `:` a digest carries left readable as RFC 3986 allows. */
const segment = (value: string) => encodeURIComponent(value).replaceAll("%3A", ":");

export function createClient(options: ClientOptions) {
  const base = options.baseUrl.replace(/\/+$/, "");
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function call(request: Call): Promise<Answer> {
    const url = new URL(`${base}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers = new Headers({
      accept: "application/json",
      "invariant-version": CONTRACT_VERSION,
    });
    if (options.token !== undefined)
      headers.set("authorization", `Bearer ${options.token}`);
    for (const [key, value] of Object.entries(request.headers ?? {})) {
      if (value !== undefined) headers.set(key, value);
    }
    if (request.body !== undefined) headers.set("content-type", "application/json");

    let response: Response;
    try {
      response = await send(url, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw new ControlPlaneError(
        `The control plane at ${base} could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
        { status: 0, code: "unreachable", cause },
      );
    }

    const text = await response.text();
    let body: unknown;
    if (text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }
    if (request.ok.includes(response.status)) {
      return { status: response.status, headers: response.headers, body };
    }

    const error =
      typeof body === "object" && body !== null && "error" in body
        ? (body as { error: { code?: unknown; message?: unknown; requestId?: unknown } })
            .error
        : undefined;
    const retry = Number(response.headers.get("retry-after"));
    throw new ControlPlaneError(
      typeof error?.message === "string"
        ? error.message
        : `The control plane answered ${response.status} to ${request.method} ${request.path}.`,
      {
        status: response.status,
        code: typeof error?.code === "string" ? (error.code as ErrorCode) : "unexpected",
        requestId: typeof error?.requestId === "string" ? error.requestId : undefined,
        retryAfter: Number.isFinite(retry) && retry > 0 ? retry : undefined,
      },
    );
  }

  const page = (at: Page | undefined) => ({ cursor: at?.cursor, limit: at?.limit });

  return {
    async publishBundle(
      envelope: DsseEnvelope,
      at: { idempotencyKey?: string } = {},
    ): Promise<BundlePublished> {
      const answer = await call({
        method: "POST",
        path: "/v1/bundles",
        headers: { "idempotency-key": at.idempotencyKey },
        body: envelope,
        ok: [200, 201],
      });
      return answer.body as BundlePublished;
    },

    async listBundles(at?: Page): Promise<BundlePage> {
      return (
        await call({ method: "GET", path: "/v1/bundles", query: page(at), ok: [200] })
      ).body as BundlePage;
    },

    async getBundle(digest: string): Promise<DsseEnvelope> {
      return (
        await call({ method: "GET", path: `/v1/bundles/${segment(digest)}`, ok: [200] })
      ).body as DsseEnvelope;
    },

    async ingest(
      batch: IngestBatch,
      at: { idempotencyKey?: string } = {},
    ): Promise<IngestResult> {
      const answer = await call({
        method: "POST",
        path: "/v1/ingest",
        headers: { "idempotency-key": at.idempotencyKey },
        body: batch,
        ok: [200],
      });
      return answer.body as IngestResult;
    },

    async heartbeat(beat: Heartbeat): Promise<void> {
      await call({ method: "POST", path: "/v1/heartbeat", body: beat, ok: [204] });
    },

    /**
     * The flags, unless they are the ones already held. A runtime polls with
     * the tag of what it has, and the usual answer is that nothing changed.
     */
    async getFlags(
      held?: string,
    ): Promise<{ changed: false } | { changed: true; etag: string; state: FlagsState }> {
      const answer = await call({
        method: "GET",
        path: "/v1/flags",
        headers: { "if-none-match": held },
        ok: [200, 304],
      });
      if (answer.status === 304) return { changed: false };
      const etag = answer.headers.get("etag");
      if (etag === null) {
        throw new ControlPlaneError("The flags came back without an ETag.", {
          status: answer.status,
          code: "unexpected",
        });
      }
      return { changed: true, etag, state: answer.body as FlagsState };
    },

    /** Change the flags last read as `ifMatch`, saying why. */
    async setFlags(
      change: FlagsChange,
      ifMatch: string,
    ): Promise<{ etag: string; state: FlagsState }> {
      const answer = await call({
        method: "PUT",
        path: "/v1/flags",
        headers: { "if-match": ifMatch },
        body: change,
        ok: [200],
      });
      return { etag: answer.headers.get("etag") ?? "", state: answer.body as FlagsState };
    },

    async listFlagChanges(at?: Page): Promise<FlagChangePage> {
      return (
        await call({
          method: "GET",
          path: "/v1/flags/history",
          query: page(at),
          ok: [200],
        })
      ).body as FlagChangePage;
    },

    async listContracts(): Promise<Contract[]> {
      const answer = await call({ method: "GET", path: "/v1/contracts", ok: [200] });
      return (answer.body as { contracts: Contract[] }).contracts;
    },

    async getContract(label: string): Promise<ContractDetail> {
      return (
        await call({ method: "GET", path: `/v1/contracts/${segment(label)}`, ok: [200] })
      ).body as ContractDetail;
    },

    async getImpact(at: { days?: number } = {}): Promise<Impact> {
      return (
        await call({
          method: "GET",
          path: "/v1/impact",
          query: { days: at.days },
          ok: [200],
        })
      ).body as Impact;
    },

    async propose(request: ProposeRequest): Promise<Proposal> {
      return (
        await call({ method: "POST", path: "/v1/propose", body: request, ok: [200] })
      ).body as Proposal;
    },

    async listConsumers(at?: Page & { contract?: string }): Promise<ConsumerPage> {
      return (
        await call({
          method: "GET",
          path: "/v1/consumers",
          query: { ...page(at), contract: at?.contract },
          ok: [200],
        })
      ).body as ConsumerPage;
    },

    async createLink(
      consumer: string,
      at: { expiresInDays?: number; idempotencyKey?: string } = {},
    ): Promise<{ url: string; expiresAt: number }> {
      return (
        await call({
          method: "POST",
          path: "/v1/links",
          headers: { "idempotency-key": at.idempotencyKey },
          body: {
            consumer,
            ...(at.expiresInDays === undefined
              ? {}
              : { expiresInDays: at.expiresInDays }),
          },
          ok: [201],
        })
      ).body as { url: string; expiresAt: number };
    },

    async listIntegrations(at?: Page): Promise<IntegrationPage> {
      return (
        await call({
          method: "GET",
          path: "/v1/integrations",
          query: page(at),
          ok: [200],
        })
      ).body as IntegrationPage;
    },

    /** How an SDK names what the contract describes, replacing any map its package had. */
    async putSdk(map: SdkMap): Promise<SdkMap> {
      return (await call({ method: "PUT", path: "/v1/sdks", body: map, ok: [200] }))
        .body as SdkMap;
    },

    async listSdks(): Promise<{ sdks: SdkMap[] }> {
      return (await call({ method: "GET", path: "/v1/sdks", ok: [200] })).body as {
        sdks: SdkMap[];
      };
    },

    async listMigrations(
      at?: Page & { status?: MigrationStatus },
    ): Promise<MigrationPage> {
      return (
        await call({
          method: "GET",
          path: "/v1/migrations",
          query: { ...page(at), status: at?.status },
          ok: [200],
        })
      ).body as MigrationPage;
    },

    async listTokens(): Promise<Token[]> {
      const answer = await call({ method: "GET", path: "/v1/tokens", ok: [200] });
      return (answer.body as { tokens: Token[] }).tokens;
    },

    async createToken(
      request: { name: string; scopes: Scope[]; expiresAt?: number },
      at: { idempotencyKey?: string } = {},
    ): Promise<IssuedToken> {
      return (
        await call({
          method: "POST",
          path: "/v1/tokens",
          headers: { "idempotency-key": at.idempotencyKey },
          body: request,
          ok: [201],
        })
      ).body as IssuedToken;
    },

    async revokeToken(id: string): Promise<void> {
      await call({ method: "DELETE", path: `/v1/tokens/${segment(id)}`, ok: [204] });
    },

    async listKeys(): Promise<PublisherKey[]> {
      const answer = await call({ method: "GET", path: "/v1/keys", ok: [200] });
      return (answer.body as { keys: PublisherKey[] }).keys;
    },

    async addKey(
      request: { name: string; publicKey: string; notAfter?: number },
      at: { idempotencyKey?: string } = {},
    ): Promise<PublisherKey> {
      return (
        await call({
          method: "POST",
          path: "/v1/keys",
          headers: { "idempotency-key": at.idempotencyKey },
          body: request,
          ok: [201],
        })
      ).body as PublisherKey;
    },

    async revokeKey(
      keyid: string,
      reason: string,
    ): Promise<{ key: PublisherKey; quarantined: number }> {
      return (
        await call({
          method: "POST",
          path: `/v1/keys/${segment(keyid)}/revoke`,
          body: { reason },
          ok: [200],
        })
      ).body as { key: PublisherKey; quarantined: number };
    },

    async listPublicBundles(api: string, at?: Page): Promise<BundlePage> {
      return (
        await call({
          method: "GET",
          path: `/public/v1/apis/${segment(api)}/bundles`,
          query: page(at),
          ok: [200],
        })
      ).body as BundlePage;
    },

    async getPublicBundle(api: string, digest: string): Promise<DsseEnvelope> {
      return (
        await call({
          method: "GET",
          path: `/public/v1/apis/${segment(api)}/bundles/${segment(digest)}`,
          ok: [200],
        })
      ).body as DsseEnvelope;
    },

    async health(): Promise<{ ok: true }> {
      return (await call({ method: "GET", path: "/health", ok: [200] })).body as {
        ok: true;
      };
    },
  };
}

export type ControlPlaneClient = ReturnType<typeof createClient>;
