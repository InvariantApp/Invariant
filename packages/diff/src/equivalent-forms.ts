/**
 * Two ways of writing the same schema, given the differ in one form.
 *
 * JSON Schema has more than one spelling for several things, and the differ
 * compares spellings. Mistral rewrote every single-valued `enum` in its
 * document as a `const` in one release: `role: {enum: [assistant]}` became
 * `role: {const: assistant}`. Nothing a caller sends or receives changed, and
 * the differ reported 195 removed response values, 131 removed request values
 * and 21 added constants, each one a breaking change blocking the release.
 * The same release moved an inline list of values into a named schema that
 * lists the same values, which the differ reads as one branch of a union
 * removed and another added.
 *
 * So before comparing, both documents are put in one form:
 *
 * - `const: x` is written `enum: [x]`, which JSON Schema defines to mean
 *   the same.
 * - A reference to a named schema that holds a single value, a string, a
 *   number or a boolean, and nothing that refers onward, is replaced by a
 *   copy of it, without the title that named it. Such a schema is a list of values and constraints; where it
 *   is written does not change what it allows. A reference to anything with
 *   structure is left alone, so the differ still reports a change to a shared
 *   object once, where it was made.
 * - An enum of a schema whose type is text lists its values as text. Plaid
 *   wrote its Prism versions as `type: string, enum: [4.1, 4, 3]` and a
 *   later release as `enum: ["4.1", "4", "3"]`: read literally the first
 *   allowed no text at all, callers sent `"3"` all along, and the differ
 *   reported thirty-three values removed. A number there is the text it is
 *   written as.
 * - A way to authenticate that names a scheme the document never declares is
 *   left out. Supabase listed `fga_permissions` beside `bearer` on hundreds of
 *   operations without ever declaring it; no caller could use it, so its
 *   removal broke nobody, and the differ reported every one. Where every way
 *   listed names an undeclared scheme, the list is left as it is: an empty one
 *   would mean no authentication at all.
 *
 * Only the documents handed to the differ change, never the contract.
 */
import type { OpenApiDocument } from "@invariant-app/contract";
import { isJsonObject, type JsonObject, type JsonValue } from "@invariant-app/ir";

/** Keywords whose value is data, not a schema: nothing under them is rewritten. */
const DATA = new Set(["example", "examples", "default", "enum", "const", "x-examples"]);

/** Keywords whose value maps names to schemas: the map itself is not a schema. */
const MAPS = new Set([
  "properties",
  "patternProperties",
  "schemas",
  "definitions",
  "$defs",
  "dependentSchemas",
]);

/** Keywords that make a schema more than a single value. */
const STRUCTURE = [
  "$ref",
  "properties",
  "patternProperties",
  "additionalProperties",
  "items",
  "prefixItems",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "discriminator",
] as const;

const SCALARS = new Set(["string", "integer", "number", "boolean", "null"]);

const SCHEMA_REF = "#/components/schemas/";

function isScalarSchema(schema: JsonObject): boolean {
  if (STRUCTURE.some((keyword) => keyword in schema)) return false;
  const type = schema["type"];
  const types = Array.isArray(type) ? type : type === undefined ? [] : [type];
  if (types.length === 0) return Array.isArray(schema["enum"]) || "const" in schema;
  return types.every((entry) => typeof entry === "string" && SCALARS.has(entry));
}

/** `const: x` as `enum: [x]`, in place. */
function constAsEnum(schema: JsonObject): void {
  if (!("const" in schema) || "enum" in schema) return;
  schema["enum"] = [schema["const"] as JsonValue];
  delete schema["const"];
}

/** A text schema's numeric enum values as the text they are written as, in place. */
function textEnum(schema: JsonObject): void {
  const values = schema["enum"];
  if (!Array.isArray(values) || !values.some((value) => typeof value === "number"))
    return;
  const type = schema["type"];
  const types = Array.isArray(type) ? type : [type];
  if (
    !types.includes("string") ||
    types.some((entry) => entry !== "string" && entry !== "null")
  )
    return;
  schema["enum"] = values.map((value) =>
    typeof value === "number" ? String(value) : value,
  );
}

export function equivalentForms(document: OpenApiDocument): OpenApiDocument {
  const copy = structuredClone(document) as unknown as JsonObject;
  const components = isJsonObject(copy["components"]) ? copy["components"] : undefined;
  const schemas =
    components && isJsonObject(components["schemas"]) ? components["schemas"] : {};

  // The scalar schemas a reference may be replaced with, each already in the
  // one form, and never one that refers onward.
  const inlinable = new Map<string, JsonObject>();
  for (const [name, schema] of Object.entries(schemas)) {
    if (!isJsonObject(schema) || !isScalarSchema(schema)) continue;
    const form = structuredClone(schema);
    constAsEnum(form);
    textEnum(form);
    // The name it was given is the component's, not the value's: an inline
    // copy of the same values has none, and the differ matches union branches
    // by it, reading a named copy as a different branch.
    delete form["title"];
    // A reference is a JSON Pointer, which a document may also percent-encode.
    const pointer = name.replaceAll("~", "~0").replaceAll("/", "~1");
    inlinable.set(`${SCHEMA_REF}${pointer}`, form);
    inlinable.set(`${SCHEMA_REF}${encodeURIComponent(pointer)}`, form);
  }

  const visit = (node: JsonValue, isMap: boolean): JsonValue => {
    if (Array.isArray(node)) return node.map((entry) => visit(entry, false));
    if (!isJsonObject(node)) return node;
    if (!isMap) {
      const ref = node["$ref"];
      if (typeof ref === "string" && Object.keys(node).length === 1) {
        const target = inlinable.get(ref);
        if (target) return structuredClone(target);
      }
      constAsEnum(node);
      textEnum(node);
    }
    for (const [key, value] of Object.entries(node)) {
      if (!isMap && (DATA.has(key) || key.startsWith("x-"))) continue;
      node[key] = visit(value, !isMap && MAPS.has(key));
    }
    return node;
  };

  declaredSecurity(copy);

  // The definitions themselves stay as they are, apart from the one form, so
  // a change to a shared object is still reported once, at its definition.
  return visit(copy, false) as unknown as OpenApiDocument;
}

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/** Leaves out, in place, each way to authenticate that names an undeclared scheme. */
function declaredSecurity(document: JsonObject): void {
  const components = document["components"];
  const schemes =
    isJsonObject(components) && isJsonObject(components["securitySchemes"])
      ? new Set(Object.keys(components["securitySchemes"]))
      : new Set<string>();
  const usable = (holder: JsonObject) => {
    const ways = holder["security"];
    if (!Array.isArray(ways)) return;
    const kept = ways.filter(
      (way) => isJsonObject(way) && Object.keys(way).every((name) => schemes.has(name)),
    );
    if (kept.length > 0 && kept.length < ways.length) holder["security"] = kept;
  };
  usable(document);
  const paths = document["paths"];
  if (!isJsonObject(paths)) return;
  for (const item of Object.values(paths)) {
    if (!isJsonObject(item)) continue;
    for (const method of METHODS) {
      const operation = item[method];
      if (isJsonObject(operation)) usable(operation);
    }
  }
}
