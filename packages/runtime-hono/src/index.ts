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
  CONTRACT_HINT_HEADER,
  DEFAULT_ERROR_SHAPER,
  ERROR_CODES,
  type ErrorShaper,
  GONE_STATUSES,
  goneWith,
  InvariantRuntime,
  RetiredEndpointError,
  requestFailure,
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
    const init = requestInit(request);
    // A route can change the method, and a method with no body sends none.
    const method = decision.method;
    const bodyless = method === "GET" || method === "HEAD";
    if (bodyless && request.body) {
      headers.delete("content-length");
      headers.delete("content-type");
    }
    return handler(
      new Request(url, {
        ...init,
        method,
        ...(bodyless ? { body: null } : {}),
        headers,
      }),
      ...rest,
    );
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

  // Hono has matched the route, and bound its path parameters, before any
  // middleware runs, so a path parameter converted here would never reach the
  // handler. Refused where it is mounted rather than served wrong.
  if (runtime.rewritesPathParameters) {
    throw new Error(
      "This program converts a path parameter, which an in-process binding cannot " +
        "serve because the route is matched before it runs. Run the proxy in front " +
        "of this service instead.",
    );
  }

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
      site = runtime.siteFor(contract, c.req.method, c.req.path, {
        operation: `${c.req.method.toLowerCase()} ${c.req.path}`,
        consumer: consumerId?.(c),
      });
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

    const operation = `${c.req.method.toLowerCase()} ${c.req.path}`;
    const consumer = consumerId?.(c);

    if (!site) {
      await next();
      if (answerRetired(c, runtime, errors, contract)) return undefined;
      // Nothing to rewrite, but the answer still names its contract and
      // varies on the header that chose it.
      replaceResponse(
        c,
        await runtime.adaptResponse(
          undefined,
          c.res,
          { contract, operation, consumer },
          { encoded: true, method: c.req.method, errors },
        ),
      );
      return undefined;
    }

    // Only a JSON body is something the program describes. Anything else, a
    // form, an upload, is passed on as it came, and the provider's own handler
    // answers it as it would for any caller.
    const request = c.req.raw;
    if (runtime.readsRequestBody(site) || site.envelope) {
      try {
        const url = new URL(request.url);
        const adapted = await runtime.adaptRequest(
          site,
          request.clone(),
          { path: url.pathname, search: url.search, headers: request.headers },
          { contract, operation, consumer },
        );
        // Replace the request the handler will read, leaving everything the
        // caller signed already verified upstream.
        url.pathname = adapted.path;
        url.search = adapted.search;
        c.req.raw = new Request(url, {
          method: request.method,
          headers: adapted.headers,
          ...(adapted.body === null
            ? {}
            : { body: adapted.body, duplex: "half" as const }),
        } as RequestInit);
      } catch (error) {
        return failRequest(c, errors, error);
      }
    }

    // Tags this runtime marked for the caller's contract are unmarked, so the
    // handler can answer a conditional request from its own tags.
    const conditional = runtime.conditionalHeaders(c.req.raw.headers, contract, site);
    if (conditional !== c.req.raw.headers) {
      c.req.raw = new Request(c.req.raw, {
        headers: conditional,
        duplex: "half",
      } as RequestInit);
    }

    await next();
    if (answerRetired(c, runtime, errors, contract)) return undefined;

    replaceResponse(
      c,
      await runtime.adaptResponse(
        site,
        c.res,
        { contract, operation, consumer },
        { encoded: true, method: request.method, errors },
      ),
    );

    return undefined;
  };
}

/**
 * An operation retired after the caller's contract reached the handler. If
 * the handler says it is gone, the caller is told why and what to use
 * instead; any other answer, including a 404 for a missing record, goes back
 * as the handler gave it. True when the answer was replaced.
 */
function answerRetired(
  c: Context,
  runtime: InvariantRuntime,
  errors: ErrorShaper,
  contract: string,
): boolean {
  const retired = runtime.retiredFor(contract, c.req.method, c.req.path);
  if (!retired || !GONE_STATUSES.has(c.res.status)) return false;
  const shaped = goneWith(errors)(retired.message, ERROR_CODES.endpointRetired);
  replaceResponse(
    c,
    new Response(JSON.stringify(shaped.body), {
      status: shaped.status,
      headers: { "content-type": "application/json" },
    }),
  );
  return true;
}

/**
 * Swaps the response the handler produced for another one, whole.
 *
 * Assigning `c.res` directly merges the old response's headers over the new
 * one's, so the handler's `content-encoding`, `content-length` or `etag` would
 * describe a body that is no longer being sent. Clearing it first is how
 * Hono's own middleware replaces a response.
 */
function replaceResponse(c: Context, response: Response): void {
  c.res = undefined as unknown as Response;
  c.res = response;
}

function failRequest(c: Context, errors: ErrorShaper, error: unknown): Response {
  const shaped = requestFailure(errors, error);
  if (!shaped) throw error;
  return c.json(shaped.body as never, shaped.status as never);
}
