/**
 * The runtime in any Node server, at the level every framework shares.
 *
 * Express, Koa, Connect, NestJS on Express, a Next.js custom server and
 * Fastify through its `serverFactory` all end in a `node:http` request
 * listener, so wrapping that one listener serves all of them with one piece
 * of code, and one conformance suite holds every framework to it. What a
 * request becomes and what a caller is told are the runtime's own rules,
 * shared with the Hono binding and the proxy; this file only moves bytes
 * between Node's types and those rules.
 *
 * A request whose body is not rewritten is changed in place, its stream left
 * alone, so a request the program has no work for is never buffered. One
 * whose body is rewritten is handed on as a fresh message carrying the new
 * body. A response is held only when its body has to be read, which is when
 * the site has work for its status and the body is JSON; everything else
 * streams through with its headers corrected on the way.
 */
import { IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  appendVary,
  CONTRACT_HINT_HEADER,
  CONTRACT_RESPONSE_HEADER,
  DEFAULT_ERROR_SHAPER,
  type DecodedSite,
  ERROR_CODES,
  ERROR_ID_HEADER,
  type ErrorShaper,
  errorIdOf,
  goneWith,
  InvariantRuntime,
  isJsonMediaType,
  RetiredEndpointError,
  requestFailure,
  type ShapedError,
  UnsupportedContractError,
} from "@invariant/runtime";

export type Listener = (request: IncomingMessage, response: ServerResponse) => void;

export interface NodeBindingOptions {
  runtime: InvariantRuntime;
  errors?: ErrorShaper;
  /** Who is calling, for counting; the runtime hashes it before it leaves. */
  consumerId?: (request: IncomingMessage) => string | undefined;
  /**
   * The contract pinned to the caller's account. Only known after the
   * provider has authenticated them, so only the middleware form, mounted
   * after authentication, can use it.
   */
  pinnedContract?: (request: IncomingMessage) => string | undefined;
  /** Paths passed through untouched. */
  skip?: (path: string) => boolean;
}

/** The request as the handler should see it, or nothing when it was answered here. */
type Prepared =
  | { answered: true }
  | {
      answered: false;
      request: IncomingMessage;
      /** Where the response's headers and body are corrected, when there is anything to do. */
      site: DecodedSite | undefined;
      context: { contract: string; operation: string; consumer: string | undefined };
    };

/**
 * A request listener with the runtime in front of it: `http.createServer(
 * adaptListener(app, { runtime }))` for Express or Koa's `app.callback()`,
 * or Fastify's `serverFactory`.
 *
 * Runs before anything in the application, so a signature over the request
 * body is checked against the adapted body. Where that matters, mount
 * `adaptMiddleware` after the check instead.
 */
export function adaptListener(listener: Listener, options: NodeBindingOptions): Listener {
  return (request, response) => {
    void prepare(request, response, options).then(
      (prepared) => {
        if (prepared.answered) return;
        intercept(response, prepared, options);
        listener(prepared.request, response);
      },
      (error: unknown) => failed(response, error),
    );
  };
}

/**
 * The runtime as Connect-style middleware, `(request, response, next)`, for
 * Express and anything like it, mounted after the provider's own
 * authentication and signature checks so they see the body the caller sent.
 *
 * A body already parsed by an earlier middleware is adapted where it lies, in
 * `request.body`. One not yet read is read, adapted and left parsed there,
 * with `request._body` set so a later body parser does not try to read a
 * stream that has already been read.
 */
export function adaptMiddleware(
  options: NodeBindingOptions,
): (
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void,
) => void {
  return (request, response, next) => {
    void prepareInPlace(request, response, options).then(
      (prepared) => {
        if (prepared.answered) return;
        intercept(response, prepared, options);
        next();
      },
      (error: unknown) => next(error),
    );
  };
}

/** A request's headers in the web's form, every value kept. */
function webHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    headers.append(
      request.rawHeaders[index] as string,
      request.rawHeaders[index + 1] as string,
    );
  }
  InvariantRuntime.sanitizeHeaders(headers);
  return headers;
}

/** Headers in the form a `node:http` message carries them. */
function toRawHeaders(headers: Headers): string[] {
  return [...headers].flatMap(([name, value]) => [name, value]);
}

function toHeaderObject(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers);
}

/** Writes a refusal in the provider's shape, with the id the caller can quote. */
function answer(response: ServerResponse, shaped: ShapedError): void {
  response.statusCode = shaped.status;
  response.setHeader("content-type", "application/json");
  if (shaped.errorId !== undefined) response.setHeader(ERROR_ID_HEADER, shaped.errorId);
  response.end(JSON.stringify(shaped.body));
}

/** Something went wrong that is not a caller's fault, and nothing about it is sent. */
function failed(response: ServerResponse, error: unknown): void {
  process.emitWarning(
    `invariant: ${error instanceof Error ? error.stack : String(error)}`,
  );
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.statusCode = 500;
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      error: {
        type: "api_error",
        message: "Internal error.",
        code: "invariant_internal",
      },
    }),
  );
}

interface Decided {
  contract: string;
  site: DecodedSite | undefined;
  method: string;
  path: string;
  search: string;
  headers: Headers;
  rewritten: boolean;
  operation: string;
  consumer: string | undefined;
}

/**
 * Stage one and stage two: which handler the request is for, which contract
 * the caller speaks, and whether there is any work. Refusals are answered
 * here and return nothing.
 */
function decide(
  request: IncomingMessage,
  response: ServerResponse,
  options: NodeBindingOptions,
): Decided | undefined {
  const { runtime } = options;
  const errors = options.errors ?? DEFAULT_ERROR_SHAPER;
  const url = new URL(request.url ?? "/", "http://placeholder.invalid");
  const headers = webHeaders(request);
  try {
    const decision = runtime.route(request.method ?? "GET", url.pathname, headers);
    if (decision.hint) headers.set(CONTRACT_HINT_HEADER, decision.hint.label);
    const contract = runtime.resolve(
      headers,
      decision.path,
      options.pinnedContract?.(request),
    ).label;
    headers.delete(CONTRACT_HINT_HEADER);
    const operation = `${decision.method.toLowerCase()} ${decision.path}`;
    const consumer = options.consumerId?.(request);
    const site = runtime.siteFor(contract, decision.method, decision.path, {
      operation,
      consumer,
    });
    return {
      contract,
      site,
      method: decision.method,
      path: decision.path,
      search: url.search,
      headers: runtime.conditionalHeaders(headers, contract, site),
      rewritten: decision.rewritten,
      operation,
      consumer,
    };
  } catch (error) {
    if (error instanceof UnsupportedContractError) {
      const errorId = errorIdOf(error);
      answer(response, {
        ...errors.badRequest(error.message, ERROR_CODES.contractUnsupported, errorId),
        errorId,
      });
      return undefined;
    }
    if (error instanceof RetiredEndpointError) {
      const errorId = errorIdOf(error);
      answer(response, {
        ...goneWith(errors)(error.message, ERROR_CODES.endpointRetired, errorId),
        errorId,
      });
      return undefined;
    }
    throw error;
  }
}

async function prepare(
  request: IncomingMessage,
  response: ServerResponse,
  options: NodeBindingOptions,
): Promise<Prepared> {
  const { runtime } = options;
  const path = new URL(request.url ?? "/", "http://placeholder.invalid").pathname;
  if (options.skip?.(path)) {
    return { answered: false, request, site: undefined, context: skipped(path) };
  }
  const decided = decide(request, response, options);
  if (!decided) return { answered: true };
  const context = {
    contract: decided.contract,
    operation: decided.operation,
    consumer: decided.consumer,
  };

  let adapted = { path: decided.path, search: decided.search, headers: decided.headers };
  let body: ReadableStream<Uint8Array> | string | null | undefined;
  const site = decided.site;
  if (site && (runtime.readsRequestBody(site) || site.envelope)) {
    const hasBody =
      runtime.readsRequestBody(site) &&
      request.method !== "GET" &&
      request.method !== "HEAD";
    try {
      const result = await runtime.adaptRequest(
        site,
        new Request(`http://placeholder.invalid${decided.path}${decided.search}`, {
          method: decided.method,
          headers: decided.headers,
          ...(hasBody
            ? {
                body: Readable.toWeb(request) as ReadableStream<Uint8Array>,
                duplex: "half",
              }
            : {}),
        } as RequestInit),
        { path: decided.path, search: decided.search, headers: decided.headers },
        context,
      );
      adapted = { path: result.path, search: result.search, headers: result.headers };
      if (hasBody) body = result.body;
    } catch (error) {
      const shaped = requestFailure(options.errors ?? DEFAULT_ERROR_SHAPER, error);
      if (!shaped) throw error;
      answer(response, shaped);
      return { answered: true };
    }
  }

  if (body === undefined) {
    // The body is untouched, so the message is changed where it lies and its
    // stream is never read here.
    request.method = decided.method;
    request.url = `${adapted.path}${adapted.search}`;
    request.headers = toHeaderObject(adapted.headers);
    request.rawHeaders = toRawHeaders(adapted.headers);
    return { answered: false, request, site, context };
  }
  return {
    answered: false,
    request: replacement(request, decided.method, adapted, body),
    site,
    context,
  };
}

/** The middleware form: the same decisions, with the body adapted where it lies. */
async function prepareInPlace(
  request: IncomingMessage & { body?: unknown; _body?: boolean },
  response: ServerResponse,
  options: NodeBindingOptions,
): Promise<Prepared> {
  const { runtime } = options;
  const path = new URL(request.url ?? "/", "http://placeholder.invalid").pathname;
  if (options.skip?.(path)) {
    return { answered: false, request, site: undefined, context: skipped(path) };
  }
  if (runtime.rewritesPathParameters) {
    throw new Error(
      "This program converts a path parameter, which middleware cannot serve because " +
        "the route is matched before it runs. Use adaptListener, or the proxy.",
    );
  }
  const decided = decide(request, response, options);
  if (!decided) return { answered: true };
  const context = {
    contract: decided.contract,
    operation: decided.operation,
    consumer: decided.consumer,
  };
  const site = decided.site;
  request.headers = toHeaderObject(decided.headers);
  request.rawHeaders = toRawHeaders(decided.headers);
  if (!site || !(runtime.readsRequestBody(site) || site.envelope)) {
    return { answered: false, request, site, context };
  }
  try {
    const parsed = request._body === true || request.body !== undefined;
    // A body an earlier middleware parsed is JSON only if it was sent as JSON;
    // a parsed form written back as JSON would be a request nobody sent.
    const json = isJsonMediaType(decided.headers.get("content-type"));
    if (parsed && !json && runtime.readsRequestBody(site)) {
      throw new Error(
        "A body parser ran before the adapter and parsed a body this operation's program " +
          "rewrites. Mount adaptMiddleware before it, after authentication.",
      );
    }
    const text = parsed
      ? request.body === undefined || !json
        ? undefined
        : JSON.stringify(request.body)
      : await readText(request);
    const result = await runtime.adaptRequest(
      site,
      new Request(`http://placeholder.invalid${decided.path}${decided.search}`, {
        method: decided.method,
        headers: decided.headers,
        ...(text === undefined || text === "" ? {} : { body: text }),
      }),
      { path: decided.path, search: decided.search, headers: decided.headers },
      context,
    );
    request.url = `${result.path}${result.search}`;
    request.headers = toHeaderObject(result.headers);
    request.rawHeaders = toRawHeaders(result.headers);
    if (typeof result.body === "string" && result.body !== "") {
      request.body = isJsonMediaType(result.headers.get("content-type"))
        ? JSON.parse(result.body)
        : result.body;
      request._body = true;
    } else if (text !== undefined && !parsed) {
      request.body = text === "" ? undefined : JSON.parse(text);
      request._body = true;
    }
  } catch (error) {
    const shaped = requestFailure(options.errors ?? DEFAULT_ERROR_SHAPER, error);
    if (!shaped) throw error;
    answer(response, shaped);
    return { answered: true };
  }
  return { answered: false, request, site, context };
}

function skipped(path: string) {
  return { contract: "", operation: path, consumer: undefined };
}

async function readText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** A fresh message carrying a rewritten body, on the caller's own connection. */
function replacement(
  original: IncomingMessage,
  method: string,
  adapted: { path: string; search: string; headers: Headers },
  body: ReadableStream<Uint8Array> | string | null,
): IncomingMessage {
  const message = new IncomingMessage(original.socket);
  message.method = method;
  message.url = `${adapted.path}${adapted.search}`;
  message.httpVersion = original.httpVersion;
  message.httpVersionMajor = original.httpVersionMajor;
  message.httpVersionMinor = original.httpVersionMinor;
  message.headers = toHeaderObject(adapted.headers);
  message.rawHeaders = toRawHeaders(adapted.headers);
  if (typeof body === "string") {
    message.push(Buffer.from(body, "utf8"));
    message.push(null);
    message.complete = true;
  } else if (body === null) {
    message.push(null);
    message.complete = true;
  } else {
    const source = Readable.fromWeb(body as never);
    source.on("data", (chunk: Buffer) => message.push(chunk));
    source.on("end", () => {
      message.complete = true;
      message.push(null);
    });
    source.on("error", (error) => message.destroy(error));
  }
  return message;
}

/**
 * Corrects the response on its way out: every header a response for this
 * contract needs, and the body where the program has work for it.
 *
 * Nothing reaches the socket until the status and content type are known.
 * Then a body the program describes is held, adapted as a whole and sent;
 * anything else goes out as the application wrote it, streamed, with its
 * headers corrected first. The same approach compression middleware takes.
 */
function intercept(
  response: ServerResponse,
  prepared: Extract<Prepared, { answered: false }>,
  options: NodeBindingOptions,
): void {
  const { runtime } = options;
  const { site, context } = prepared;
  if (context.contract === "") return; // skipped
  const method = prepared.request.method ?? "GET";
  const writeHead = response.writeHead.bind(response) as (
    ...args: unknown[]
  ) => ServerResponse;
  const write = response.write.bind(response) as (...args: unknown[]) => boolean;
  const end = response.end.bind(response) as (...args: unknown[]) => ServerResponse;
  let mode: "pass" | "hold" | undefined;
  const held: Buffer[] = [];

  const headersOf = () => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(response.getHeaders())) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      else headers.set(name, String(value));
    }
    return headers;
  };

  const choose = () => {
    if (mode) return mode;
    const status = response.statusCode;
    const bodyless = method.toUpperCase() === "HEAD" || status === 304;
    const adaptsBody =
      site !== undefined &&
      runtime.respondsTo(site, status) &&
      isJsonMediaType(String(response.getHeader("content-type") ?? ""));
    const adaptsHead =
      site !== undefined &&
      bodyless &&
      runtime.respondsTo(site, status === 304 ? 200 : status);
    mode = adaptsBody || adaptsHead ? "hold" : "pass";
    if (mode === "pass") {
      // Corrected before the first byte: a cache must know this answer
      // depends on the contract, whatever the body.
      if (context.contract !== runtime.currentLabel) {
        response.setHeader(CONTRACT_RESPONSE_HEADER, context.contract);
      }
      const vary = new Headers();
      const existing = response.getHeader("vary");
      if (existing !== undefined) vary.set("vary", String(existing));
      appendVary(vary, runtime.varyOn);
      const merged = vary.get("vary");
      if (merged !== null) response.setHeader("vary", merged);
    }
    return mode;
  };

  const applyHead = (args: unknown[]) => {
    const [status, second, third] = args;
    if (typeof status === "number") response.statusCode = status;
    const given = typeof second === "string" ? third : second;
    if (typeof second === "string") response.statusMessage = second;
    if (Array.isArray(given)) {
      for (let index = 0; index < given.length; index += 2) {
        response.setHeader(String(given[index]), String(given[index + 1]));
      }
    } else if (given && typeof given === "object") {
      for (const [name, value] of Object.entries(given)) {
        if (value !== undefined) response.setHeader(name, value as string);
      }
    }
  };

  response.writeHead = ((...args: unknown[]) => {
    applyHead(args);
    if (choose() === "pass") return writeHead(response.statusCode);
    return response;
  }) as typeof response.writeHead;

  response.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
    if (choose() === "pass") return write(chunk, encoding, callback);
    if (chunk !== undefined && chunk !== null) {
      held.push(
        Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(
              chunk as string,
              typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8",
            ),
      );
    }
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done === "function") queueMicrotask(() => (done as () => void)());
    return true;
  }) as typeof response.write;

  response.end = ((chunk?: unknown, encoding?: unknown, callback?: unknown) => {
    if (typeof chunk === "function") {
      callback = chunk;
      chunk = undefined;
    } else if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    if (choose() === "pass") return end(chunk, encoding, callback);
    if (chunk !== undefined && chunk !== null) {
      held.push(
        Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(
              chunk as string,
              typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8",
            ),
      );
    }
    const status = response.statusCode;
    const bytes = Buffer.concat(held);
    void runtime
      .adaptResponse(
        site,
        new Response(
          status === 204 || status === 304 || bytes.byteLength === 0 ? null : bytes,
          {
            status,
            headers: headersOf(),
          },
        ),
        context,
        { encoded: true, method, errors: options.errors ?? DEFAULT_ERROR_SHAPER },
      )
      .then(async (adapted) => {
        const body = adapted.body ? Buffer.from(await adapted.arrayBuffer()) : undefined;
        for (const name of response.getHeaderNames()) response.removeHeader(name);
        writeHead(adapted.status, toHeaderObject(adapted.headers));
        end(body, typeof callback === "function" ? callback : undefined);
      })
      .catch((error: unknown) => {
        // Back to what Node wrote with, so the failure is not held in turn.
        response.writeHead = writeHead as typeof response.writeHead;
        response.write = write as typeof response.write;
        response.end = end as typeof response.end;
        failed(response, error);
      });
    return response;
  }) as typeof response.end;
}
