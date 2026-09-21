/**
 * Site resolution: where a named schema actually appears on the wire.
 *
 * A Change says "Payment gained minor units". The runtime needs to know that
 * Payment is the whole body of `POST /v1/payments` 201, and sits at `/data/*`
 * inside `GET /v1/payments` 200. Walking `$ref` usage is what turns one
 * statement about a schema into the exact set of pointers to transform.
 */
import {
  formatPointer,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type Pointer,
} from "@invariant/ir";
import { resolveSchema } from "./resolve.ts";
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
  /**
   * The unions on the way to it, outermost first, and how the branch that
   * leads here is told apart from the others. A transform at this site runs
   * only for values that are this branch.
   */
  guards?: Guard[];
}

/**
 * How one branch of a union is recognised at `at`: by the value a key holds,
 * such as `type` being `scheme`, or by a field only that branch requires.
 */
export type Guard =
  | { at: Pointer; key: Pointer; values: string[] }
  | { at: Pointer; has: string };

export interface SiteScanResult {
  sites: Site[];
  /** Places the walk refused to enter, so the compiler can refuse the Change. */
  unsupported: string[];
}

interface Found {
  prefix: Pointer;
  guards: Guard[];
}

interface WalkContext {
  document: OpenApiDocument;
  target: string;
  found: Found[];
  unsupported: string[];
  visiting: Set<string>;
}

const escapeSegment = (segment: string): string =>
  segment.replaceAll("~", "~0").replaceAll("/", "~1");

/** The values a property of a branch can hold, where it declares a closed set. */
function closedValues(
  document: OpenApiDocument,
  branch: JsonValue,
  property: string,
): string[] | undefined {
  const resolved = resolveSchema(document, branch);
  if (!isJsonObject(resolved) || !isJsonObject(resolved["properties"])) return undefined;
  const schema = resolveSchema(
    document,
    (resolved["properties"] as JsonObject)[property] ?? {},
  );
  if (!isJsonObject(schema)) return undefined;
  const scalar = (value: JsonValue) =>
    typeof value === "string" || typeof value === "number" || typeof value === "boolean";
  if (schema["const"] !== undefined && scalar(schema["const"] as JsonValue)) {
    return [String(schema["const"])];
  }
  const values = schema["enum"];
  if (Array.isArray(values) && values.length > 0 && values.every(scalar)) {
    return values.map(String);
  }
  return undefined;
}

/**
 * How the branch at `index` of a union is told apart from the rest, or
 * nothing when it cannot be. In order: the union's own `discriminator`, then
 * a property every branch gives a closed set of values that do not overlap,
 * as Adyen's payment methods each fix `type`, then a field only this branch
 * requires.
 */
function guardFor(
  document: OpenApiDocument,
  union: JsonObject,
  branches: readonly JsonValue[],
  index: number,
  at: Pointer,
): Guard | undefined {
  const branch = branches[index] as JsonValue;
  const discriminator = union["discriminator"];
  if (isJsonObject(discriminator) && typeof discriminator["propertyName"] === "string") {
    const name = discriminator["propertyName"];
    const ref =
      isJsonObject(branch) && typeof branch["$ref"] === "string"
        ? branch["$ref"]
        : undefined;
    const mapping = isJsonObject(discriminator["mapping"])
      ? discriminator["mapping"]
      : {};
    let values = Object.entries(mapping)
      .filter(
        ([, target]) =>
          ref !== undefined &&
          (target === ref || target === ref.slice(ref.lastIndexOf("/") + 1)),
      )
      .map(([key]) => key);
    // Without a mapping entry, the branch's value is its schema's name.
    if (values.length === 0 && ref !== undefined)
      values = [ref.slice(ref.lastIndexOf("/") + 1)];
    if (values.length === 0) values = closedValues(document, branch, name) ?? [];
    if (values.length > 0) return { at, key: `/${escapeSegment(name)}`, values };
  }

  const resolved = resolveSchema(document, branch);
  const own =
    isJsonObject(resolved) && isJsonObject(resolved["properties"])
      ? Object.keys(resolved["properties"])
      : [];
  const preferred = ["type", "object", "kind"];
  const candidates = [
    ...preferred.filter((name) => own.includes(name)),
    ...own.filter((name) => !preferred.includes(name)).sort(),
  ];
  for (const property of candidates) {
    const mine = closedValues(document, branch, property);
    if (!mine) continue;
    const disjoint = branches.every((other, at2) => {
      if (at2 === index) return true;
      const theirs = closedValues(document, other, property);
      return theirs !== undefined && !theirs.some((value) => mine.includes(value));
    });
    if (disjoint) return { at, key: `/${escapeSegment(property)}`, values: mine };
  }

  const required =
    isJsonObject(resolved) && Array.isArray(resolved["required"])
      ? (resolved["required"] as JsonValue[]).filter(
          (name): name is string => typeof name === "string",
        )
      : [];
  for (const name of required) {
    const elsewhere = branches.some((other, at2) => {
      if (at2 === index) return false;
      const theirs = resolveSchema(document, other);
      return (
        !isJsonObject(theirs) ||
        !isJsonObject(theirs["properties"]) ||
        (theirs["properties"] as JsonObject)[name] !== undefined
      );
    });
    if (!elsewhere) return { at, has: name };
  }
  return undefined;
}

function walk(ctx: WalkContext, schema: JsonValue, segments: string[]): void {
  if (!isJsonObject(schema)) return;

  const ref = schema["$ref"];
  if (typeof ref === "string") {
    if (ref === ctx.target) {
      ctx.found.push({ prefix: formatPointer(segments), guards: [] });
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

  // A union is only a problem when the target is actually inside it and
  // nothing tells its branches apart: then the runtime cannot know which
  // branch a value took, and a transform cannot be placed. Where something
  // does, the site carries a guard and the transform runs only for values of
  // that branch. A union elsewhere in the same body is none of this Change's
  // business, and reporting it would refuse unrelated releases.
  for (const key of ["oneOf", "anyOf", "not"]) {
    const value = schema[key];
    if (value === undefined) continue;
    const branches = (Array.isArray(value) ? value : [value]) as JsonValue[];
    branches.forEach((branch, index) => {
      const inner: WalkContext = { ...ctx, found: [], unsupported: [] };
      walk(inner, branch, segments);
      ctx.unsupported.push(...inner.unsupported);
      if (inner.found.length === 0) return;
      const at = formatPointer(segments);
      const guard =
        key === "not" ? undefined : guardFor(ctx.document, schema, branches, index, at);
      if (!guard) {
        ctx.unsupported.push(
          `${at || "/"} reaches the schema through ${key}, and nothing tells its branches apart`,
        );
        return;
      }
      for (const found of inner.found) {
        ctx.found.push({ prefix: found.prefix, guards: [guard, ...found.guards] });
      }
    });
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
): { prefixes: Found[]; unsupported: string[] } {
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

  for (const { operationId, method, path, operation, webhook } of operationsOf(
    document,
  )) {
    if (webhook === true) {
      // A webhook is sent by the provider, so there is no inbound request to
      // rewrite and no response of the provider's own to rewrite back. When
      // the changed schema is part of what the webhook sends, what cannot
      // exist is an adapter site for it, and saying so here is what keeps a
      // drafted transform from being compiled into a program that could never
      // run. A webhook that never carries the schema is not affected at all.
      const payload = requestBodySchema(document, operation);
      if (payload === undefined) continue;
      const scan = scanRoot(document, schemaRef, payload);
      if (scan.prefixes.length > 0 || scan.unsupported.length > 0) {
        unsupported.push(
          `${operationId} is a webhook that sends this schema, which this runtime ` +
            "cannot adapt. Describe it as a `behavior` change, or send the new shape.",
        );
      }
      continue;
    }
    const request = requestBodySchema(document, operation);
    if (request !== undefined) {
      const scan = scanRoot(document, schemaRef, request);
      unsupported.push(...scan.unsupported.map((u) => `${operationId} request: ${u}`));
      for (const { prefix, guards } of scan.prefixes) {
        sites.push({
          operationId,
          method,
          path,
          direction: "request",
          prefix,
          ...(guards.length > 0 ? { guards } : {}),
        });
      }
    }

    for (const { status, schema } of responseSchemas(document, operation)) {
      const scan = scanRoot(document, schemaRef, schema);
      unsupported.push(
        ...scan.unsupported.map((u) => `${operationId} response ${status}: ${u}`),
      );
      for (const { prefix, guards } of scan.prefixes) {
        sites.push({
          operationId,
          method,
          path,
          direction: "response",
          status,
          prefix,
          ...(guards.length > 0 ? { guards } : {}),
        });
      }
    }
  }

  return { sites, unsupported };
}

/** Where one schema sits inside another, and what tells apart the unions on the way. */
export interface Placement {
  prefix: Pointer;
  guards?: Guard[];
}

/**
 * Every place `schemaRef` sits inside the schema `rootRef`, the root itself
 * included when the two are the same. What a value of the root goes through
 * at a site is every Change placed here, so a check of the root's values has
 * to run them all.
 */
export function findSchemaWithin(
  document: OpenApiDocument,
  schemaRef: string,
  rootRef: string,
): { placements: Placement[]; unsupported: string[] } {
  const scan = scanRoot(document, schemaRef, { $ref: rootRef });
  return {
    placements: scan.prefixes.map(({ prefix, guards }) => ({
      prefix,
      ...(guards.length > 0 ? { guards } : {}),
    })),
    unsupported: scan.unsupported,
  };
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
