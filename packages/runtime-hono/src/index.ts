/**
 * Hono bindings.
 *
 * Two pieces, because the two stages belong at different points in the
 * lifecycle. `wrapFetch` sits outside routing, where it can still change which
 * handler will be chosen. `adapt` is ordinary middleware that the provider
 * mounts after its own authentication, where the body can be rewritten without
 * disturbing anything computed over the original bytes.
 */
import {
  BodyTooLargeError,
  CONTRACT_HINT_HEADER,
  CONTRACT_RESPONSE_HEADER,
  DEFAULT_ERROR_SHAPER,
  ERROR_CODES,
  type ErrorShaper,
  FOLDED_HEADER,
  goneWith,
  InvariantRuntime,
  RetiredEndpointError,
  TransformError,
  UnsupportedContractError,
} from "@invariant/runtime";
import type { Context, MiddlewareHandler, Next } from "hono";

/** Where `adapt` leaves the contract it resolved, for handlers to branch on. */
const CONTRACT_KEY = "invariantContract";

/**
 * The contract this request is being served under.
 *
 * Throws when `adapt` did not run for this route, because the alternative is
 * quietly assuming the caller is current. A route reached without the adapter
 * is a wiring mistake, and a behaviour branch that reads it would take the
 * wrong side of itself for every old caller.
 */
export function contractOf(c: Context): string {
  const label = c.get(CONTRACT_KEY) as string | undefined;
  if (label === undefined) {
    throw new Error(
      `No contract resolved for ${c.req.method} ${c.req.path}. Mount adapt() on this route before reading it.`,
    );
  }
  return label;
}

/**
 * Whether this caller predates the change a behaviour flag marks.
 *
 * The provider-code half of everything the IR cannot express. See
 * `InvariantRuntime.before`, including why this must never gate authorisation.
 */
export function before(
  runtime: InvariantRuntime,
  c: Context,
  flag: string,
  consumerId?: (c: Context) => string | undefined,
): boolean {
  return runtime.before(flag, {
    contract: contractOf(c),
    operation: `${c.req.method.toLowerCase()} ${c.req.path}`,
    consumer: consumerId?.(c),
  });
}

export type FetchHandler = (
  request: Request,
  ...rest: never[]
) => Response | Promise<Response>;

export type { ErrorShaper };

export interface HonoBindingOptions {
  runtime: InvariantRuntime;
  /** Reads the account's pinned contract from whatever authentication produced. */
  pinnedContract?: (c: Context) => string | undefined;
  /** Identifies the caller for usage counting. Never a raw credential. */
  consumerId?: (c: Context) => string | undefined;
  errors?: ErrorShaper;
  /** Paths the runtime should ignore entirely, such as health checks. */
  skip?: (path: string) => boolean;
}

/**
 * Stage one: runs before routing.
 *
 * Also the only place inbound internal headers are stripped, so a caller can
 * never hand stage two a conclusion that stage one did not reach.
 */
export function wrapFetch(
  handler: FetchHandler,
  options: HonoBindingOptions,
): FetchHandler {
  const { runtime, skip } = options;

  return (request: Request, ...rest: never[]) => {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    const hadInternal = [...headers.keys()].some((name) =>
      name.toLowerCase().startsWith("x-invariant-"),
    );
    if (hadInternal) InvariantRuntime.sanitizeHeaders(headers);

    if (skip?.(url.pathname)) {
      const cleaned = hadInternal
        ? new Request(url, { ...requestInit(request), headers })
        : request;
      return handler(cleaned, ...rest);
    }

    let decision: ReturnType<InvariantRuntime["route"]>;
    try {
      decision = runtime.route(request.method, url.pathname, headers);
    } catch (error) {
      if (error instanceof UnsupportedContractError) {
        // Refused before routing, because a caller who named a contract that
        // does not exist must not be routed as though they had named none.
        const shaped = (options.errors ?? DEFAULT_ERROR_SHAPER).badRequest(
          error.message,
          ERROR_CODES.contractUnsupported,
        );
        return Response.json(shaped.body, { status: shaped.status });
      }
      throw error;
    }
    if (decision.hint) headers.set(CONTRACT_HINT_HEADER, decision.hint.label);

    if (!decision.rewritten && !decision.hint && !hadInternal) {
      return handler(request, ...rest);
    }

    url.pathname = decision.path;
    return handler(new Request(url, { ...requestInit(request), headers }), ...rest);
  };
}

function requestInit(request: Request): RequestInit & { duplex?: "half" } {
  return {
    method: request.method,
    body: request.body,
    redirect: request.redirect,
    signal: request.signal,
    ...(request.body ? { duplex: "half" as const } : {}),
  };
}

/**
 * Stage two: mount this after authentication.
 *
 * A request on the current contract, or on an operation nothing ever changed,
 * falls straight through without the body being read at all.
 */
export function adapt(options: HonoBindingOptions): MiddlewareHandler {
  const {
    runtime,
    pinnedContract,
    consumerId,
    errors = DEFAULT_ERROR_SHAPER,
    skip,
  } = options;

  return async (c: Context, next: Next) => {
    if (skip?.(c.req.path)) return next();

    let contract: string;
    let site: ReturnType<InvariantRuntime["siteFor"]>;
    try {
      contract = runtime.resolve(
        c.req.raw.headers,
        c.req.path,
        pinnedContract?.(c),
      ).label;
      site = runtime.siteFor(contract, c.req.method, c.req.path);
    } catch (error) {
      if (error instanceof UnsupportedContractError) {
        const shaped = errors.badRequest(error.message, "invariant_contract_unsupported");
        return c.json(shaped.body as never, shaped.status as never);
      }
      if (error instanceof RetiredEndpointError) {
        // The whole point of retiring an endpoint is that the caller is told
        // what to use instead. This used to fall through as an unexplained 500,
        // so the provider's guidance never reached anyone.
        const shaped = goneWith(errors)(error.message, ERROR_CODES.endpointRetired);
        return c.json(shaped.body as never, shaped.status as never);
      }
      throw error;
    }

    // Set before the handler runs, so a behaviour branch inside it can read it
    // whether or not this operation has any compiled work of its own.
    c.set(CONTRACT_KEY, contract);

    if (!site) {
      await next();
      if (contract !== runtime.currentLabel) {
        c.res.headers.set(CONTRACT_RESPONSE_HEADER, contract);
      }
      return undefined;
    }

    const operation = `${c.req.method.toLowerCase()} ${c.req.path}`;
    const consumer = consumerId?.(c);

    if (site.request.length > 0 && c.req.raw.body) {
      try {
        const original = await c.req.raw.clone().text();
        const transformed = runtime.transformRequest(site, original, {
          contract,
          operation,
          consumer,
        });
        // Replace the request the handler will read, leaving everything the
        // caller signed already verified upstream.
        c.req.raw = new Request(c.req.raw.url, {
          method: c.req.raw.method,
          headers: withContentLength(c.req.raw.headers, transformed),
          body: transformed,
        });
      } catch (error) {
        return failRequest(c, errors, error);
      }
    }

    await next();

    if (!runtime.respondsTo(site, c.res.status)) {
      c.res.headers.set(CONTRACT_RESPONSE_HEADER, contract);
      return undefined;
    }

    try {
      const original = await c.res.clone().text();
      const transformed = runtime.transformResponseDetailed(
        site,
        c.res.status,
        original,
        { contract, operation, consumer },
      );
      const headers = withContentLength(c.res.headers, transformed.body);
      headers.set(CONTRACT_RESPONSE_HEADER, contract);
      if (transformed.folded.length > 0) {
        // Only when a fold fired. The caller was shown a value their contract
        // names in place of one it does not, and this is how they can know.
        headers.set(FOLDED_HEADER, transformed.folded.join(", "));
      }
      c.res = new Response(transformed.body, { status: c.res.status, headers });
    } catch (error) {
      return failResponse(c, errors, error);
    }

    return undefined;
  };
}

function withContentLength(source: Headers, body: string): Headers {
  const headers = new Headers(source);
  headers.set("content-length", String(new TextEncoder().encode(body).byteLength));
  return headers;
}

function failRequest(c: Context, errors: ErrorShaper, error: unknown): Response {
  // Nothing has run yet, so refusing here means no side effect happened.
  if (error instanceof BodyTooLargeError) {
    const shaped = errors.badRequest(error.message, "invariant_body_too_large");
    return c.json(shaped.body as never, 413 as never);
  }
  if (error instanceof TransformError || error instanceof SyntaxError) {
    const shaped = errors.badRequest(error.message, "invariant_request_not_translatable");
    return c.json(shaped.body as never, shaped.status as never);
  }
  throw error;
}

function failResponse(c: Context, errors: ErrorShaper, error: unknown): Response {
  // The operation already happened. The one thing that must not happen now is
  // handing back a body shaped for a contract the caller does not speak.
  if (error instanceof TransformError || error instanceof BodyTooLargeError) {
    const shaped = errors.serverError(
      "The response could not be expressed in the contract this integration uses.",
      "invariant_response_not_translatable",
    );
    return c.json(shaped.body as never, shaped.status as never);
  }
  throw error;
}
