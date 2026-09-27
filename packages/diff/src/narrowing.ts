/**
 * A list of values that appeared on a response field, or left a request field,
 * which the differ reports as every value in it added or removed.
 *
 * PayPal's error details carry a `location`, once any string and then one of
 * `body`, `path` or `query`. A response that can hold fewer values than it
 * could breaks no caller, yet the differ compares the two lists of values,
 * finds the old one empty, and reports each new value as added, which is the
 * breaking change of a response value old callers were never told of. Across
 * PayPal that was hundreds of places no Change could explain, because nothing
 * about them needed explaining.
 *
 * So an added value is dropped where the field it was added to allowed any
 * value before: found in the old document, through the response the entry
 * names, through properties, list items and union branches, it has neither
 * `enum` nor `const`.
 *
 * The other way round is the same. Mistral's fine-tuning `model` was one of
 * nine names and became any string: every name old callers send is still
 * accepted, and the differ reported nine removed request values. A removed
 * value is dropped where the request field, found in the new document, lists
 * no values at all. On a response the same change is real, old callers may
 * be sent names they never heard of, and it is left for a Change to declare.
 *
 * A response that was a choice between schemas and now gives only kinds it
 * could already give is the same. Stripe's terminal reader `cancel_action`
 * answered with a reader or a deleted reader, and then with a reader only:
 * every answer is one old callers were promised, yet the differ reads the
 * choice as an object with no fields, and reports each of the reader's as a
 * required property added to the response. Such an entry is dropped where the
 * object holding the property was, in the old document, a union with a branch
 * equal to each kind the new document gives there.
 *
 * A request field whose values the new document lists, and says in the same
 * place that it does not hold callers to, is the same again. Stripe's reason
 * for rejecting an account was any text and became seven names, marked
 * `x-stripeBypassValidation` and, in `x-stripeEnum`, `open`: the server still
 * takes the `fraud` an old caller sends. Such an entry is dropped where the
 * request field, found in the new document, carries either mark.
 *
 * Wherever the field cannot be found with certainty, the entry is kept: this
 * only removes what it can show is not breaking.
 */
import { isDeepStrictEqual } from "node:util";
import { type OpenApiDocument, resolveSchema } from "@invariant-app/contract";
import { isJsonObject, type JsonObject, type JsonValue } from "@invariant-app/ir";
import type { DiffEntry } from "./oasdiff.ts";

const ADDED =
  /^added the new `.*` enum value to the `(.+)` response property for the response status `(.+)`$/;
const REQUIRED_ADDED =
  /^added the required property `(.+)` to the response with the `(.+)` status$/;
const BECAME_ENUM = /^request property `(.+)` was restricted to a list of enum values$/;
const REMOVED_PROPERTY = /^removed the enum value `.*` of the request property `(.+)`$/;
const REMOVED_REQUEST_PROPERTY = /^removed the request property `(.+)`$/;
const REMOVED_PARAMETER =
  /^removed the enum value `.*` from the `(path|query|header|cookie)` request parameter `(.+)`$/;

export function withoutNarrowing(
  entries: readonly DiffEntry[],
  base: OpenApiDocument,
  revision: OpenApiDocument,
): DiffEntry[] {
  const unconstrained = new Map<string, boolean>();
  const once = (key: string, find: () => boolean): boolean => {
    let known = unconstrained.get(key);
    if (known === undefined) {
      known = find();
      unconstrained.set(key, known);
    }
    return known;
  };
  return entries.filter((entry) => {
    const at = `${entry.operation} ${entry.path}`;
    if (entry.id === "response-property-enum-value-added") {
      const match = ADDED.exec(entry.text);
      if (!match) return true;
      const [, pointer = "", status = ""] = match;
      return !once(`added ${at} ${status} ${pointer}`, () =>
        listsNoValues(base, responseSchemas(base, entry, status), pointer),
      );
    }
    if (entry.id === "response-required-property-added") {
      const match = REQUIRED_ADDED.exec(entry.text);
      if (!match) return true;
      const [, pointer = "", status = ""] = match;
      const holder = segmentsOf(pointer).slice(0, -1).join("/");
      return !once(`required ${at} ${status} ${holder}`, () =>
        narrowedChoice(
          { document: base, schemas: responseSchemas(base, entry, status) },
          { document: revision, schemas: responseSchemas(revision, entry, status) },
          holder,
        ),
      );
    }
    if (entry.id === "request-property-enum-value-removed") {
      const match = REMOVED_PROPERTY.exec(entry.text);
      if (!match) return true;
      const [, pointer = ""] = match;
      return !once(
        `removed ${at} body ${pointer}`,
        () =>
          listsNoValues(revision, requestSchemas(revision, entry), pointer) ||
          heldToNoValues(revision, requestSchemas(revision, entry), pointer),
      );
    }
    if (entry.id === "request-property-became-enum") {
      const match = BECAME_ENUM.exec(entry.text);
      if (!match) return true;
      const [, pointer = ""] = match;
      return !once(`open ${at} body ${pointer}`, () =>
        heldToNoValues(revision, requestSchemas(revision, entry), pointer),
      );
    }
    if (entry.id === "request-property-removed") {
      const match = REMOVED_REQUEST_PROPERTY.exec(entry.text);
      if (!match) return true;
      const [, pointer = ""] = match;
      return !once(`moved ${at} ${pointer}`, () =>
        inEveryVariant(revision, requestSchemas(revision, entry), pointer),
      );
    }
    if (entry.id === "request-parameter-enum-value-removed") {
      const match = REMOVED_PARAMETER.exec(entry.text);
      if (!match) return true;
      const [, location = "", name = ""] = match;
      return !once(`removed ${at} ${location} ${name}`, () =>
        listsNoValues(revision, parameterSchemas(revision, entry, location, name), ""),
      );
    }
    return true;
  });
}

/** The operation an entry names, in a document. */
function operationOf(
  document: OpenApiDocument,
  entry: DiffEntry,
): JsonObject | undefined {
  const paths = (document as JsonObject)["paths"];
  const item = isJsonObject(paths) ? paths[entry.path] : undefined;
  const operation = isJsonObject(item) ? item[entry.operation.toLowerCase()] : undefined;
  return isJsonObject(operation) ? operation : undefined;
}

/** The schema of each media type in a body or response, or undefined where it has none. */
function mediaSchemas(
  document: OpenApiDocument,
  holder: JsonValue | undefined,
): JsonValue[] | undefined {
  const resolved = holder === undefined ? undefined : resolveSchema(document, holder);
  const content = isJsonObject(resolved) ? resolved["content"] : undefined;
  if (!isJsonObject(content)) return undefined;
  return Object.values(content).map((media) =>
    isJsonObject(media) ? (media["schema"] ?? null) : null,
  );
}

function responseSchemas(
  document: OpenApiDocument,
  entry: DiffEntry,
  status: string,
): JsonValue[] | undefined {
  const responses = operationOf(document, entry)?.["responses"];
  return isJsonObject(responses) ? mediaSchemas(document, responses[status]) : undefined;
}

function requestSchemas(
  document: OpenApiDocument,
  entry: DiffEntry,
): JsonValue[] | undefined {
  return mediaSchemas(document, operationOf(document, entry)?.["requestBody"]);
}

/** The schema of a parameter, declared on the operation or on its path. */
function parameterSchemas(
  document: OpenApiDocument,
  entry: DiffEntry,
  location: string,
  name: string,
): JsonValue[] | undefined {
  const paths = (document as JsonObject)["paths"];
  const item = isJsonObject(paths) ? paths[entry.path] : undefined;
  const declared = [
    ...(isJsonObject(item) && Array.isArray(item["parameters"])
      ? item["parameters"]
      : []),
    ...((operationOf(document, entry)?.["parameters"] as JsonValue[] | undefined) ?? []),
  ].map((parameter) => resolveSchema(document, parameter));
  const found = declared.filter(
    (parameter) =>
      isJsonObject(parameter) &&
      parameter["in"] === location &&
      parameter["name"] === name,
  );
  const last = found[found.length - 1];
  return isJsonObject(last) && last["schema"] !== undefined
    ? [last["schema"]]
    : undefined;
}

/**
 * Whether a request property the differ reports removed is still accepted
 * because every variant of the choice it sits in now has it. Okta's signing
 * key request lost the `allOf` base that held `kid`, and each of its RSA and
 * EC variants gained it: an old caller sending `kid` is still accepted, and a
 * Change dropping it from their requests would lose their key's id.
 */
function inEveryVariant(
  document: OpenApiDocument,
  schemas: JsonValue[] | undefined,
  pointer: string,
): boolean {
  try {
    const segments = segmentsOf(pointer);
    const name = segments.pop();
    if (schemas === undefined || schemas.length === 0 || name === undefined) return false;
    return schemas.every((schema) => {
      const parent = walk(document, schema, segments.join("/"));
      if (parent === undefined) return false;
      const variants = ["oneOf", "anyOf"].flatMap((keyword) =>
        Array.isArray(parent[keyword]) ? (parent[keyword] as JsonValue[]) : [],
      );
      return (
        variants.length > 0 &&
        variants.every((variant) => {
          const resolved = resolveSchema(document, variant);
          const properties = isJsonObject(resolved) ? resolved["properties"] : undefined;
          return isJsonObject(properties) && properties[name] !== undefined;
        })
      );
    });
  } catch {
    return false;
  }
}

/**
 * Whether the object at the pointer was a union in every old schema, and in
 * every new one gives only kinds, resolved, equal to one of its branches.
 */
function narrowedChoice(
  before: { document: OpenApiDocument; schemas: JsonValue[] | undefined },
  after: { document: OpenApiDocument; schemas: JsonValue[] | undefined },
  pointer: string,
): boolean {
  try {
    if (!before.schemas?.length || !after.schemas?.length) return false;
    const unionOf = (at: JsonObject | undefined): JsonValue[] | undefined => {
      if (at === undefined) return undefined;
      const keyword = ["oneOf", "anyOf"].find((key) => Array.isArray(at[key]));
      return keyword === undefined ? undefined : (at[keyword] as JsonValue[]);
    };
    const branches = before.schemas.map((schema) => {
      const union = unionOf(walk(before.document, schema, pointer));
      return union?.map((branch) => resolveSchema(before.document, branch));
    });
    return after.schemas.every((schema) => {
      const at = walk(after.document, schema, pointer);
      if (at === undefined) return false;
      const kinds = (unionOf(at) ?? [at]).map((kind) =>
        resolveSchema(after.document, kind),
      );
      return branches.every(
        (old) =>
          old !== undefined &&
          kinds.every((kind) => old.some((branch) => isDeepStrictEqual(branch, kind))),
      );
    });
  } catch {
    return false;
  }
}

/**
 * Whether the field at the pointer, in every schema given, says its list of
 * values is open: Stripe's `x-stripeBypassValidation`, or an `x-stripeEnum`
 * of kind `open`.
 */
function heldToNoValues(
  document: OpenApiDocument,
  schemas: JsonValue[] | undefined,
  pointer: string,
): boolean {
  try {
    if (schemas === undefined || schemas.length === 0) return false;
    return schemas.every((schema) => {
      const field = walk(document, schema, pointer);
      if (field === undefined) return false;
      const listed = field["x-stripeEnum"];
      return (
        field["x-stripeBypassValidation"] === true ||
        (isJsonObject(listed) && listed["kind"] === "open")
      );
    });
  } catch {
    return false;
  }
}

/** Whether the field at the pointer, in every schema given, lists no values. */
function listsNoValues(
  document: OpenApiDocument,
  schemas: JsonValue[] | undefined,
  pointer: string,
): boolean {
  try {
    if (schemas === undefined || schemas.length === 0) return false;
    const fields = schemas.map((schema) => walk(document, schema, pointer));
    return fields.every(
      (field) =>
        field !== undefined &&
        field["enum"] === undefined &&
        field["const"] === undefined,
    );
  } catch {
    return false;
  }
}

/** The pointer's segments: a `/` inside a union's brackets is part of its segment. */
function segmentsOf(pointer: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of pointer) {
    if (char === "[") depth += 1;
    if (char === "]") depth -= 1;
    if (char === "/" && depth === 0) {
      segments.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  segments.push(current);
  return segments.filter((segment) => segment !== "");
}

/**
 * A branch of a union as the differ names it, on the old side: by position,
 * `oneOf[subschema #2: Title]` (or `... -> subschema #3: Title` where the
 * branch moved, whose left side is the old one), or by the schema it refers
 * to, `anyOf[#/components/schemas/Card]`.
 */
const BRANCH = /^(oneOf|anyOf)\[(.*)\]$/;

function branchOf(at: JsonObject, segment: string): JsonValue | undefined {
  const match = BRANCH.exec(segment);
  if (!match) return undefined;
  const [, keyword = "", name = ""] = match;
  const branches = at[keyword];
  if (!Array.isArray(branches)) return undefined;
  const old = name.split(" -> ")[0] ?? "";
  const position = /^subschema #(\d+)(:|$)/.exec(old);
  if (position) return branches[Number(position[1]) - 1];
  return branches.find((branch) => isJsonObject(branch) && branch["$ref"] === old);
}

/**
 * The field at the differ's pointer, which names properties, `items`, a
 * map's `additionalProperties` and union branches, and ends with `items/`
 * where the values are a list's items.
 */
function walk(
  base: OpenApiDocument,
  schema: JsonValue,
  pointer: string,
): JsonObject | undefined {
  let at = resolveSchema(base, schema);
  for (const segment of segmentsOf(pointer)) {
    if (!isJsonObject(at)) return undefined;
    const properties = at["properties"];
    const branch = branchOf(at, segment);
    if (isJsonObject(properties) && properties[segment] !== undefined) {
      at = resolveSchema(base, properties[segment] as JsonValue);
    } else if (segment === "items" && at["items"] !== undefined) {
      at = resolveSchema(base, at["items"] as JsonValue);
    } else if (
      segment === "additionalProperties" &&
      isJsonObject(at["additionalProperties"])
    ) {
      at = resolveSchema(base, at["additionalProperties"]);
    } else if (branch !== undefined) {
      at = resolveSchema(base, branch);
    } else {
      return undefined;
    }
  }
  return isJsonObject(at) ? at : undefined;
}
