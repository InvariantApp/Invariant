/**
 * The runtime as a reverse proxy, for a provider whose API is not written in
 * Node.
 *
 * Every provider in the real-data corpus falls in that group: Stripe, GitHub,
 * Twilio, Adyen, Plaid, Box, OpenAI, Intercom. Without this none of them could
 * adopt the part of the product that keeps an old integration working, so the
 * runtime was a feature for a minority of the market.
 *
 * It runs the same engine as the framework bindings and adds nothing to it. The
 * two stages that the in-process bindings split around the provider's own
 * authentication happen here in one pass, before the request reaches the
 * provider at all. That is also the one real constraint of running this way: a
 * signature covering the body or the path is computed by the caller over bytes
 * this proxy may rewrite, so a provider verifying one must run the in-process
 * binding instead. Everything else, bearer tokens, API keys, OAuth, mutual TLS
 * terminated upstream, is untouched.
 *
 * A request this proxy has nothing to do for is streamed straight through. Its
 * body is never read.
 */
import {
  type AdaptedRequest,
  CONTRACT_HINT_HEADER,
  DEFAULT_ERROR_SHAPER,
  type DecodedSite,
  ERROR_CODES,
  ERROR_ID_HEADER,
  type ErrorShaper,
  errorIdOf,
  GONE_STATUSES,
  goneWith,
  type InvariantRuntime,
  RetiredEndpointError,
  requestFailure,
  responseOf,
  type ShapedError,
  UnsupportedContractError,
} from "@invariant-app/runtime";
import { sendUpstream } from "./upstream.ts";

export interface ProxyOptions {
  runtime: InvariantRuntime;
  /** Where the provider's API listens. Any base path is kept. */
  upstream: string | URL;
  /**
   * Injected for tests. Defaults to Node's own HTTP client, which unlike
   * `fetch` sends the caller's Host and keeps a body sent with a 205.
   */
  fetch?: typeof fetch;
  /**
   * The Host the provider is sent. `upstream`, the default, is the upstream's
   * own, with the caller's in X-Forwarded-Host: a caller never chooses which
   * site a server that hosts several answers as. `caller` sends the one the
   * caller sent, for a sidecar in front of one application that builds its
   * links from it, as Gitea does; turn it on only where nothing else answers
   * behind the upstream's address.
   */
  upstreamHost?: "caller" | "upstream";
  /** How long the provider has to answer before the caller is told it did not. */
  upstreamTimeoutMs?: number;
  /**
   * Answers with what this proxy is running, so a deploy can check that the
   * proxy and the build behind it agree. Anything under it never reaches the
   * provider.
   */
  healthPath?: string;
  /**
   * Answers with the proxy's counters in Prometheus's text format, and never
   * reaches the provider. Absent means no metrics endpoint.
   */
  metrics?: { path: string; render: () => string };
  /** Paths passed through untouched, such as the provider's own health check. */
  skip?: (path: string) => boolean;
  errors?: ErrorShaper;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_PATH = "/__invariant/health";

/**
 * Headers that describe one connection rather than the message, and so must
 * not be passed from one hop to the next. RFC 9110 section 7.6.1.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type FetchHandler = (request: Request) => Promise<Response>;

export function createProxy(options: ProxyOptions): FetchHandler {
  const runtime = options.runtime;
  const upstream = new URL(options.upstream);
  const send = options.fetch ?? sendUpstream;
  const upstreamHost = options.upstreamHost ?? "upstream";
  const timeoutMs = options.upstreamTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const healthPath = options.healthPath ?? DEFAULT_HEALTH_PATH;
  const errors = options.errors ?? DEFAULT_ERROR_SHAPER;

  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new Error(`The upstream must be http or https, got ${upstream.protocol}`);
  }

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (options.metrics && url.pathname === options.metrics.path) {
      return new Response(options.metrics.render(), {
        status: 200,
        headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
      });
    }

    if (url.pathname === healthPath) {
      return json(200, {
        status: "ok",
        current: runtime.currentLabel,
        digest: runtime.currentDigest,
      });
    }

    const headers = forwardable(request.headers);
    // Forwarding headers are the caller's to send, or a proxy's in front of
    // this one: they are passed on as they came and never invented, since a
    // provider reads their presence as being behind a proxy that set them.
    // Gitea then builds its links from the Host, which is why that is the
    // caller's too.
    const callerHost = request.headers.get("host") ?? url.host;
    if (upstreamHost === "caller") {
      headers.set("host", callerHost);
    } else if (!headers.has("x-forwarded-host") && callerHost !== "") {
      headers.set("x-forwarded-host", callerHost);
    }
    // Only a caller who reached this proxy over TLS is told apart from one
    // who did not, where the provider behind it is not.
    if (
      url.protocol === "https:" &&
      upstream.protocol === "http:" &&
      !headers.has("x-forwarded-proto")
    ) {
      headers.set("x-forwarded-proto", "https");
    }
    // A caller must never be able to hand the engine a conclusion it did not
    // reach itself, so anything claiming to be internal is dropped on arrival.
    for (const name of [...headers.keys()]) {
      if (name.startsWith("x-invariant-")) headers.delete(name);
    }

    if (options.skip?.(url.pathname)) {
      return forward(
        request,
        request.method,
        url.pathname,
        url.search,
        headers,
        request.body,
        undefined,
      );
    }

    // Stage one decides which handler the provider should see, and stage two
    // which contract, and whether there is any work at all. Both can refuse, so
    // both sit inside the same handler for what a caller is told.
    let decision: ReturnType<InvariantRuntime["route"]>;
    let contract: string;
    let site: DecodedSite | undefined;
    try {
      decision = runtime.route(request.method, url.pathname, headers);
      if (decision.hint) headers.set(CONTRACT_HINT_HEADER, decision.hint.label);
      contract = runtime.resolve(headers, decision.path, undefined).label;
      site = runtime.siteFor(contract, decision.method, decision.path);
    } catch (error) {
      if (error instanceof UnsupportedContractError) {
        const errorId = errorIdOf(error);
        return shapedResponse({
          ...errors.badRequest(error.message, ERROR_CODES.contractUnsupported, errorId),
          errorId,
        });
      }
      if (error instanceof RetiredEndpointError) {
        const errorId = errorIdOf(error);
        return shapedResponse({
          ...goneWith(errors)(error.message, ERROR_CODES.endpointRetired, errorId),
          errorId,
        });
      }
      throw error;
    }
    // The hint has done its job, and the provider has no business reading it.
    headers.delete(CONTRACT_HINT_HEADER);

    const operation = `${decision.method.toLowerCase()} ${decision.path}`;
    const context = { contract, operation, consumer: undefined };

    // A JSON body, and a form or XML one the site describes, is something the
    // program describes. An upload goes on as it came, and the provider
    // answers it as it would.
    let adapted: AdaptedRequest = {
      path: decision.path,
      search: url.search,
      // Tags this runtime marked for the caller's contract are unmarked, so
      // the provider can answer a conditional request from its own tags.
      headers: runtime.conditionalHeaders(headers, contract, site),
      body: request.body,
    };
    if (site) {
      try {
        adapted = await runtime.adaptRequest(site, request, adapted, context);
      } catch (error) {
        return failRequest(errors, error);
      }
    }

    const answer = await forward(
      request,
      decision.method,
      adapted.path,
      adapted.search,
      adapted.headers,
      adapted.body,
      {
        site,
        contract,
        context,
      },
    );
    // An operation retired after the caller's contract reached the provider;
    // if the provider says it is gone, the caller hears why and what to use.
    const retired = runtime.retiredFor(contract, request.method, decision.path);
    if (retired && GONE_STATUSES.has(answer.status)) {
      await answer.body?.cancel();
      return shapedResponse(
        goneWith(errors)(retired.message, ERROR_CODES.endpointRetired),
      );
    }
    return answer;
  };

  async function forward(
    request: Request,
    method: string,
    path: string,
    search: string,
    headers: Headers,
    body: ReadableStream<Uint8Array> | string | null,
    adapted:
      | {
          site: DecodedSite | undefined;
          contract: string;
          context: { contract: string; operation: string; consumer: undefined };
        }
      | undefined,
  ): Promise<Response> {
    const target = targetFor(upstream, path, search);
    if (!target) {
      return shapedResponse(
        errors.badRequest(
          "The request path leaves the API this proxy fronts.",
          ERROR_CODES.requestNotTranslatable,
        ),
      );
    }

    // A method with no body sends none, including when a route changed a
    // POST into a GET and its fields moved into the query string, and says
    // nothing of one: a GET that came with a body, as Immich's suite sends,
    // is sent on without it, and the length of what was left out would have
    // the provider wait for bytes that never come.
    const bodyless = method === "GET" || method === "HEAD";
    if (bodyless) {
      const described =
        body !== null ||
        (headers.get("content-length") ?? "0") !== "0" ||
        headers.has("transfer-encoding");
      headers.delete("content-length");
      headers.delete("transfer-encoding");
      if (described) headers.delete("content-type");
    }
    let answer: Response;
    try {
      answer = await send(target, {
        method,
        headers,
        ...(body !== null && !bodyless ? { body, duplex: "half" as const } : {}),
        // A redirect is the provider's answer to the caller, not an instruction
        // to this proxy. Following it would also let an upstream bounce a
        // request somewhere it was never meant to go.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      } as RequestInit);
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      return shapedResponse({
        ...errors.serverError(
          timedOut
            ? `The API did not answer within ${timeoutMs} ms.`
            : "The API could not be reached.",
          ERROR_CODES.upstreamUnavailable,
        ),
        status: timedOut ? 504 : 502,
      });
    }

    const out = forwardable(answer.headers);
    // The body arrives decoded, so its declared length describes bytes this
    // proxy no longer holds, and so does its encoding where it was undone:
    // passing that on would have a client decompress plain text. An injected
    // `fetch` undoes it without saying so.
    if (options.fetch) out.delete("content-encoding");
    out.delete("content-length");

    if (!adapted) return responseOf(answer.body, answer.status, out);
    // The body has already been decoded, so it is read as it stands.
    return runtime.adaptResponse(
      adapted.site,
      responseOf(answer.body, answer.status, out),
      adapted.context,
      { encoded: out.has("content-encoding"), method: request.method, errors },
    );
  }
}

/**
 * The provider's URL for a request, or nothing if the request would leave it.
 *
 * The path is assigned rather than resolved as a reference. Handing a caller's
 * path to the URL parser as a relative reference would let `//elsewhere/x`
 * choose a different host, which turns a proxy into an open relay.
 */
export function targetFor(upstream: URL, path: string, search: string): URL | undefined {
  const base = upstream.pathname.replace(/\/+$/, "");
  // Only a base path can be left. In front of a whole server there is nothing
  // outside it to reach, and the server answers such a path itself: Qdrant's
  // own suite sends `..%2F..%2Fetc%2Fpasswd` for a snapshot and expects its
  // 404, which a refusal here turned into this proxy's 400.
  if (base !== "" && hidesTraversal(path)) return undefined;
  const target = new URL(upstream.href);
  target.pathname = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  target.search = search;
  if (target.origin !== upstream.origin) return undefined;
  if (
    base !== "" &&
    target.pathname !== base &&
    !target.pathname.startsWith(`${base}/`)
  ) {
    return undefined;
  }
  return target;
}

/**
 * Whether a path holds a step up that only decoding reveals.
 *
 * The URL parser already resolves `..` and `%2e%2e` written as segments of
 * their own, so those never get here. `..%2f` does, and so does `..%5c`,
 * because to a URL an escaped slash is part of a segment's name. Plenty of
 * servers decode it before they route, and to them `/api/..%2fadmin` is
 * `/admin`: outside the base path this proxy fronts, reached through it. No
 * API names a resource that way, so where there is a base path such a path is
 * refused as leaving the API. Found by the threat-model tests.
 */
export function hidesTraversal(path: string): boolean {
  for (const segment of path.split("/")) {
    if (!segment.includes("%")) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      continue;
    }
    if (decoded.split(/[/\\]/).some((part) => part === "." || part === "..")) return true;
  }
  return false;
}

/** A copy without hop-by-hop headers, or any the Connection header names. */
function forwardable(source: Headers): Headers {
  const named = new Set(
    (source.get("connection") ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
  const out = new Headers();
  for (const [name, value] of source) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || named.has(lower) || lower === "host") continue;
    out.append(name, value);
  }
  return out;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A refusal in the provider's shape, with the id the caller can quote. */
function shapedResponse(shaped: ShapedError): Response {
  const response = json(shaped.status, shaped.body);
  if (shaped.errorId !== undefined) response.headers.set(ERROR_ID_HEADER, shaped.errorId);
  return response;
}

function failRequest(errors: ErrorShaper, error: unknown): Response {
  const shaped = requestFailure(errors, error);
  if (!shaped) throw error;
  return shapedResponse(shaped);
}
