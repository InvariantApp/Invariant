/**
 * Site resolution: where a named schema actually appears on the wire.
 *
 * A Change says "Payment gained minor units". The runtime needs to know that
 * Payment is the whole body of `POST /v1/payments` 201, and sits at `/data/*`
 * inside `GET /v1/payments` 200. Walking `$ref` usage is what turns one
 * statement about a schema into the exact set of pointers to transform.
 */
import { formatPointer, isJsonObject, type JsonValue, type Pointer } from "@invariant/ir";
import {
  deref,
  type HttpMethod,
  type OpenApiDocument,
  operationsOf,
  requestBodySchema,
  resolveRef,
  responseSchemas,
} from "./spec.ts";

export type Direction = "request" | "response";

export interface Site {
  operationId: string;
  method: HttpMethod;
  path: string;
  direction: Direction;
  /** Present for responses only. */
  status?: string;
  /** Where the schema sits inside the body. Empty string means the body root. */
  prefix: Pointer;
}

export interface SiteScanResult {
  sites: Site[];
  /** Places the walk refused to enter, so the compiler can refuse the Change. */
  unsupported: string[];
}

interface WalkContext {
  document: OpenApiDocument;
  target: string;
  found: Pointer[];
  unsupported: string[];
  visiting: Set<string>;
}

function walk(ctx: WalkContext, schema: JsonValue, segments: string[]): void {
  if (!isJsonObject(schema)) return;

  const ref = schema["$ref"];
  if (typeof ref === "string") {
    if (ref === ctx.target) {
      ctx.found.push(formatPointer(segments));
      return;
    }
    if (ctx.visiting.has(ref)) return;
    const resolved = resolveRef(ctx.document, ref);
    if (resolved === undefined) return;
    ctx.visiting.add(ref);
    walk(ctx, resolved, segments);
    ctx.visiting.delete(ref);
    return;
  }

  for (const key of ["oneOf", "anyOf", "not"]) {
    if (schema[key] !== undefined) {
      ctx.unsupported.push(`${formatPointer(segments) || "/"} uses ${key}`);
    }
  }

  const allOf = schema["allOf"];
  if (Array.isArray(allOf)) {
    for (const branch of allOf) walk(ctx, branch, segments);
  }

  const properties = schema["properties"];
  if (isJsonObject(properties)) {
    for (const name of Object.keys(properties).sort()) {
      walk(ctx, properties[name] as JsonValue, [...segments, name]);
    }
  }

  const items = schema["items"];
  if (items !== undefined) walk(ctx, items, [...segments, "*"]);
}

function scanRoot(
  document: OpenApiDocument,
  target: string,
  root: JsonValue,
): { prefixes: Pointer[]; unsupported: string[] } {
  const ctx: WalkContext = {
    document,
    target,
    found: [],
    unsupported: [],
    visiting: new Set(),
  };
  walk(ctx, root, []);
  return { prefixes: ctx.found, unsupported: ctx.unsupported };
}

/**
 * Every place `#/components/schemas/<name>` reaches the wire in this document.
 */
export function findSchemaSites(
  document: OpenApiDocument,
  schemaRef: string,
): SiteScanResult {
  const sites: Site[] = [];
  const unsupported: string[] = [];

  for (const { operationId, method, path, operation } of operationsOf(document)) {
    const request = requestBodySchema(document, operation);
    if (request !== undefined) {
      const scan = scanRoot(document, schemaRef, request);
      unsupported.push(...scan.unsupported.map((u) => `${operationId} request: ${u}`));
      for (const prefix of scan.prefixes) {
        sites.push({ operationId, method, path, direction: "request", prefix });
      }
    }

    for (const { status, schema } of responseSchemas(document, operation)) {
      const scan = scanRoot(document, schemaRef, schema);
      unsupported.push(
        ...scan.unsupported.map((u) => `${operationId} response ${status}: ${u}`),
      );
      for (const prefix of scan.prefixes) {
        sites.push({ operationId, method, path, direction: "response", status, prefix });
      }
    }
  }

  return { sites, unsupported };
}

/** The schema an operation actually exposes for a direction, with refs followed. */
export function bodySchemaFor(
  document: OpenApiDocument,
  operation: Record<string, JsonValue>,
  direction: Direction,
  status?: string,
): JsonValue | undefined {
  if (direction === "request") {
    const schema = requestBodySchema(document, operation);
    return schema === undefined ? undefined : deref(document, schema);
  }
  const match = responseSchemas(document, operation).find((r) => r.status === status);
  return match === undefined ? undefined : deref(document, match.schema);
}
