/**
 * What a schema means on the wire, as one function every layer shares.
 *
 * The differ compares documents with `$ref`s followed and `allOf` merged. The
 * proposer read them with references followed and `allOf` ignored, and the
 * compiler read them with neither, so the three were reasoning about three
 * different documents. The visible symptom was a draft that the proposer
 * derived from an enum and the compiler then said had no enum: the enum was
 * behind a `$ref` only one of them looked through. Reading and writing now go
 * through the same view, so they cannot disagree about what a field is.
 */
import { isJsonObject, type JsonObject, type JsonValue } from "@invariant/ir";
import { ContractError, deref, type OpenApiDocument } from "./spec.ts";

/** Deepest `allOf` nesting followed before giving up, which only a cycle reaches. */
const MAX_DEPTH = 32;

/**
 * The schema as it applies to a value: every `$ref` in the chain followed and
 * every `allOf` merged into one object.
 *
 * Never returns part of the document itself when anything had to be merged,
 * so a caller may keep or change the result without touching a shared schema.
 * When nothing needed merging the referenced schema is returned as it is, and
 * must be treated as read-only.
 */
export function resolveSchema(document: OpenApiDocument, schema: JsonValue): JsonValue {
  return resolveAt(document, schema, 0);
}

function resolveAt(
  document: OpenApiDocument,
  schema: JsonValue,
  depth: number,
): JsonValue {
  if (depth > MAX_DEPTH) throw new ContractError("allOf nests too deeply to resolve");
  const target = deref(document, schema);
  if (!isJsonObject(target)) return target;
  const branches = target["allOf"];
  if (!Array.isArray(branches)) return target;

  // Keywords beside `allOf` apply to the value too, so they are one more branch.
  const { allOf: _, ...siblings } = target;
  const parts = [
    ...branches.map((branch) => resolveAt(document, branch, depth + 1)),
    siblings,
  ].filter(isJsonObject);
  const merged = parts.reduce<JsonObject>(
    (result, part) => mergeSchemas(document, result, part, depth),
    {},
  );
  // A value can be null only if every part says it can, a part that says
  // nothing included: `nullable: true` beside an `allOf` of a schema that
  // does not allow null allows nothing more. The differ merges it this way,
  // and closure is judged by the differ, so reading it any other way drafted
  // a nullability change on a Plaid field that no document made.
  if (parts.every((part) => part["nullable"] === true)) merged["nullable"] = true;
  else delete merged["nullable"];
  return merged;
}

const LOWER_BOUNDS = [
  "minimum",
  "exclusiveMinimum",
  "minLength",
  "minItems",
  "minProperties",
];
const UPPER_BOUNDS = [
  "maximum",
  "exclusiveMaximum",
  "maxLength",
  "maxItems",
  "maxProperties",
];

/**
 * Two schemas a value must satisfy at once, as one.
 *
 * The rule for each keyword is the one that keeps the meaning of "both":
 * properties and required fields accumulate, bounds take the tighter, an enum
 * keeps only values both allow, and anything that is only descriptive keeps the
 * first statement of it.
 */
function mergeSchemas(
  document: OpenApiDocument,
  left: JsonObject,
  right: JsonObject,
  depth: number,
): JsonObject {
  const out: JsonObject = structuredClone(left);

  for (const [key, value] of Object.entries(right)) {
    const current = out[key];
    if (current === undefined) {
      out[key] = structuredClone(value);
      continue;
    }

    if (key === "properties" && isJsonObject(current) && isJsonObject(value)) {
      const properties: JsonObject = { ...current };
      for (const [name, schema] of Object.entries(value)) {
        const existing = properties[name];
        properties[name] =
          existing === undefined
            ? structuredClone(schema)
            : resolveAt(document, { allOf: [existing, schema] }, depth + 1);
      }
      out[key] = properties;
    } else if (key === "items" && isJsonObject(current) && isJsonObject(value)) {
      out[key] = resolveAt(document, { allOf: [current, value] }, depth + 1);
    } else if (key === "required" && Array.isArray(current) && Array.isArray(value)) {
      out[key] = [...new Set([...current, ...value])];
    } else if (key === "enum" && Array.isArray(current) && Array.isArray(value)) {
      const allowed = new Set(value.map((entry) => JSON.stringify(entry)));
      const both = current.filter((entry) => allowed.has(JSON.stringify(entry)));
      // Lists with nothing in common describe no value at all, which is a
      // mistake in the document rather than an API: PagerDuty's
      // `AcknowledgeLogEntry` allows `acknowledgement_log_entry` where its base
      // allows `acknowledge_log_entry`. The first statement is kept, as for an
      // annotation, and the differ is given the same reading.
      if (both.length > 0) out[key] = both;
    } else if (
      LOWER_BOUNDS.includes(key) &&
      typeof current === "number" &&
      typeof value === "number"
    ) {
      out[key] = Math.max(current, value);
    } else if (
      UPPER_BOUNDS.includes(key) &&
      typeof current === "number" &&
      typeof value === "number"
    ) {
      out[key] = Math.min(current, value);
    } else if (key === "nullable") {
      // A value can be null only if every part says it can.
      out[key] = current === true && value === true;
    } else if (key === "additionalProperties") {
      if (value === false) out[key] = false;
    }
    // Anything else keeps its first statement.
  }

  return out;
}
