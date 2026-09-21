/**
 * Applying ops to a JSON Schema rather than to data.
 *
 * This is what makes the closure check possible: if the declared Changes are a
 * complete account of what the provider did, then replaying them over the old
 * specification has to reproduce the new one. Anything left over is a change
 * nobody explained.
 */
import { compareDecimal, numberToDecimalText, shiftDecimal } from "@invariant/decimal";
import {
  type Codec,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  parsePointer,
  type ScalarType,
} from "@invariant/ir";

export class SchemaOpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaOpError";
  }
}

function clone<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

/** A schema navigation step: an object property, or every element of an array. */
function childOf(schema: JsonObject, segment: string): JsonValue | undefined {
  if (segment === "*") return schema["items"];
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
 * Walks to a parent container, creating intermediate object schemas as needed.
 * A `$ref` in the path is inlined on write so a shared schema is never mutated
 * by a change that targets one use of it.
 */
function parentFor(
  root: JsonObject,
  segments: readonly string[],
  create: boolean,
): { parent: JsonObject; last: string } {
  if (segments.length === 0) throw new SchemaOpError("Cannot target the schema root");

  let current = root;
  for (const segment of segments.slice(0, -1)) {
    if (current["$ref"] !== undefined) {
      throw new SchemaOpError(
        `Cannot write through a $ref at "${segment}"; scope the change to that schema instead`,
      );
    }
    if (segment === "*") {
      const items = current["items"];
      if (!isJsonObject(items))
        throw new SchemaOpError("Cannot walk into a non-object items");
      current = items;
      continue;
    }
    let properties = current["properties"];
    if (!isJsonObject(properties)) {
      if (!create) throw new SchemaOpError(`No properties at "${segment}"`);
      properties = {};
      current["properties"] = properties;
      current["type"] = "object";
    }
    let next = (properties as JsonObject)[segment];
    if (next === undefined) {
      if (!create) throw new SchemaOpError(`No property "${segment}"`);
      next = { type: "object", properties: {} };
      (properties as JsonObject)[segment] = next;
    }
    if (!isJsonObject(next))
      throw new SchemaOpError(`Property "${segment}" is not a schema`);
    current = next;
  }

  return { parent: current, last: segments[segments.length - 1] as string };
}

function readSlot(
  root: JsonObject,
  segments: readonly string[],
): { parent: JsonObject; last: string; schema: JsonValue; required: boolean } {
  const { parent, last } = parentFor(root, segments, false);
  const schema =
    last === "*"
      ? parent["items"]
      : (parent["properties"] as JsonObject | undefined)?.[last];
  if (schema === undefined) {
    throw new SchemaOpError(`Nothing to read at "${segments.join("/")}"`);
  }
  return { parent, last, schema, required: last !== "*" && isRequired(parent, last) };
}

function deleteSlot(root: JsonObject, segments: readonly string[]): void {
  const { parent, last } = parentFor(root, segments, false);
  if (last === "*") {
    delete parent["items"];
    return;
  }
  const properties = parent["properties"];
  if (isJsonObject(properties)) delete properties[last];
  setRequired(parent, last, false);
}

function writeSlot(
  root: JsonObject,
  segments: readonly string[],
  schema: JsonValue,
  required: boolean,
): void {
  const { parent, last } = parentFor(root, segments, true);
  if (last === "*") {
    parent["items"] = schema;
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
    const grand = parentFor(root, ancestorPath, false);
    const name = ancestorPath[ancestorPath.length - 1] as string;
    if (name === "*") continue;
    if (required && !isRequired(grand.parent, name))
      setRequired(grand.parent, name, true);
  }
}

export function schemaMove(root: JsonObject, from: string, to: string): void {
  const fromSegments = parsePointer(from);
  const toSegments = parsePointer(to);
  const slot = readSlot(root, fromSegments);
  const moved = clone(slot.schema);
  deleteSlot(root, fromSegments);
  writeSlot(root, toSegments, moved, slot.required);
  pruneEmptyObjects(root, fromSegments);
}

/** Drops intermediate objects a move emptied out. */
function pruneEmptyObjects(root: JsonObject, segments: readonly string[]): void {
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
    deleteSlot(root, path);
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
  }
}

export function schemaConvert(root: JsonObject, path: string, codec: Codec): void {
  const segments = parsePointer(path);
  const slot = readSlot(root, segments);
  writeSlot(root, segments, applyCodecToSchema(slot.schema, codec), slot.required);
}

/**
 * `add` takes the field's shape from the new contract and supplies only the
 * default, which the specification cannot express. Nothing about the shape is
 * invented here.
 */
export function schemaAdd(
  root: JsonObject,
  path: string,
  shape: JsonValue,
  required: boolean,
): void {
  writeSlot(root, parsePointer(path), clone(shape), required);
}

export function schemaRemove(root: JsonObject, path: string): void {
  const segments = parsePointer(path);
  readSlot(root, segments);
  deleteSlot(root, segments);
  pruneEmptyObjects(root, segments);
}

export function schemaSlotRequired(root: JsonValue, path: string): boolean {
  const segments = parsePointer(path);
  if (segments.length === 0 || !isJsonObject(root)) return false;
  const parent = schemaGet(root, segments.slice(0, -1));
  if (!isJsonObject(parent)) return false;
  return isRequired(parent, segments[segments.length - 1] as string);
}
