/**
 * A mock of an API that knows only its contract.
 *
 * Third-party mocks were tried and dropped. Prism never opened a port on
 * Stripe's specification, and a mock that cannot hold the largest provider
 * cannot stand in for them. This one is small on purpose: it compiles nothing
 * until an operation is asked for, judges every request with the independent
 * oracle, and answers with a value generated from the operation's own response
 * schema, deterministically from a seed so a failure can be replayed exactly.
 *
 * What it records is the evidence: every request it judged, and whether the
 * response it produced was itself valid, because a generator that cannot
 * produce a valid response makes that sample prove nothing, and has to be
 * counted rather than quietly passed.
 */
import type { OpenApiDocument } from "@invariant/contract";
import type { JsonValue } from "@invariant/ir";
import { valueArbitrary } from "@invariant/verifier";
import fc from "fast-check";
import qs from "qs";
import { Oracle, type OracleViolation } from "./oracle.mts";

type JsonObject = Record<string, JsonValue>;
const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

interface Route {
  method: string;
  path: string;
  pattern: RegExp;
  /** The template's parameter names, in the order the pattern captures them. */
  names: string[];
  operation: JsonObject;
}

export interface Judged {
  method: string;
  path: string;
  /** Violations of the request body schema; empty when it conformed. */
  request: OracleViolation[] | undefined;
  status: number;
  /** Whether the generated response conformed to the mock's own contract. */
  responseValid: boolean | undefined;
  /** Why it did not, when it did not. */
  responseViolations?: OracleViolation[];
}

export interface ContractMock {
  fetch: (request: Request) => Promise<Response>;
  /** Everything judged since the last `reset()`. */
  readonly log: Judged[];
  reset(): void;
  oracle: Oracle;
}

/**
 * The path every server of a contract serves under, as a server would be
 * mounted: `""` at the root, and also when the servers disagree or carry a
 * variable, since then no single mount is right.
 */
export function mountOf(document: OpenApiDocument): string {
  const servers = document["servers"];
  if (!Array.isArray(servers) || servers.length === 0) return "";
  const paths = new Set<string>();
  for (const server of servers) {
    const url = isObject(server) ? server["url"] : undefined;
    if (typeof url !== "string" || url.includes("{")) return "";
    try {
      paths.add(new URL(url, "http://mount.invalid").pathname.replace(/\/+$/, ""));
    } catch {
      return "";
    }
  }
  return paths.size === 1 ? ([...paths][0] as string) : "";
}

function routesOf(document: OpenApiDocument): Route[] {
  const routes: Route[] = [];
  const paths = document["paths"];
  if (!isObject(paths)) return routes;
  const mount = mountOf(document).replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  for (const [path, item] of Object.entries(paths)) {
    if (!isObject(item)) continue;
    const pattern = new RegExp(
      `^${mount}${path
        .split(/(\{[^}]+\})/)
        .map((part) =>
          part.startsWith("{") ? "([^/]+)" : part.replace(/[.*+?^$()|[\]\\]/g, "\\$&"),
        )
        .join("")}$`,
    );
    const names = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] as string);
    for (const method of METHODS) {
      const operation = item[method];
      if (isObject(operation)) routes.push({ method, path, pattern, names, operation });
    }
  }
  // Literal paths before templated ones, so /things/count is not taken for
  // /things/{id}.
  return routes.sort(
    (a, b) => (a.path.match(/\{/g)?.length ?? 0) - (b.path.match(/\{/g)?.length ?? 0),
  );
}

/** The first success status whose body is JSON, and its schema. */
function successSchema(
  document: OpenApiDocument,
  operation: JsonObject,
): {
  status: number;
  schema: JsonValue | undefined;
  /** Headers the response must carry, which a client may depend on. */
  headers: { name: string; schema: JsonValue }[];
} {
  const responses = isObject(operation["responses"]) ? operation["responses"] : {};
  const statuses = Object.keys(responses)
    .filter((status) => /^2\d\d$/.test(status) || status === "2XX")
    .sort();
  const status = statuses[0];
  if (status === undefined) return { status: 204, schema: undefined, headers: [] };
  let response = responses[status];
  for (
    let hops = 0;
    hops < 8 && isObject(response) && typeof response["$ref"] === "string";
    hops += 1
  ) {
    let target: JsonValue | undefined = document;
    for (const key of (response["$ref"] as string).slice(2).split("/")) {
      target = isObject(target)
        ? target[key.replaceAll("~1", "/").replaceAll("~0", "~")]
        : undefined;
    }
    response = target as JsonValue;
  }
  const content =
    isObject(response) && isObject(response["content"]) ? response["content"] : {};
  const media = Object.keys(content).find((type) => /json/i.test(type));
  const holder = media ? content[media] : undefined;
  const declared =
    isObject(response) && isObject(response["headers"]) ? response["headers"] : {};
  return {
    status: status === "2XX" ? 200 : Number(status),
    schema: isObject(holder) ? holder["schema"] : undefined,
    headers: Object.entries(declared).flatMap(([name, header]) =>
      isObject(header) && header["required"] === true && isObject(header["schema"])
        ? [{ name, schema: header["schema"] }]
        : [],
    ),
  };
}

export function createContractMock(
  document: OpenApiDocument,
  options: { seed?: number } = {},
): ContractMock {
  const oracle = new Oracle(document as never);
  const routes = routesOf(document);
  const generators = new Map<string, fc.Arbitrary<JsonValue>>();
  const log: Judged[] = [];
  let counter = 0;

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const method = request.method.toLowerCase();
    const route = routes.find(
      (entry) => entry.method === method && entry.pattern.test(url.pathname),
    );
    if (!route) {
      // As a web framework answers: 405 when the path is served under another
      // method, 404 when it is not served at all.
      const status = routes.some((entry) => entry.pattern.test(url.pathname)) ? 405 : 404;
      log.push({
        method,
        path: url.pathname,
        request: undefined,
        status,
        responseValid: undefined,
      });
      return Response.json({ error: "no such operation in this contract" }, { status });
    }

    let requestViolations: OracleViolation[] | undefined;
    const type = request.headers.get("content-type") ?? "";
    if (/json/i.test(type)) {
      const text = await request.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        requestViolations = [{ pointer: "/", message: "the body is not JSON" }];
      }
      requestViolations ??= oracle.request(route, body);
    } else if (/^application\/x-www-form-urlencoded/i.test(type)) {
      // Decoded the way Stripe's own libraries write it, by a library that
      // is not the code under test.
      const body = qs.parse(await request.text(), {
        depth: 20,
        arrayLimit: 10_000,
        parameterLimit: 100_000,
      });
      requestViolations = oracle.request(route, body, "form");
    }
    const matched = route.pattern.exec(url.pathname);
    // Decoded as a server's router decodes them before a handler sees them.
    const decoded = (raw: string) => {
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    };
    const pathValues = Object.fromEntries(
      route.names.map((name, index) => [name, decoded(matched?.[index + 1] ?? "")]),
    );
    const parameterViolations = oracle.parameters(route, {
      url,
      headers: request.headers,
      path: pathValues,
    });
    if (parameterViolations.length > 0) {
      requestViolations = [...(requestViolations ?? []), ...parameterViolations];
    }
    if (requestViolations && requestViolations.length > 0) {
      log.push({
        method,
        path: route.path,
        request: requestViolations,
        status: 400,
        responseValid: undefined,
      });
      return Response.json(
        { error: "request does not conform", violations: requestViolations },
        { status: 400 },
      );
    }

    const {
      status,
      schema,
      headers: declared,
    } = successSchema(document, route.operation);
    // Every header the contract says a response carries, generated from its
    // schema like the body, so a client that depends on one is tested with it.
    const headers = new Headers();
    for (const { name, schema: headerSchema } of declared) {
      const [value] = fc.sample(valueArbitrary(document, headerSchema), {
        numRuns: 1,
        seed: (options.seed ?? 42) + counter,
      });
      const text = typeof value === "string" ? value : JSON.stringify(value);
      // A header carries visible ASCII only; a generated string may not.
      headers.set(name, text.replace(/[^\x21-\x7e]/g, "x") || "x");
    }
    if (schema === undefined) {
      log.push({
        method,
        path: route.path,
        request: requestViolations,
        status,
        responseValid: undefined,
      });
      return new Response(null, { status: status === 200 ? 204 : status, headers });
    }
    const key = `${method} ${route.path}`;
    let generator = generators.get(key);
    if (!generator) {
      generator = valueArbitrary(document, schema);
      generators.set(key, generator);
    }
    counter += 1;
    const [value] = fc.sample(generator, {
      numRuns: 1,
      seed: (options.seed ?? 42) + counter,
    });
    const violations = oracle.response(route, status, value);
    log.push({
      method,
      path: route.path,
      request: requestViolations,
      status,
      responseValid: violations === undefined ? undefined : violations.length === 0,
      ...(violations && violations.length > 0 ? { responseViolations: violations } : {}),
    });
    return Response.json(value, { status, headers });
  };

  return {
    fetch: handler,
    log,
    reset: () => {
      log.length = 0;
    },
    oracle,
  };
}
