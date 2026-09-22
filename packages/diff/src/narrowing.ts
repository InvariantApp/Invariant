/**
 * A response field that took a list of values where it had none, which the
 * differ reports as every value in the list added.
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
 * `enum` nor `const`. Wherever the field cannot be found with certainty, the
 * entry is kept: this only removes what it can show is not breaking.
 */
import { type OpenApiDocument, resolveSchema } from "@invariant-app/contract";
import { isJsonObject, type JsonObject, type JsonValue } from "@invariant-app/ir";
import type { DiffEntry } from "./oasdiff.ts";

const ADDED =
  /^added the new `.*` enum value to the `(.+)` response property for the response status `(.+)`$/;

export function withoutNarrowing(
  entries: readonly DiffEntry[],
  base: OpenApiDocument,
): DiffEntry[] {
  const unconstrained = new Map<string, boolean>();
  return entries.filter((entry) => {
    if (entry.id !== "response-property-enum-value-added") return true;
    const match = ADDED.exec(entry.text);
    if (!match) return true;
    const [, pointer = "", status = ""] = match;
    const key = `${entry.operation} ${entry.path} ${status} ${pointer}`;
    let known = unconstrained.get(key);
    if (known === undefined) {
      known = allowedAnyValue(base, entry, status, pointer);
      unconstrained.set(key, known);
    }
    return !known;
  });
}

/** Whether every schema the entry's response gives the field lists no values. */
function allowedAnyValue(
  base: OpenApiDocument,
  entry: DiffEntry,
  status: string,
  pointer: string,
): boolean {
  try {
    const paths = (base as JsonObject)["paths"];
    const item = isJsonObject(paths) ? paths[entry.path] : undefined;
    const operation = isJsonObject(item)
      ? item[entry.operation.toLowerCase()]
      : undefined;
    const responses = isJsonObject(operation) ? operation["responses"] : undefined;
    const response = isJsonObject(responses)
      ? resolveSchema(base, responses[status] ?? null)
      : undefined;
    const content = isJsonObject(response) ? response["content"] : undefined;
    if (!isJsonObject(content)) return false;
    const fields = Object.values(content).map((media) =>
      isJsonObject(media) ? walk(base, media["schema"] ?? null, pointer) : undefined,
    );
    const found = fields.filter((field) => field !== undefined);
    // Every media type has to be understood, or the entry may be about one that was not.
    return (
      found.length === fields.length &&
      found.length > 0 &&
      found.every((field) => field["enum"] === undefined && field["const"] === undefined)
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
