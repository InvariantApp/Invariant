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
  HTTP_METHODS,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type Pointer,
} from "@invariant-app/ir";
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

/**
 * Which way a body travels. `outbound` is a body the provider sends on its
 * own initiative, a webhook or a callback, which reaches a subscriber the way
 * a response reaches a caller: in whatever shape their contract describes.
 */
export type Direction = "request" | "response" | "outbound";

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
  | {
      at: Pointer;
      key: Pointer;
      values: string[];
      /** A field only this branch requires, among those sharing the key's values. */
      has?: string;
      /** A field every other branch sharing the key's values requires, and this one never has. */
      lacks?: string;
    }
  | { at: Pointer; has: string }
  | { at: Pointer; lacks: string }
  | { at: Pointer; type: JsonKind };

/** The kinds of value JSON has. */
export type JsonKind = "object" | "array" | "string" | "number" | "boolean" | "null";

/** Keywords that describe a schema without constraining its values. */
const ANNOTATIONS = new Set([
  "title",
  "description",
  "example",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "externalDocs",
]);

const JSON_KINDS: readonly JsonKind[] = [
  "object",
  "array",
  "string",
  "number",
  "boolean",
  "null",
];

export interface SiteScanResult {
  sites: Site[];
  /** Places the walk refused to enter, so the compiler can refuse the Change. */
  unsupported: string[];
  /**
   * The schema sits in more places than can be listed one by one. What the
   * scan found is incomplete, and the Change has to be served by blocks that
   * follow the value instead.
   */
  exhausted?: true;
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
  /** References whose schemas can lead to the target; nothing else is entered. */
  leads: ReadonlySet<string>;
  /** Shared by every branch of one search, so a union cannot multiply it. */
  budget: Budget;
}

/**
 * How many schema nodes one search for a schema may visit, across every
 * operation, before it stops and says so.
 *
 * Every place a schema sits is listed separately, and where references fan
 * out the places multiply: in Stripe nearly every object reaches nearly every
 * other through expandable fields, and listing where `balance_transaction`
 * sits walked for minutes. Stopping refuses the Change as unsupported, which
 * blocks rather than guesses, and it stays refused until one transform per
 * schema can be shared by every place it sits.
 */
const MAX_WALK_STEPS = 2_000_000;

/** How many reasons a search keeps; the rest are counted, not listed. */
const MAX_NOTES = 100;

interface Budget {
  steps: number;
  exhausted: boolean;
  /** Reasons beyond `MAX_NOTES`, which are the same problem at more places. */
  dropped: number;
}

const freshBudget = (): Budget => ({ steps: 0, exhausted: false, dropped: 0 });

/** Records why the schema cannot be placed somewhere, keeping the list bounded. */
function note(ctx: WalkContext, message: string): void {
  if (ctx.unsupported.length < MAX_NOTES) ctx.unsupported.push(message);
  else ctx.budget.dropped += 1;
}

/** Every `$ref` directly inside a schema, without following any of them. */
function refsIn(value: JsonValue | undefined, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) refsIn(item, into);
    return;
  }
  if (!isJsonObject(value)) return;
  const ref = value["$ref"];
  if (typeof ref === "string") {
    into.add(ref);
    return;
  }
  for (const child of Object.values(value)) refsIn(child, into);
}

/**
 * For each reference, the references whose schemas point at it directly.
 *
 * Built once per document and kept, because every Change in a release scans
 * the same contract. A loaded contract is never edited in place (the
 * predictor edits a copy), which is what makes keeping it by identity sound.
 */
const REFERRERS = new WeakMap<OpenApiDocument, Map<string, string[]>>();

function referrers(document: OpenApiDocument): Map<string, string[]> {
  const known = REFERRERS.get(document);
  if (known) return known;
  const children = new Map<string, Set<string>>();
  const seed = new Set<string>();
  refsIn(document as unknown as JsonValue, seed);
  const pending = [...seed];
  while (pending.length > 0) {
    const ref = pending.pop() as string;
    if (children.has(ref)) continue;
    const direct = new Set<string>();
    refsIn(resolveRef(document, ref), direct);
    children.set(ref, direct);
    for (const next of direct) if (!children.has(next)) pending.push(next);
  }
  const parents = new Map<string, string[]>();
  for (const [ref, direct] of children) {
    for (const child of direct) {
      const list = parents.get(child);
      if (list) list.push(ref);
      else parents.set(child, [ref]);
    }
  }
  REFERRERS.set(document, parents);
  return parents;
}

/**
 * The references from which `target` can be reached, `target` included.
 *
 * One pass over the reference graph, walked backwards from the target. The
 * walk below enters only these, which changes nothing it finds and removes the
 * cost that made it exponential: expandable fields written as a union of an id
 * and a referenced object, as Stripe writes nearly all of them, otherwise send
 * it through every schema on every path.
 */
function leadingTo(document: OpenApiDocument, target: string): Set<string> {
  const parents = referrers(document);
  const leads = new Set<string>([target]);
  const queue = [target];
  while (queue.length > 0) {
    const ref = queue.pop() as string;
    for (const parent of parents.get(ref) ?? []) {
      if (leads.has(parent)) continue;
      leads.add(parent);
      queue.push(parent);
    }
  }
  return leads;
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
 * The one JSON kind every value of a schema has, where it says so. A schema
 * that may also be null, or that is written as several types, has none.
 */
export function jsonKindOf(
  document: OpenApiDocument,
  schema: JsonValue,
  /** The choices already being read, so one that holds itself ends. */
  within: ReadonlySet<JsonValue> = new Set(),
): JsonKind | undefined {
  const resolved = resolveSchema(document, schema);
  if (!isJsonObject(resolved) || within.has(resolved)) return undefined;
  if (resolved["nullable"] === true) {
    // A branch that says nothing but that it may be null is how schemars and
    // utoipa write Option<T> in OpenAPI 3.0, beside the branch for T: Qdrant's
    // telemetry does it 249 times. Read alone, `nullable` without a type
    // constrains nothing, but no generator writes it to mean anything but
    // null, and a union of it with an object is only ever an object or null.
    const said = Object.keys(resolved).filter((key) => !ANNOTATIONS.has(key));
    return said.length === 1 ? "null" : undefined;
  }
  const type = resolved["type"];
  if (typeof type === "string") {
    if (type === "integer") return "number";
    return (JSON_KINDS as readonly string[]).includes(type)
      ? (type as JsonKind)
      : undefined;
  }
  if (type !== undefined) return undefined;
  if (isJsonObject(resolved["properties"])) return "object";
  if (resolved["items"] !== undefined) return "array";
  // A choice is the kind its branches all are: Meilisearch's task `network`
  // is null or one of three objects, and the objects are told from null by
  // being objects before anything tells them from each other.
  for (const key of ["oneOf", "anyOf"]) {
    const branches = resolved[key];
    if (!Array.isArray(branches) || branches.length === 0) continue;
    const inside = new Set([...within, resolved]);
    const kinds = new Set(branches.map((branch) => jsonKindOf(document, branch, inside)));
    const [only] = kinds;
    return kinds.size === 1 ? only : undefined;
  }
  return undefined;
}

/**
 * How the branch at `index` of a union is told apart from the rest, or
 * nothing when it cannot be. In order: the kind of JSON value it is, where no
 * other branch is of that kind, as Stripe's expandable fields are an id or the
 * object; the union's own `discriminator`; a property every branch gives a
 * closed set of values that do not overlap, as Adyen's payment methods each
 * fix `type`; and a field only this branch requires.
 */
function guardFor(
  document: OpenApiDocument,
  union: JsonObject,
  branches: readonly JsonValue[],
  index: number,
  at: Pointer,
): Guard | undefined {
  const branch = branches[index] as JsonValue;
  const kind = jsonKindOf(document, branch);
  if (
    kind !== undefined &&
    branches.every((other, at2) => {
      if (at2 === index) return true;
      const theirs = jsonKindOf(document, other);
      return theirs !== undefined && theirs !== kind;
    })
  ) {
    return { at, type: kind };
  }

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
      // An id beside the objects holds no key at all, and the guard's
      // `within` passes over anything that is not an object.
      const kind = jsonKindOf(document, other);
      if (kind !== undefined && kind !== "object") return true;
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
  /** Whether a value of another branch could carry the field. */
  const mayHave = (other: JsonValue, name: string): boolean => {
    // A string, a number or a list never has a field, so a branch that is
    // one cannot be mistaken for this one by it.
    const kind = jsonKindOf(document, other);
    if (kind !== undefined && kind !== "object") return false;
    const theirs = resolveSchema(document, other);
    return (
      !isJsonObject(theirs) ||
      !isJsonObject(theirs["properties"]) ||
      (theirs["properties"] as JsonObject)[name] !== undefined
    );
  };
  const others = branches.filter((_, at2) => at2 !== index);
  for (const name of required) {
    if (!others.some((other) => mayHave(other, name))) return { at, has: name };
  }
  /**
   * A field every one of `rivals` requires and this branch never declares, so
   * its absence marks this branch among them, as a live Stripe object is known
   * from its deleted twin by having no `deleted`.
   */
  const absentHere = (rivals: readonly JsonValue[]): string | undefined => {
    const objects = rivals.filter((other) => {
      const kind = jsonKindOf(document, other);
      return kind === undefined || kind === "object";
    });
    if (objects.length === 0) return undefined;
    const requiredBy = (other: JsonValue): string[] => {
      const theirs = resolveSchema(document, other);
      return isJsonObject(theirs) && Array.isArray(theirs["required"])
        ? (theirs["required"] as JsonValue[]).filter(
            (name): name is string => typeof name === "string",
          )
        : [];
    };
    const [first, ...rest] = objects.map(requiredBy);
    return (first ?? [])
      .filter((name) => rest.every((list) => list.includes(name)))
      .find((name) => !own.includes(name));
  };
  const missing = absentHere(others);
  if (missing !== undefined) return { at, lacks: missing };

  // Two tests where no one test will do: a key narrows the union to the
  // branches that share its values, and what this one has or lacks picks it
  // from those, as Stripe's `bank_account` beside `deleted_bank_account`,
  // whose `object` is `bank_account` too.
  for (const property of candidates) {
    const mine = closedValues(document, branch, property);
    if (!mine) continue;
    const key = `/${escapeSegment(property)}`;
    const sharing = others.filter((other) => {
      const kind = jsonKindOf(document, other);
      if (kind !== undefined && kind !== "object") return false;
      const theirs = closedValues(document, other, property);
      return theirs === undefined || theirs.some((value) => mine.includes(value));
    });
    for (const name of required) {
      if (!sharing.some((other) => mayHave(other, name))) {
        return { at, key, values: mine, has: name };
      }
    }
    const lacking = absentHere(sharing);
    if (lacking !== undefined) return { at, key, values: mine, lacks: lacking };
  }
  return undefined;
}

function walk(ctx: WalkContext, schema: JsonValue, segments: string[]): void {
  if (!isJsonObject(schema) || ctx.budget.exhausted) return;
  ctx.budget.steps += 1;
  if (ctx.budget.steps > MAX_WALK_STEPS) {
    ctx.budget.exhausted = true;
    note(
      ctx,
      `the schema can be reached along more than ${MAX_WALK_STEPS} paths, too many to place a transform on each`,
    );
    return;
  }

  const ref = schema["$ref"];
  if (typeof ref === "string") {
    if (ref === ctx.target) {
      ctx.found.push({ prefix: formatPointer(segments), guards: [] });
      return;
    }
    // Nothing under a reference that cannot lead to the target can hold it.
    if (!ctx.leads.has(ref) || ctx.visiting.has(ref)) return;
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
      for (const message of inner.unsupported) note(ctx, message);
      if (inner.found.length === 0) return;
      const at = formatPointer(segments);
      const guard =
        key === "not" ? undefined : guardFor(ctx.document, schema, branches, index, at);
      if (!guard) {
        note(
          ctx,
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

  // A map: every value, whatever its key, is one of these.
  const values = schema["additionalProperties"];
  if (isJsonObject(values)) walk(ctx, values, [...segments, "{}"]);
}

function scanRoot(
  document: OpenApiDocument,
  target: string,
  root: JsonValue,
  leads: ReadonlySet<string> = leadingTo(document, target),
  budget: Budget = freshBudget(),
): { prefixes: Found[]; unsupported: string[] } {
  const ctx: WalkContext = {
    document,
    target,
    found: [],
    unsupported: [],
    visiting: new Set(),
    leads,
    budget,
  };
  walk(ctx, root, []);
  return { prefixes: ctx.found, unsupported: ctx.unsupported };
}

/** A request the provider makes to a subscriber, declared under an operation's `callbacks`. */
export interface Callback {
  /** `<operation>/<callback>`, which also names it to the runtime. */
  operationId: string;
  method: HttpMethod;
  /** `callback:<operation>/<callback>`, kept apart from every real path. */
  path: string;
  payload: JsonValue;
}

/**
 * The callbacks an operation declares, each with the body it sends. One
 * callback may list several URL expressions; they carry the same payloads,
 * and a subscriber is sent one of them, so each method is listed once.
 */
export function callbacksOf(
  document: OpenApiDocument,
  operationId: string,
  operation: JsonObject,
): Callback[] {
  const callbacks = operation["callbacks"];
  if (!isJsonObject(callbacks)) return [];
  const found: Callback[] = [];
  for (const name of Object.keys(callbacks).sort()) {
    const callback = deref(document, callbacks[name] as JsonValue);
    if (!isJsonObject(callback)) continue;
    const seen = new Set<string>();
    for (const expression of Object.keys(callback).sort()) {
      const item = deref(document, callback[expression] as JsonValue);
      if (!isJsonObject(item)) continue;
      for (const method of HTTP_METHODS) {
        const request = item[method];
        if (!isJsonObject(request) || seen.has(method)) continue;
        const payload = requestBodySchema(document, request);
        if (payload === undefined) continue;
        seen.add(method);
        found.push({
          operationId: `${operationId}/${name}`,
          method,
          path: `callback:${operationId}/${name}`,
          payload,
        });
      }
    }
  }
  return found;
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
  const leads = leadingTo(document, schemaRef);
  const budget = freshBudget();

  for (const { operationId, method, path, operation, webhook } of operationsOf(
    document,
  )) {
    if (webhook === true) {
      // Sent by the provider, so what is adapted is the payload, on its way
      // to a subscriber on an old contract, as a response is.
      const payload = requestBodySchema(document, operation);
      if (payload === undefined) continue;
      const scan = scanRoot(document, schemaRef, payload, leads, budget);
      unsupported.push(...scan.unsupported.map((u) => `${operationId} payload: ${u}`));
      for (const { prefix, guards } of scan.prefixes) {
        sites.push({
          operationId,
          method,
          path,
          direction: "outbound",
          prefix,
          ...(guards.length > 0 ? { guards } : {}),
        });
      }
      continue;
    }
    for (const callback of callbacksOf(document, operationId, operation)) {
      const scan = scanRoot(document, schemaRef, callback.payload, leads, budget);
      unsupported.push(
        ...scan.unsupported.map((u) => `${callback.operationId} payload: ${u}`),
      );
      for (const { prefix, guards } of scan.prefixes) {
        sites.push({
          operationId: callback.operationId,
          method: callback.method,
          path: callback.path,
          direction: "outbound",
          prefix,
          ...(guards.length > 0 ? { guards } : {}),
        });
      }
    }
    const request = requestBodySchema(document, operation);
    if (request !== undefined) {
      const scan = scanRoot(document, schemaRef, request, leads, budget);
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
      const scan = scanRoot(document, schemaRef, schema, leads, budget);
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

  const dropped = budget.dropped + Math.max(0, unsupported.length - MAX_NOTES);
  const listed = unsupported.slice(0, MAX_NOTES);
  if (dropped > 0) listed.push(`and ${dropped} more places like these`);
  return { sites, unsupported: listed, ...(budget.exhausted ? { exhausted: true } : {}) };
}

/**
 * Which ways a schema travels: whether any request body or any response can
 * carry it. Answered from the reference graph alone, in time linear in the
 * document, where listing every place it sits can be exponential. A webhook
 * or a callback that sends it counts as a response.
 */
export function schemaDirections(
  document: OpenApiDocument,
  schemaRef: string,
): { request: boolean; response: boolean } {
  const leads = leadingTo(document, schemaRef);
  const reaches = (root: JsonValue | undefined): boolean => {
    if (root === undefined) return false;
    const refs = new Set<string>();
    refsIn(root, refs);
    return [...refs].some((ref) => leads.has(ref));
  };
  let request = false;
  let response = false;
  for (const { operationId, operation, webhook } of operationsOf(document)) {
    const body = requestBodySchema(document, operation);
    // What the provider sends of its own accord reaches a subscriber as a
    // response reaches a caller.
    if (webhook === true) {
      response ||= reaches(body);
      continue;
    }
    response ||= callbacksOf(document, operationId, operation).some((callback) =>
      reaches(callback.payload),
    );
    request ||= reaches(body);
    response ||= responseSchemas(document, operation).some(({ schema }) =>
      reaches(schema),
    );
    if (request && response) break;
  }
  return { request, response };
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

/**
 * How a union at `pointer` inside `schemaRef` tells `variantRef` apart from
 * its other branches, or undefined where nothing does.
 */
export function variantGuard(
  document: OpenApiDocument,
  schemaRef: string,
  pointer: string,
  variantRef: string,
): Guard | undefined {
  let current: JsonValue | undefined = resolveRef(document, schemaRef);
  for (const segment of pointer.split("/").slice(1).map(unescapeSegment)) {
    const resolved = resolveSchema(document, current ?? {});
    if (!isJsonObject(resolved)) return undefined;
    current =
      segment === "*"
        ? resolved["items"]
        : segment === "{}"
          ? resolved["additionalProperties"]
          : isJsonObject(resolved["properties"])
            ? (resolved["properties"] as JsonObject)[segment]
            : undefined;
    if (current === undefined) return undefined;
  }
  const union =
    isJsonObject(current) && typeof current["$ref"] === "string"
      ? resolveRef(document, current["$ref"])
      : current;
  if (!isJsonObject(union)) return undefined;
  const branches = (union["anyOf"] ?? union["oneOf"]) as JsonValue[] | undefined;
  if (!Array.isArray(branches)) return undefined;
  const index = branches.findIndex(
    (branch) => isJsonObject(branch) && branch["$ref"] === variantRef,
  );
  return index < 0 ? undefined : guardFor(document, union, branches, index, "");
}

const unescapeSegment = (segment: string): string =>
  segment.replaceAll("~1", "/").replaceAll("~0", "~");

/** A referenced schema directly inside another, where it sits and how its union branch is told apart. */
export interface RefPlacement {
  prefix: Pointer;
  guards: Guard[];
  ref: string;
}

/**
 * Where each reference in `keep` sits directly inside `root`, without
 * following any reference. This is one step of the shared blocks: the block
 * for a schema calls the blocks of the schemas it holds, at these places,
 * and the walk is as small as the schema is, whatever the document.
 */
export function refsWithin(
  document: OpenApiDocument,
  root: JsonValue,
  keep: ReadonlySet<string>,
): { placements: RefPlacement[]; unsupported: string[] } {
  const unsupported: string[] = [];
  const visit = (schema: JsonValue, segments: string[]): RefPlacement[] => {
    if (!isJsonObject(schema)) return [];
    const ref = schema["$ref"];
    if (typeof ref === "string") {
      return keep.has(ref) ? [{ prefix: formatPointer(segments), guards: [], ref }] : [];
    }
    const found: RefPlacement[] = [];
    for (const key of ["oneOf", "anyOf", "not"]) {
      const value = schema[key];
      if (value === undefined) continue;
      const branches = (Array.isArray(value) ? value : [value]) as JsonValue[];
      branches.forEach((branch, index) => {
        const inner = visit(branch, segments);
        if (inner.length === 0) return;
        const at = formatPointer(segments);
        const guard =
          key === "not" ? undefined : guardFor(document, schema, branches, index, at);
        if (!guard) {
          if (unsupported.length < MAX_NOTES) {
            unsupported.push(
              `${at || "/"} reaches the schema through ${key}, and nothing tells its branches apart`,
            );
          }
          return;
        }
        for (const each of inner)
          found.push({ ...each, guards: [guard, ...each.guards] });
      });
    }
    const allOf = schema["allOf"];
    if (Array.isArray(allOf))
      for (const part of allOf) found.push(...visit(part, segments));
    const properties = schema["properties"];
    if (isJsonObject(properties)) {
      for (const name of Object.keys(properties).sort()) {
        found.push(...visit(properties[name] as JsonValue, [...segments, name]));
      }
    }
    const items = schema["items"];
    if (items !== undefined) found.push(...visit(items, [...segments, "*"]));
    const values = schema["additionalProperties"];
    if (isJsonObject(values)) found.push(...visit(values, [...segments, "{}"]));
    return found;
  };
  return { placements: visit(root, []), unsupported };
}

/** The references from which any of `targets` can be reached, the targets included. */
export function leadingToAny(
  document: OpenApiDocument,
  targets: Iterable<string>,
): Set<string> {
  const all = new Set<string>();
  for (const target of targets)
    for (const ref of leadingTo(document, target)) all.add(ref);
  return all;
}

/**
 * Whether the places `schemaRef` sits cannot be listed one by one: some
 * schema on the way to it contains itself, so the places are unbounded, or
 * they are too many to walk. Such a schema is served by blocks that follow
 * the value; listing its places would silently leave the deeper ones out.
 */
export function needsSharedBlocks(document: OpenApiDocument, schemaRef: string): boolean {
  const leads = leadingTo(document, schemaRef);
  const state = new Map<string, "open" | "done">();
  const cyclic = (ref: string): boolean => {
    if (state.get(ref) === "done") return false;
    if (state.get(ref) === "open") return true;
    state.set(ref, "open");
    const children = new Set<string>();
    refsIn(resolveRef(document, ref), children);
    for (const child of children) {
      if (leads.has(child) && cyclic(child)) return true;
    }
    state.set(ref, "done");
    return false;
  };
  for (const ref of leads) if (cyclic(ref)) return true;
  return findSchemaSites(document, schemaRef).exhausted === true;
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
