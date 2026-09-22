/**
 * Applying ops to a JSON Schema rather than to data.
 *
 * This is what makes the closure check possible: if the declared Changes are a
 * complete account of what the provider did, then replaying them over the old
 * specification has to reproduce the new one. Anything left over is a change
 * nobody explained.
 */
import { jsonKindOf, type OpenApiDocument, resolveSchema } from "@invariant/contract";
import { compareDecimal, numberToDecimalText, shiftDecimal } from "@invariant/decimal";
import {
  type Codec,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  narrows,
  parsePointer,
  type ScalarType,
  type StringCase,
  type TimeFormat,
  vocabularyGrows,
} from "@invariant/ir";
import { CodecRefusal, convertCase, convertTime } from "@invariant/runtime";

export class SchemaOpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaOpError";
  }
}

function clone<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

/**
 * The keyword a wildcard segment stands for: `*` every item of a list, and
 * `{}` every value of a map.
 */
const WILDCARD_KEYWORD: Readonly<Record<string, string>> = {
  "*": "items",
  "{}": "additionalProperties",
};

/** A schema navigation step: an object property, every item of a list, or every value of a map. */
function childOf(schema: JsonObject, segment: string): JsonValue | undefined {
  const keyword = WILDCARD_KEYWORD[segment];
  if (keyword) return schema[keyword];
  const properties = schema["properties"];
  if (!isJsonObject(properties)) return undefined;
  return properties[segment];
}

export function schemaGet(
  schema: JsonValue,
  segments: readonly string[],
): JsonValue | undefined {
  let current: JsonValue | undefined = schema;
  for (const segment of segments) {
    if (!isJsonObject(current)) return undefined;
    current = childOf(current, segment);
  }
  return current;
}

function isRequired(parent: JsonObject, name: string): boolean {
  const required = parent["required"];
  return Array.isArray(required) && required.includes(name);
}

function setRequired(parent: JsonObject, name: string, required: boolean): void {
  const current = Array.isArray(parent["required"])
    ? [...(parent["required"] as JsonValue[])]
    : [];
  const without = current.filter((entry) => entry !== name);
  if (required) without.push(name);
  if (without.length === 0) {
    delete parent["required"];
  } else {
    // Keep declaration order stable so a predicted spec does not differ from
    // the real one purely by ordering.
    parent["required"] = without;
  }
}

/**
 * Makes a node in the path this change's own, and returns it.
 *
 * A node that is a `$ref`, or an `allOf` of several, is replaced by a merged
 * copy through the same resolution every other layer uses. Writing into the
 * copy changes only the schema this change is scoped to; writing through the
 * reference would change every other schema that shares it, including ones the
 * change says nothing about.
 */
function own(document: OpenApiDocument, holder: JsonObject, key: string): JsonObject {
  const value = holder[key];
  if (!isJsonObject(value)) throw new SchemaOpError(`"${key}" is not a schema`);
  if (value["$ref"] === undefined && !Array.isArray(value["allOf"])) return value;
  const resolved = resolveSchema(document, value);
  if (!isJsonObject(resolved)) throw new SchemaOpError(`"${key}" is not a schema`);
  const copy = structuredClone(resolved);
  holder[key] = copy;
  return copy;
}

/** The scope schema itself, merged in place when it is a reference or an `allOf`. */
function ownRoot(document: OpenApiDocument, root: JsonObject): JsonObject {
  if (root["$ref"] === undefined && !Array.isArray(root["allOf"])) return root;
  const resolved = resolveSchema(document, root);
  if (!isJsonObject(resolved)) throw new SchemaOpError("The scope is not a schema");
  const copy = structuredClone(resolved);
  for (const key of Object.keys(root)) delete root[key];
  Object.assign(root, copy);
  return root;
}

/**
 * Walks to a parent container, creating intermediate object schemas as needed.
 * Every node on the way is made this change's own first, so a shared schema is
 * never mutated by a change that targets one use of it.
 */
function parentFor(
  document: OpenApiDocument,
  root: JsonObject,
  segments: readonly string[],
  create: boolean,
): { parent: JsonObject; last: string } {
  if (segments.length === 0) throw new SchemaOpError("Cannot target the schema root");

  let current = ownRoot(document, root);
  for (const segment of segments.slice(0, -1)) {
    const keyword = WILDCARD_KEYWORD[segment];
    if (keyword) {
      if (!isJsonObject(current[keyword]))
        throw new SchemaOpError(`Cannot walk into a non-object ${keyword}`);
      current = own(document, current, keyword);
      continue;
    }
    let properties = current["properties"];
    if (!isJsonObject(properties)) {
      if (!create) throw new SchemaOpError(`No properties at "${segment}"`);
      properties = {};
      current["properties"] = properties;
      current["type"] = "object";
    }
    if ((properties as JsonObject)[segment] === undefined) {
      if (!create) throw new SchemaOpError(`No property "${segment}"`);
      (properties as JsonObject)[segment] = { type: "object", properties: {} };
    }
    current = own(document, properties as JsonObject, segment);
  }

  return { parent: current, last: segments[segments.length - 1] as string };
}

function readSlot(
  document: OpenApiDocument,
  root: JsonObject,
  segments: readonly string[],
): { parent: JsonObject; last: string; schema: JsonValue; required: boolean } {
  const { parent, last } = parentFor(document, root, segments, false);
  const keyword = WILDCARD_KEYWORD[last];
  const schema = keyword
    ? parent[keyword]
    : (parent["properties"] as JsonObject | undefined)?.[last];
  if (schema === undefined) {
    throw new SchemaOpError(`Nothing to read at "${segments.join("/")}"`);
  }
  return { parent, last, schema, required: !keyword && isRequired(parent, last) };
}

function deleteSlot(
  document: OpenApiDocument,
  root: JsonObject,
  segments: readonly string[],
): void {
  const { parent, last } = parentFor(document, root, segments, false);
  const keyword = WILDCARD_KEYWORD[last];
  if (keyword) {
    delete parent[keyword];
    return;
  }
  const properties = parent["properties"];
  if (isJsonObject(properties)) delete properties[last];
  setRequired(parent, last, false);
}

function writeSlot(
  document: OpenApiDocument,
  root: JsonObject,
  segments: readonly string[],
  schema: JsonValue,
  required: boolean,
): void {
  const { parent, last } = parentFor(document, root, segments, true);
  const keyword = WILDCARD_KEYWORD[last];
  if (keyword) {
    parent[keyword] = schema;
    return;
  }
  let properties = parent["properties"];
  if (!isJsonObject(properties)) {
    properties = {};
    parent["properties"] = properties;
    parent["type"] = "object";
  }
  (properties as JsonObject)[last] = schema;
  setRequired(parent, last, required);

  // A newly created intermediate object is required exactly when the value it
  // now holds was required.
  for (let depth = segments.length - 1; depth >= 1; depth -= 1) {
    const ancestorPath = segments.slice(0, depth);
    const grand = parentFor(document, root, ancestorPath, false);
    const name = ancestorPath[ancestorPath.length - 1] as string;
    if (WILDCARD_KEYWORD[name]) continue;
    if (required && !isRequired(grand.parent, name))
      setRequired(grand.parent, name, true);
  }
}

export function schemaMove(
  document: OpenApiDocument,
  root: JsonObject,
  from: string,
  to: string,
): void {
  const fromSegments = parsePointer(from);
  const toSegments = parsePointer(to);
  const slot = readSlot(document, root, fromSegments);
  const moved = clone(slot.schema);
  deleteSlot(document, root, fromSegments);
  writeSlot(document, root, toSegments, moved, slot.required);
  pruneEmptyObjects(document, root, fromSegments);
}

/** Drops intermediate objects a move emptied out. */
function pruneEmptyObjects(
  document: OpenApiDocument,
  root: JsonObject,
  segments: readonly string[],
): void {
  for (let depth = segments.length - 1; depth >= 1; depth -= 1) {
    const path = segments.slice(0, depth);
    let node: JsonValue | undefined;
    try {
      node = schemaGet(root, path);
    } catch {
      return;
    }
    if (!isJsonObject(node)) return;
    const properties = node["properties"];
    const empty = isJsonObject(properties) && Object.keys(properties).length === 0;
    if (!empty) return;
    deleteSlot(document, root, path);
  }
}

const NUMERIC_BOUNDS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
] as const;

function scaleBound(value: JsonValue, exponent: number): JsonValue {
  if (typeof value !== "number") return value;
  return Number(shiftDecimal(numberToDecimalText(value), exponent));
}

/**
 * `multipleOf` is what makes an exponent checkable at compile time.
 *
 * A major-unit amount declared as `multipleOf: 0.01` is saying it carries two
 * decimal places. Scale it by the right power of ten and the step becomes
 * exactly 1, which is vacuous for an integer and disappears. Scale it by too
 * much and the step stays above 1, which is a real constraint the new contract
 * would have to state; scale it by too little and the step falls below 1, which
 * contradicts calling the result an integer. Either way the mistake surfaces
 * before anything runs.
 */
function applyScale10(schema: JsonObject, exponent: number): JsonObject {
  const out = clone(schema);
  const targetType = exponent > 0 ? "integer" : "number";
  out["type"] = targetType;

  for (const bound of NUMERIC_BOUNDS) {
    if (out[bound] !== undefined) out[bound] = scaleBound(out[bound], exponent);
  }

  const step = out["multipleOf"];
  if (typeof step === "number") {
    const scaled = shiftDecimal(numberToDecimalText(step), exponent);
    if (targetType === "integer" && compareDecimal(scaled, "1") < 0) {
      throw new SchemaOpError(
        `scale10 exponent ${exponent} leaves a step of ${scaled}, so the result cannot be an integer. ` +
          "The exponent is too small for the declared precision.",
      );
    }
    if (compareDecimal(scaled, "1") === 0) delete out["multipleOf"];
    else out["multipleOf"] = Number(scaled);
  }

  return out;
}

function applyEnumMap(
  schema: JsonObject,
  pairs: readonly (readonly [string, string])[],
  fold: readonly (readonly [string, string])[] = [],
): JsonObject {
  const out = clone(schema);
  const forward = new Map(pairs.map(([from, to]) => [from, to]));
  const values = out["enum"];
  if (!Array.isArray(values)) {
    throw new SchemaOpError("enumMap applies only to a schema with an enum");
  }
  out["enum"] = values.map((value) => {
    if (typeof value !== "string") {
      throw new SchemaOpError(
        `enumMap applies only to string enums, found ${typeof value}`,
      );
    }
    const mapped = forward.get(value);
    if (mapped === undefined) {
      throw new SchemaOpError(`enumMap does not cover the existing value "${value}"`);
    }
    return mapped;
  });
  // A folded value exists in the new contract and not the old one, so the
  // predicted document has to grow it or the closure check reports the
  // addition as an unexplained delta, which is the very thing being explained.
  const already = new Set(out["enum"] as string[]);
  for (const [value] of fold) {
    if (!already.has(value)) {
      (out["enum"] as string[]).push(value);
      already.add(value);
    }
  }
  return out;
}

const SCALAR_TO_SCHEMA_TYPE: Record<ScalarType, string> = {
  string: "string",
  integer: "integer",
  number: "number",
  boolean: "boolean",
};

function applyCast(
  schema: JsonObject,
  codec: { from: ScalarType; to: ScalarType },
): JsonObject {
  const out = clone(schema);
  const declared = out["type"];
  if (declared !== undefined && declared !== SCALAR_TO_SCHEMA_TYPE[codec.from]) {
    throw new SchemaOpError(
      `cast declares from "${codec.from}" but the schema says "${String(declared)}"`,
    );
  }
  out["type"] = SCALAR_TO_SCHEMA_TYPE[codec.to];
  if (codec.to === "string") {
    for (const bound of NUMERIC_BOUNDS) delete out[bound];
    delete out["multipleOf"];
  }
  return out;
}

/** The non-null types a schema declares, whichever way it writes them. */
function declaredTypes(schema: JsonObject): string[] {
  const type = schema["type"];
  if (typeof type === "string") return [type];
  if (Array.isArray(type))
    return type.filter(
      (each): each is string => typeof each === "string" && each !== "null",
    );
  return [];
}

/** Sets the type, keeping a 3.1 `"null"` in the list where there was one. */
function retyped(schema: JsonObject, type: string): void {
  const nullable = Array.isArray(schema["type"]) && schema["type"].includes("null");
  schema["type"] = nullable ? [type, "null"] : type;
}

const STRING_BOUNDS = ["minLength", "maxLength", "pattern"] as const;
const TIME_TYPES: Record<TimeFormat, string[]> = {
  "epoch-s": ["integer", "number"],
  "epoch-ms": ["integer", "number"],
  rfc3339: ["string"],
};

/**
 * Runs a value codec over the values a schema lists or starts from, so the
 * predicted contract names them the way the new one does. A listed value the
 * codec refuses is a Change that cannot serve its own contract, so it is
 * reported here, before anything runs.
 */
function convertListed(
  out: JsonObject,
  what: string,
  convert: (value: unknown) => unknown,
): void {
  const each = (value: JsonValue, where: string): JsonValue => {
    if (value === null) return value;
    try {
      return convert(value) as JsonValue;
    } catch (error) {
      if (!(error instanceof CodecRefusal)) throw error;
      throw new SchemaOpError(
        `${what} cannot convert the ${where} ${JSON.stringify(value)}: ${error.message}`,
      );
    }
  };
  if (Array.isArray(out["enum"]))
    out["enum"] = out["enum"].map((value) => each(value, "listed value"));
  if (out["const"] !== undefined) out["const"] = each(out["const"], "constant");
  if (out["default"] !== undefined) out["default"] = each(out["default"], "default");
  // Examples illustrate; they are not part of what either contract promises.
  delete out["example"];
  delete out["examples"];
}

/**
 * The instant keeps its meaning and changes its type: text with the
 * `date-time` format, or a whole number with none. Bounds of the old type say
 * nothing about the new one, so they go.
 */
function applyDateFormat(
  schema: JsonObject,
  codec: { from: TimeFormat; to: TimeFormat },
): JsonObject {
  if (codec.from === codec.to)
    throw new SchemaOpError(`dateFormat from ${codec.from} to itself changes nothing`);
  const types = declaredTypes(schema);
  if (types.length > 0 && !types.every((type) => TIME_TYPES[codec.from].includes(type))) {
    throw new SchemaOpError(
      `dateFormat reads ${codec.from}, but the schema holds ${types.join(" or ")}`,
    );
  }
  if (
    codec.from === "rfc3339" &&
    schema["format"] !== undefined &&
    schema["format"] !== "date-time"
  ) {
    throw new SchemaOpError(
      `dateFormat reads a date-time, but the schema's format is ${String(schema["format"])}`,
    );
  }
  const out = clone(schema);
  convertListed(out, "dateFormat", (value) => convertTime(value, codec.from, codec.to));
  if (codec.to === "rfc3339") {
    retyped(out, "string");
    out["format"] = "date-time";
    for (const bound of NUMERIC_BOUNDS) delete out[bound];
    delete out["multipleOf"];
  } else {
    retyped(out, "integer");
    if (out["format"] === "date-time") delete out["format"];
    for (const bound of STRING_BOUNDS) delete out[bound];
  }
  return out;
}

/**
 * The listed values are rewritten, so a closed set stays closed and every
 * member is proved to survive the round trip now, rather than refused one at
 * a time in production. A pattern describes the old spelling and is dropped;
 * one the new contract states is declared with `relax`.
 */
function applyStringCase(
  schema: JsonObject,
  codec: { from: StringCase; to: StringCase },
): JsonObject {
  if (codec.from === codec.to)
    throw new SchemaOpError(`stringCase from ${codec.from} to itself changes nothing`);
  const types = declaredTypes(schema);
  if (types.length > 0 && !types.every((type) => type === "string")) {
    throw new SchemaOpError(
      `stringCase rewrites text, but the schema holds ${types.join(" or ")}`,
    );
  }
  const out = clone(schema);
  convertListed(out, "stringCase", (value) => convertCase(value, codec.from, codec.to));
  delete out["pattern"];
  return out;
}

/** Words about the field, which belong to the field whether it holds one value or a list. */
const ANNOTATIONS = [
  "title",
  "description",
  "deprecated",
  "readOnly",
  "writeOnly",
] as const;

function isNullable(schema: JsonObject): boolean {
  return (
    schema["nullable"] === true ||
    (Array.isArray(schema["type"]) && schema["type"].includes("null"))
  );
}

/** The schema with any null taken out of it, in whichever way it was written. */
function withoutNull(schema: JsonObject): JsonObject {
  const out = clone(schema);
  delete out["nullable"];
  if (Array.isArray(out["type"])) {
    const rest = out["type"].filter((type) => type !== "null");
    out["type"] = rest.length === 1 ? (rest[0] as JsonValue) : rest;
  }
  return out;
}

/**
 * The field holds a list of what it held. Null passes through the runtime as
 * it is, so a field that could be null is a list that can be null, not a list
 * of values that can be.
 */
function applyWrapArray(schema: JsonObject): JsonObject {
  const nullable = isNullable(schema);
  const items = withoutNull(schema);
  const out: JsonObject = {};
  for (const key of ANNOTATIONS) {
    if (items[key] !== undefined) {
      out[key] = items[key] as JsonValue;
      delete items[key];
    }
  }
  delete items["default"];
  out["type"] = nullable ? ["array", "null"] : "array";
  out["items"] = items;
  return out;
}

function applyUnwrapSingle(schema: JsonObject): JsonObject {
  const types = declaredTypes(schema);
  const items = schema["items"];
  if ((types.length > 0 && !types.includes("array")) || !isJsonObject(items)) {
    throw new SchemaOpError("unwrapSingle needs a list whose items are described");
  }
  const out = clone(items);
  for (const key of ANNOTATIONS) {
    if (schema[key] !== undefined) out[key] = clone(schema[key] as JsonValue);
  }
  if (isNullable(schema) && !isNullable(out)) {
    const type = out["type"];
    if (typeof type === "string") out["type"] = [type, "null"];
    else out["nullable"] = true;
  }
  return out;
}

export function applyCodecToSchema(schema: JsonValue, codec: Codec): JsonValue {
  if (!isJsonObject(schema)) {
    throw new SchemaOpError("A codec needs a schema object to apply to");
  }
  switch (codec.kind) {
    case "scale10":
      return applyScale10(schema, codec.exponent);
    case "enumMap":
      return applyEnumMap(schema, codec.pairs, codec.fold);
    case "cast":
      return applyCast(schema, codec);
    case "dateFormat":
      return applyDateFormat(schema, codec);
    case "stringCase":
      return applyStringCase(schema, codec);
    case "wrapArray":
      return applyWrapArray(schema);
    case "unwrapSingle":
      return applyUnwrapSingle(schema);
  }
}

/**
 * The codec applies to what the field is, not to how it is written down, so it
 * is applied to the resolved schema and the result kept as this field's own.
 */
export function schemaConvert(
  document: OpenApiDocument,
  root: JsonObject,
  path: string,
  codec: Codec,
): void {
  const segments = parsePointer(path);
  if (segments.length === 0) {
    // A scope that is itself a value, as a named enum is: its own values are
    // what is re-encoded, in place, for every use of it.
    if (codec.kind === "wrapArray") {
      throw new SchemaOpError(
        "Cannot wrap the scope itself in a list; wrap a field of it",
      );
    }
    const own = ownRoot(document, root);
    const converted = applyCodecToSchema(resolveSchema(document, own), codec);
    for (const key of Object.keys(own)) delete own[key];
    Object.assign(own, isJsonObject(converted) ? converted : {});
    return;
  }
  const slot = readSlot(document, root, segments);
  // A list of a named schema stays a list of that name, rather than of a copy.
  const converted =
    codec.kind === "wrapArray"
      ? applyWrapArray(isJsonObject(slot.schema) ? slot.schema : {})
      : applyCodecToSchema(resolveSchema(document, slot.schema), codec);
  writeSlot(document, root, segments, converted, slot.required);
}

/**
 * `widen`: the union at `path` gains `variant` as a branch. What old callers
 * are shown in its place has to be something their contract allows, and that
 * is checked here, where the old union is still in hand: an id needs a branch
 * that is a string, null needs a union that allows null, and a field left out
 * needs a field that may be left out.
 */
export function schemaWiden(
  document: OpenApiDocument,
  root: JsonObject,
  path: string,
  variant: string,
  show: "id" | "absent" | "null",
): void {
  const segments = parsePointer(path);
  const slot = readSlot(document, root, segments);
  // A union behind a reference, as Intercom writes `event_details`, is made
  // this change's own first, so the branch is added to this use of it and
  // never to every other schema that shares the name.
  const union = own(
    document,
    WILDCARD_KEYWORD[slot.last] ? slot.parent : (slot.parent["properties"] as JsonObject),
    WILDCARD_KEYWORD[slot.last] ?? slot.last,
  );
  const key = Array.isArray(union["anyOf"])
    ? "anyOf"
    : Array.isArray(union["oneOf"])
      ? "oneOf"
      : undefined;
  if (!key) throw new SchemaOpError(`${path} is not a union`);
  const branches = union[key] as JsonValue[];
  if (branches.some((branch) => isJsonObject(branch) && branch["$ref"] === variant)) {
    throw new SchemaOpError(`${path} already holds ${variant}`);
  }
  const kinds = branches.map((branch) => jsonKindOf(document, branch));
  if (show === "id" && !kinds.includes("string")) {
    throw new SchemaOpError(
      `old callers cannot be shown an id at ${path}: no branch of the union is a string`,
    );
  }
  if (show === "null" && union["nullable"] !== true && !kinds.includes("null")) {
    throw new SchemaOpError(
      `old callers cannot be shown null at ${path}: it is never null`,
    );
  }
  if (show === "absent" && slot.required) {
    throw new SchemaOpError(
      `old callers cannot be sent ${path} left out: it is required`,
    );
  }
  union[key] = [...branches, { $ref: variant }];
}

/**
 * `relax`: the bounds at `path`, or on the scope itself where the path is
 * empty, as the new contract has them. Refused where old callers send the
 * schema and a bound narrows, because they would be refused for what their
 * contract allowed.
 */
export function schemaRelax(
  document: OpenApiDocument,
  root: JsonObject,
  path: string,
  set: Readonly<Record<string, JsonValue>>,
  sentByOldCallers: boolean,
): void {
  const segments = parsePointer(path);
  let node: JsonObject;
  if (segments.length === 0) {
    node = ownRoot(document, root);
  } else {
    const { parent, last } = parentFor(document, root, segments, false);
    const keyword = WILDCARD_KEYWORD[last];
    if (keyword) {
      node = own(document, parent, keyword);
    } else {
      const properties = parent["properties"];
      if (!isJsonObject(properties) || properties[last] === undefined) {
        throw new SchemaOpError(`Nothing to read at "${segments.join("/")}"`);
      }
      node = own(document, properties, last);
    }
  }
  for (const [keyword, value] of Object.entries(set)) {
    // A value old callers never heard of has to be shown to them as one they
    // know, which is a fold; passing it through would hide it in a relax.
    if (keyword === "enum" && vocabularyGrows(node[keyword], value)) {
      throw new SchemaOpError(
        `${path || "the body"} can now hold values old callers never heard of, which a fold decides; relax only takes values away`,
      );
    }
    if (sentByOldCallers && narrows(keyword, node[keyword], value)) {
      throw new SchemaOpError(
        `${path || "the body"} now allows less (${keyword}) and old callers send it, so they would be refused for what their contract allowed`,
      );
    }
    if (value === null) delete node[keyword];
    else node[keyword] = value;
  }
}

/**
 * `add` takes the field's shape from the new contract and supplies only the
 * default, which the specification cannot express. Nothing about the shape is
 * invented here.
 */
export function schemaAdd(
  document: OpenApiDocument,
  root: JsonObject,
  path: string,
  shape: JsonValue,
  required: boolean,
): void {
  writeSlot(document, root, parsePointer(path), clone(shape), required);
}

export function schemaRemove(
  document: OpenApiDocument,
  root: JsonObject,
  path: string,
): void {
  const segments = parsePointer(path);
  readSlot(document, root, segments);
  deleteSlot(document, root, segments);
  pruneEmptyObjects(document, root, segments);
}

/**
 * Whether a field must be present, changed where it is declared.
 *
 * Only the parent's `required` list changes; the field's own schema is left
 * alone, so a schema shared through a reference is never touched by a change
 * that is about one place it is used.
 */
export function schemaSetRequired(
  document: OpenApiDocument,
  root: JsonObject,
  path: string,
  required: boolean,
): void {
  const segments = parsePointer(path);
  const slot = readSlot(document, root, segments);
  if (WILDCARD_KEYWORD[slot.last]) {
    throw new SchemaOpError("A list item or a map value is not optional");
  }
  setRequired(slot.parent, slot.last, required);
}

/** Whether a field must be present, read through references on the way. */
export function schemaRequiredAt(
  document: OpenApiDocument,
  root: JsonObject,
  path: string,
): boolean {
  return readSlot(document, root, parsePointer(path)).required;
}

/** The field's own schema, made this change's own so it can be edited. */
function ownSlot(
  document: OpenApiDocument,
  root: JsonObject,
  segments: readonly string[],
): JsonObject {
  const slot = readSlot(document, root, segments);
  const wildcard = WILDCARD_KEYWORD[slot.last];
  if (wildcard) return own(document, slot.parent, wildcard);
  return own(document, slot.parent["properties"] as JsonObject, slot.last);
}

const isNullSchema = (branch: JsonValue): boolean =>
  isJsonObject(branch) && branch["type"] === "null" && Object.keys(branch).length === 1;

/**
 * Whether a field may be null, written the way the document's own version
 * writes it: `nullable` in 3.0, a `"null"` type in 3.1. Written the other way,
 * the prediction would mean the same thing and still differ from the real
 * specification, and closure would report a change nobody made.
 */
export function schemaSetNullable(
  document: OpenApiDocument,
  root: JsonObject,
  path: string,
  nullable: boolean,
): void {
  setNullable(document, ownSlot(document, root, parsePointer(path)), nullable, path);
}

/** The same, on a schema object this change already owns, such as a parameter's. */
export function setNullable(
  document: OpenApiDocument,
  schema: JsonObject,
  nullable: boolean,
  label: string,
): void {
  const version = document["openapi"];
  if (typeof version === "string" && version.startsWith("3.0")) {
    if (nullable) schema["nullable"] = true;
    else delete schema["nullable"];
    return;
  }

  const declared = schema["type"];
  if (typeof declared === "string" || Array.isArray(declared)) {
    const types = (Array.isArray(declared) ? declared : [declared]).filter(
      (type) => type !== "null",
    );
    const next = nullable ? [...types, "null"] : types;
    schema["type"] = next.length === 1 ? (next[0] as JsonValue) : next;
    return;
  }
  // A union spells null as a branch of its own.
  for (const key of ["anyOf", "oneOf"]) {
    const branches = schema[key];
    if (!Array.isArray(branches)) continue;
    const rest = branches.filter((branch) => !isNullSchema(branch));
    schema[key] = nullable ? [...rest, { type: "null" }] : rest;
    return;
  }
  throw new SchemaOpError(
    `"${label}" declares no type, so there is no way to write whether it may be null`,
  );
}

export function schemaSlotRequired(root: JsonValue, path: string): boolean {
  const segments = parsePointer(path);
  if (segments.length === 0 || !isJsonObject(root)) return false;
  const parent = schemaGet(root, segments.slice(0, -1));
  if (!isJsonObject(parent)) return false;
  return isRequired(parent, segments[segments.length - 1] as string);
}
