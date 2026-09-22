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
 * Wherever the field cannot be found with certainty, the entry is kept: this
 * only removes what it can show is not breaking.
 */
import { type OpenApiDocument, resolveSchema } from "@invariant-app/contract";
import { isJsonObject, type JsonObject, type JsonValue } from "@invariant-app/ir";
import type { DiffEntry } from "./oasdiff.ts";

const ADDED =
  /^added the new `.*` enum value to the `(.+)` response property for the response status `(.+)`$/;
const REMOVED_PROPERTY = /^removed the enum value `.*` of the request property `(.+)`$/;
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
    if (entry.id === "request-property-enum-value-removed") {
      const match = REMOVED_PROPERTY.exec(entry.text);
      if (!match) return true;
      const [, pointer = ""] = match;
      return !once(`removed ${at} body ${pointer}`, () =>
        listsNoValues(revision, requestSchemas(revision, entry), pointer),
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
 * The field at the differ's pointer, which names properties, `items` and
 * union branches, and ends with `items/` where the values are a list's items.
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
    } else if (branch !== undefined) {
      at = resolveSchema(base, branch);
    } else {
      return undefined;
    }
  }
  return isJsonObject(at) ? at : undefined;
}
