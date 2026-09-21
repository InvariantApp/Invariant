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
  BodyTooLargeError,
  CONTRACT_HINT_HEADER,
  CONTRACT_RESPONSE_HEADER,
  DEFAULT_ERROR_SHAPER,
  type DecodedSite,
  ERROR_CODES,
  type ErrorShaper,
  FOLDED_HEADER,
  goneWith,
  type InvariantRuntime,
  RetiredEndpointError,
  type ShapedError,
  TransformError,
  UnsupportedContractError,
} from "@invariant/runtime";

export interface ProxyOptions {
  runtime: InvariantRuntime;
  /** Where the provider's API listens. Any base path is kept. */
  upstream: string | URL;
  /** Injected for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Largest body buffered on a request or response that has to be rewritten. */
  maxBodyBytes?: number;
  /** How long the provider has to answer before the caller is told it did not. */
  upstreamTimeoutMs?: number;
  /**
   * Answers with what this proxy is running, so a deploy can check that the
   * proxy and the build behind it agree. Anything under it never reaches the
   * provider.
   */
  healthPath?: string;
  /** Paths passed through untouched, such as the provider's own health check. */
  skip?: (path: string) => boolean;
  errors?: ErrorShaper;
}

const DEFAULT_MAX_BODY = 1024 * 1024;
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
  const send = options.fetch ?? fetch;
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const timeoutMs = options.upstreamTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const healthPath = options.healthPath ?? DEFAULT_HEALTH_PATH;
  const errors = options.errors ?? DEFAULT_ERROR_SHAPER;

  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new Error(`The upstream must be http or https, got ${upstream.protocol}`);
  }

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname === healthPath) {
      return json(200, {
        status: "ok",
        current: runtime.currentLabel,
        digest: runtime.currentDigest,
      });
    }

    const headers = forwardable(request.headers);
    // A caller must never be able to hand the engine a conclusion it did not
    // reach itself, so anything claiming to be internal is dropped on arrival.
    for (const name of [...headers.keys()]) {
      if (name.startsWith("x-invariant-")) headers.delete(name);
    }

    if (options.skip?.(url.pathname)) {
      return forward(request, url.pathname, url.search, headers, request.body, undefined);
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
      site = runtime.siteFor(contract, request.method, decision.path);
    } catch (error) {
      if (error instanceof UnsupportedContractError) {
        return shapedResponse(
          errors.badRequest(error.message, ERROR_CODES.contractUnsupported),
        );
      }
      if (error instanceof RetiredEndpointError) {
        return shapedResponse(
          goneWith(errors)(error.message, ERROR_CODES.endpointRetired),
        );
      }
      throw error;
    }
    // The hint has done its job, and the provider has no business reading it.
    headers.delete(CONTRACT_HINT_HEADER);

    const operation = `${request.method.toLowerCase()} ${decision.path}`;
    const context = { contract, operation, consumer: undefined };

    let body: ReadableStream<Uint8Array> | string | null = request.body;
    if (site && site.request.length > 0 && request.body) {
      try {
        const original = await readBounded(request, maxBody);
        const rewritten = runtime.transformRequest(site, original, context);
        body = rewritten;
        headers.set("content-length", String(byteLength(rewritten)));
      } catch (error) {
        return failRequest(errors, error);
      }
    }

    return forward(request, decision.path, url.search, headers, body, {
      site,
      contract,
      context,
    });
  };

  async function forward(
    request: Request,
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

    headers.set("x-forwarded-host", new URL(request.url).host);
    headers.set("x-forwarded-proto", new URL(request.url).protocol.replace(":", ""));

    let answer: Response;
    try {
      answer = await send(target, {
        method: request.method,
        headers,
        ...(body !== null && request.method !== "GET" && request.method !== "HEAD"
          ? { body, duplex: "half" as const }
          : {}),
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
    // The body arrives already decoded, so its declared encoding and length
    // describe bytes this proxy no longer holds. Passing them on would have a
    // client decompress plain text.
    out.delete("content-encoding");
    out.delete("content-length");

    const current = runtime.currentLabel;
    if (adapted && adapted.contract !== current) {
      out.set(CONTRACT_RESPONSE_HEADER, adapted.contract);
    }

    const site = adapted?.site;
    if (
      !site ||
      !answer.body ||
      !runtime.respondsTo(site, answer.status) ||
      !isJson(answer.headers.get("content-type"))
    ) {
      // Nothing to rewrite, or nothing this proxy can safely read: an upstream
      // error page in HTML is passed through as it is rather than mangled.
      return new Response(answer.body, { status: answer.status, headers: out });
    }

    try {
      const original = await readBounded(answer, maxBody);
      const transformed = runtime.transformResponseDetailed(
        site,
        answer.status,
        original,
        adapted.context,
      );
      out.set("content-length", String(byteLength(transformed.body)));
      if (transformed.folded.length > 0) {
        out.set(FOLDED_HEADER, transformed.folded.join(", "));
      }
      return new Response(transformed.body, { status: answer.status, headers: out });
    } catch (error) {
      return failResponse(errors, error);
    }
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
  const target = new URL(upstream.href);
  const base = upstream.pathname.replace(/\/+$/, "");
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

/**
 * Reads a body as text, refusing past the limit without holding the rest.
 *
 * A declared length over the limit is refused before a byte is read. One that
 * lies, or none at all, is counted as it arrives, so a caller cannot make this
 * proxy buffer an unbounded body by leaving the header off.
 */
async function readBounded(message: Request | Response, limit: number): Promise<string> {
  const declared = Number(message.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLargeError(limit);
  if (!message.body) return "";

  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new BodyTooLargeError(limit);
    }
    chunks.push(value);
  }
  const whole = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    whole.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(whole);
}

function isJson(contentType: string | null): boolean {
  if (!contentType) return false;
  const media = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return media === "application/json" || media.endsWith("+json");
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function shapedResponse(shaped: ShapedError): Response {
  return json(shaped.status, shaped.body);
}

function failRequest(errors: ErrorShaper, error: unknown): Response {
  // Nothing has reached the provider yet, so refusing here has no side effect.
  if (error instanceof BodyTooLargeError) {
    return shapedResponse({
      ...errors.badRequest(error.message, ERROR_CODES.bodyTooLarge),
      status: 413,
    });
  }
  if (error instanceof TransformError || error instanceof SyntaxError) {
    return shapedResponse(
      errors.badRequest(error.message, ERROR_CODES.requestNotTranslatable),
    );
  }
  throw error;
}

function failResponse(errors: ErrorShaper, error: unknown): Response {
  // The operation already happened. What must not happen now is handing back a
  // body shaped for a contract the caller does not speak.
  if (
    error instanceof TransformError ||
    error instanceof BodyTooLargeError ||
    error instanceof SyntaxError
  ) {
    return shapedResponse(
      errors.serverError(
        "The response could not be expressed in the contract this integration uses.",
        ERROR_CODES.responseNotTranslatable,
      ),
    );
  }
  throw error;
}
