/**
 * Enumerating what actually changed, before anyone interprets it.
 *
 * A judge is never asked an open question. It is asked to choose among fields
 * that deterministic code already found, in a schema deterministic code already
 * matched. That is what keeps a wrong answer cheap: the worst it can produce is
 * a draft naming the wrong one of a handful of real fields, which the closure
 * check and a human reviewer then reject.
 */
import {
  type OpenApiDocument,
  operationsOf,
  requestBodySchema,
  resolveSchema,
  responseSchemas,
  schemaDirections,
  schemasOf,
} from "@invariant-app/contract";
import {
  CONSTRAINT_KEYWORDS,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type Scope,
} from "@invariant-app/ir";

export interface FieldShape {
  name: string;
  /**
   * JSON Pointer within the schema. Nested inline objects are followed, and
   * array items appear as `*`; a property that refers to another named
   * schema is not, because that schema has a delta of its own.
   */
  pointer: string;
  type: string | undefined;
  format: string | undefined;
  enumValues: string[] | undefined;
  /**
   * The enum lists null beside its text values, which is how an OpenAPI 3.0
   * field that is `nullable` says null is one of the values it may hold.
   */
  enumNull?: true;
  description: string | undefined;
  required: boolean;
  nullable: boolean;
  /** The schema's own `default`, when it declares one. */
  default?: JsonValue;
  /** Declared `readOnly`: it appears in responses and never in requests. */
  readOnly?: boolean;
  /** For a union, the named schemas it can hold, as references. */
  variants?: string[];
  /**
   * The field holds only the values of an enum that `enumValues` does not
   * list: a named schema's, compared under that name, or one whose values are
   * not all text. Either way it is not a field that allows any value.
   */
  unlistedValues?: true;
  /** For a union, whether one of its branches is a plain string, as an id is. */
  idBranch?: boolean;
  /** The bounds the schema puts on the value, by keyword. */
  bounds?: Record<string, JsonValue>;
  /** The named schema the field refers to, when it is one. */
  ref?: string;
  /** For a list: what each item is, by type and by name when it has one. */
  items?: { type: string | undefined; ref?: string };
}

/** The first non-null type a schema declares. */
function typeOf(value: JsonObject): string | undefined {
  const declared = value["type"];
  const types = Array.isArray(declared)
    ? declared.filter((t): t is string => typeof t === "string")
    : typeof declared === "string"
      ? [declared]
      : [];
  return types.filter((t) => t !== "null")[0];
}

function resolvedObject(
  document: Parameters<typeof resolveSchema>[0],
  raw: JsonValue,
): JsonObject {
  const resolved = resolveSchema(document, raw);
  return isJsonObject(resolved) ? resolved : {};
}

function refOf(raw: JsonValue | undefined): Pick<FieldShape, "ref"> {
  if (!isJsonObject(raw)) return {};
  if (typeof raw["$ref"] === "string") return { ref: raw["$ref"] };
  // The schema a field names beside null is the schema it names.
  const lone = besideNull(raw)?.only;
  return isJsonObject(lone) && typeof lone["$ref"] === "string"
    ? { ref: lone["$ref"] }
    : {};
}

/** The keywords of a schema that bound its value, where it has any. */
function boundsOf(value: JsonObject): Pick<FieldShape, "bounds"> {
  const bounds: Record<string, JsonValue> = {};
  for (const keyword of CONSTRAINT_KEYWORDS) {
    const bound = value[keyword];
    if (bound !== undefined) bounds[keyword] = bound;
  }
  return Object.keys(bounds).length > 0 ? { bounds } : {};
}

/** The named schemas a union can hold, and whether it can also be a string. */
function unionOf(value: JsonObject): Pick<FieldShape, "variants" | "idBranch"> {
  const branches = (value["anyOf"] ?? value["oneOf"]) as JsonValue[] | undefined;
  if (!Array.isArray(branches)) return {};
  const variants = branches.flatMap((branch) =>
    isJsonObject(branch) && typeof branch["$ref"] === "string" ? [branch["$ref"]] : [],
  );
  if (variants.length === 0) return {};
  return {
    variants,
    idBranch: branches.some(
      (branch) => isJsonObject(branch) && branch["type"] === "string",
    ),
  };
}

export interface SchemaDelta {
  /** Schema name in the old contract. */
  schema: string;
  /** The matching schema in the new contract, which may be named differently. */
  newSchema: string;
  removed: FieldShape[];
  added: FieldShape[];
  /** Fields present in both whose declared shape differs. */
  altered: { old: FieldShape; new: FieldShape }[];
  /** Where this schema reaches the wire, for context. */
  operations: string[];
  /**
   * What a Change about this delta is scoped to, when it is not the named
   * schema: an operation's request body declared inline has no name, so the
   * operation is the scope.
   */
  scope?: Scope;
  /** Which way it travels, when that is known without scanning for sites. */
  sides?: { request: boolean; response: boolean };
  /**
   * Most of its fields gone and others in their place: a different schema
   * under the old name, so nothing in it is drafted as dropped.
   */
  replaced?: true;
  /**
   * Fields that moved together out of a wrapper object or into a new one,
   * each the same field in a new place. Not in `removed` or `added`.
   */
  regrouped?: Regrouped[];
}

/**
 * One field that moved with its siblings out of a wrapper (`hoisted`: every
 * field of `P/w` is now at `P`) or into a new one (`nested`: fields of `P`
 * are now inside `P/w`). `wrapper` is that object's pointer on the side where
 * it exists: the old side for a hoist, the new side for a nest.
 */
export interface Regrouped {
  old: FieldShape;
  new: FieldShape;
  wrapper: string;
  kind: "hoisted" | "nested";
}

/** How far below the schema's own properties nested inline objects are followed. */
const NESTING = 3;

const escapePointer = (segment: string) =>
  segment.replaceAll("~", "~0").replaceAll("/", "~1");

/**
 * Whether a property is written inline rather than as a reference to another
 * named schema. A referenced schema is compared as itself, under its own name,
 * and following it from here too would draft every Change to it twice.
 */
const inline = (raw: JsonValue): boolean => !JSON.stringify(raw).includes('"$ref"');

/** Keywords that describe a schema without constraining its values. */
const ANNOTATIONS = new Set([
  "title",
  "description",
  "example",
  "examples",
  "deprecated",
]);

/**
 * A branch that holds only null: 3.1's `type: null`, or a branch that says
 * nothing but `nullable: true`, which is how schemars and utoipa write the
 * null half of an Option<T> in OpenAPI 3.0.
 */
const isNullBranch = (branch: JsonValue): boolean => {
  if (!isJsonObject(branch)) return false;
  const said = Object.keys(branch).filter((key) => !ANNOTATIONS.has(key));
  return said.length === 1 && (branch["type"] === "null" || branch["nullable"] === true);
};

/** The one branch of a union with null that is not null, when there is one. */
function besideNull(
  value: JsonObject,
): { key: "anyOf" | "oneOf"; only: JsonValue } | undefined {
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = value[key];
    if (!Array.isArray(branches) || !branches.some(isNullBranch)) continue;
    const others = branches.filter((branch) => !isNullBranch(branch));
    const [only] = others;
    return others.length === 1 && only !== undefined ? { key, only } : undefined;
  }
  return undefined;
}

/**
 * A field that may also be null, written as a union of its value and null, as
 * Mistral's `tools` became `anyOf: [array, null]`: the field is its value.
 * Read as a union instead, its list items looked removed, and a `remove` was
 * drafted for items the compiler could not find. A branch that names another
 * schema is read as that schema, as a field that names it directly is:
 * Qdrant's telemetry turned `app: AppBuildTelemetry` into `anyOf:
 * [AppBuildTelemetry, nullable]`, and read as a union it looked like a change
 * of shape no op expresses rather than the field becoming nullable.
 */
function throughNull(document: OpenApiDocument, value: JsonObject): JsonObject {
  const lone = besideNull(value);
  if (!lone || !isJsonObject(lone.only)) return value;
  const resolved = resolveSchema(document, lone.only);
  if (!isJsonObject(resolved)) return value;
  const { [lone.key]: _union, ...rest } = value;
  return { ...resolved, ...rest };
}

function fieldsOf(
  document: OpenApiDocument,
  schema: JsonValue,
  prefix: { name: string; pointer: string } = { name: "", pointer: "" },
  depth = 0,
): FieldShape[] {
  // The same view the differ compares and the compiler writes: references
  // followed and `allOf` merged, so a field reported as changed is a field
  // this can see and the compiler can then reach.
  const resolved = resolveSchema(document, schema);
  if (!isJsonObject(resolved)) return [];
  const properties = resolved["properties"];
  if (!isJsonObject(properties)) return [];

  const required = Array.isArray(resolved["required"])
    ? new Set(
        (resolved["required"] as JsonValue[]).filter(
          (entry): entry is string => typeof entry === "string",
        ),
      )
    : new Set<string>();

  return Object.entries(properties).flatMap(([name, raw]) => {
    const child = resolveSchema(document, raw);
    const outer: JsonObject = isJsonObject(child) ? child : {};
    const value = throughNull(document, outer);
    const declared = value["type"];
    const types = Array.isArray(declared)
      ? declared.filter((t): t is string => typeof t === "string")
      : typeof declared === "string"
        ? [declared]
        : [];
    // Only a vocabulary of strings can be mapped by an `enumMap`. Filtering
    // the rest out used to turn `[true, false]` into an empty vocabulary, which
    // then drafted a mapping with no pairs that no compiler could apply.
    // `const: x` is JSON Schema's other spelling of `enum: [x]`, which Mistral
    // switched to for every single value in one release.
    const declaredEnum =
      value["enum"] ??
      (value["const"] !== undefined ? [value["const"] as JsonValue] : undefined);
    // A vocabulary that belongs to a named schema is compared as that schema,
    // at its root, once for every place it is used; read again through each
    // field that refers to it, one change was asked about twice.
    const elsewhere = !inline(raw) && Array.isArray(declaredEnum);
    // Null listed among text values is the field saying it may be null, as
    // OpenAPI 3.0 asks a `nullable` enum to; the vocabulary is still text.
    const enumValues =
      !elsewhere &&
      Array.isArray(declaredEnum) &&
      (declaredEnum as JsonValue[]).every((v) => typeof v === "string" || v === null)
        ? (declaredEnum as JsonValue[]).filter((v): v is string => typeof v === "string")
        : undefined;
    const enumNull =
      enumValues !== undefined && (declaredEnum as JsonValue[]).includes(null);

    const here = {
      name: prefix.name === "" ? name : `${prefix.name}.${name}`,
      pointer: `${prefix.pointer}/${escapePointer(name)}`,
    };
    const field: FieldShape = {
      name: here.name,
      pointer: here.pointer,
      type: types.filter((t) => t !== "null")[0],
      format: typeof value["format"] === "string" ? value["format"] : undefined,
      enumValues,
      ...(enumNull ? { enumNull: true as const } : {}),
      description:
        typeof value["description"] === "string" ? value["description"] : undefined,
      required: required.has(name),
      ...(Array.isArray(declaredEnum) && enumValues === undefined
        ? { unlistedValues: true }
        : {}),
      // Each way a document can say it: 3.1's type list, 3.0's flag, or a
      // union with a null branch.
      nullable:
        types.includes("null") ||
        value["nullable"] === true ||
        enumNull ||
        ["anyOf", "oneOf"].some(
          (key) =>
            Array.isArray(outer[key]) && (outer[key] as JsonValue[]).some(isNullBranch),
        ),
      ...(value["default"] === undefined ? {} : { default: value["default"] }),
      ...(value["readOnly"] === true ? { readOnly: true } : {}),
      ...unionOf(value),
      ...boundsOf(value),
      ...refOf(raw),
      ...(isJsonObject(value["items"])
        ? {
            items: {
              type: typeOf(resolvedObject(document, value["items"])),
              ...refOf(value["items"]),
            },
          }
        : {}),
    };

    // Inline objects, and inline objects inside lists, are part of this
    // schema: most real changes happen a level or two down.
    const items = isJsonObject(value["items"]) ? value["items"] : undefined;
    // A list of a union, as Stripe's `discounts` are: each item is the field.
    // The union may be written in place or named, as Figma names the effects
    // a node can hold; a name is followed, since what the item may be is the
    // same either way.
    const itemChoice = items
      ? throughNull(document, resolvedObject(document, items))
      : undefined;
    const itemUnion = itemChoice ? unionOf(itemChoice) : {};
    // The item is a field of this schema whenever it is a choice at all, even
    // one whose branches are written out instead of named, as Langfuse writes
    // out the ten shapes an evaluation-rule filter could take. A side that
    // writes them out has no variants to record, and if that left the field
    // out altogether the other side's would read as newly added, which is not
    // a thing an adapter can serve.
    const listed: FieldShape[] =
      itemChoice === undefined ||
      (itemUnion.variants === undefined && !isUnion(document, itemChoice))
        ? []
        : [
            {
              ...field,
              name: `${here.name}.*`,
              pointer: `${here.pointer}/*`,
              type: undefined,
              enumValues: undefined,
              required: true,
              nullable: false,
              ...itemUnion,
            },
          ];
    // A list of named values, as Stripe's `payment_method_types`: each item
    // is a field with that vocabulary, so a value the list gains is asked
    // about like any other vocabulary's. A named enum is compared once, as
    // its own schema, wherever it is listed.
    const itemSchema = items ? resolvedObject(document, items) : undefined;
    const itemEnum = itemSchema?.["enum"];
    if (
      items &&
      itemSchema &&
      inline(items) &&
      Array.isArray(itemEnum) &&
      itemEnum.length > 0 &&
      (itemEnum as JsonValue[]).every((v) => typeof v === "string" || v === null)
    ) {
      const itemNull = (itemEnum as JsonValue[]).includes(null);
      listed.push({
        name: `${here.name}.*`,
        pointer: `${here.pointer}/*`,
        type: typeOf(itemSchema),
        format:
          typeof itemSchema["format"] === "string" ? itemSchema["format"] : undefined,
        enumValues: (itemEnum as JsonValue[]).filter(
          (v): v is string => typeof v === "string",
        ),
        ...(itemNull ? { enumNull: true as const } : {}),
        description: undefined,
        required: true,
        nullable: itemNull || itemSchema["nullable"] === true,
      });
    }
    if (depth >= NESTING || !inline(raw)) return [field, ...listed];
    const mapValues = isJsonObject(value["additionalProperties"])
      ? (value["additionalProperties"] as JsonObject)
      : undefined;
    const nested = isJsonObject(value["properties"])
      ? fieldsOf(document, value, here, depth + 1)
      : items && isJsonObject(resolveSchema(document, items))
        ? fieldsOf(
            document,
            items,
            { name: `${here.name}.*`, pointer: `${here.pointer}/*` },
            depth + 1,
          )
        : mapValues && inline(mapValues)
          ? // A map: every value, whatever its key, has these fields.
            fieldsOf(
              document,
              mapValues,
              { name: `${here.name}.{}`, pointer: `${here.pointer}/{}` },
              depth + 1,
            )
          : [];
    return [field, ...listed, ...nested];
  });
}

/** Where each schema is used, so a judge can be told what the field is part of. */
function operationsUsing(document: OpenApiDocument): Map<string, string[]> {
  const byRef = new Map<string, string[]>();
  const note = (
    schema: JsonValue | undefined,
    operationId: string,
    where: string,
  ): void => {
    if (!isJsonObject(schema)) return;
    const ref = schema["$ref"];
    if (typeof ref !== "string") return;
    const name = ref.slice(ref.lastIndexOf("/") + 1);
    byRef.set(name, [...(byRef.get(name) ?? []), `${operationId} ${where}`]);
  };

  for (const { operationId, method, path, operation } of operationsOf(document)) {
    note(
      requestBodySchema(document, operation),
      operationId,
      `request (${method.toUpperCase()} ${path})`,
    );
    for (const { status, schema } of responseSchemas(document, operation)) {
      note(schema, operationId, `response ${status}`);
    }
  }
  return byRef;
}

const segmentsOfPointer = (pointer: string): string[] =>
  pointer === "" ? [] : pointer.split("/").slice(1);
const pointerOf = (segments: readonly string[]): string =>
  segments.length === 0 ? "" : `/${segments.join("/")}`;
const isWildcardSegment = (segment: string | undefined) =>
  segment === "*" || segment === "{}";

/**
 * Fields that moved together out of a wrapper object, or into a new one.
 *
 * Datadog flattened a custom rule's revision: it had been a resource with a
 * `type` and an `attributes` object holding twenty fields, and became those
 * twenty fields directly. Read one field at a time that is twenty fields
 * removed and twenty unrelated fields added, which no judge is asked to pair
 * and which left forty-odd places unexplained in one release. It is twenty
 * moves, and the IR has always had `move`.
 *
 * Read strictly, so a coincidental name is never mistaken for a restructure:
 * each pair keeps its path apart from the one wrapper segment, keeps its type,
 * and moves with at least one sibling through the same wrapper; the wrapper is
 * gone on the side it left, or new on the side it arrived; and a list's items
 * or a map's values are never the wrapper.
 */
function regroupedFields(
  before: readonly FieldShape[],
  after: readonly FieldShape[],
  beforeAt: ReadonlyMap<string, FieldShape>,
  afterAt: ReadonlyMap<string, FieldShape>,
): Regrouped[] {
  const groups = new Map<string, Regrouped[]>();
  const offer = (candidate: Regrouped) => {
    const key = `${candidate.kind} ${candidate.wrapper}`;
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  };
  const item = (field: FieldShape) => field.pointer.endsWith("/*");
  for (const old of before) {
    if (afterAt.has(old.pointer) || item(old)) continue;
    const segments = segmentsOfPointer(old.pointer);
    for (let at = 0; at < segments.length - 1; at += 1) {
      if (isWildcardSegment(segments[at])) continue;
      const wrapper = pointerOf(segments.slice(0, at + 1));
      const moved = afterAt.get(
        pointerOf([...segments.slice(0, at), ...segments.slice(at + 1)]),
      );
      if (
        moved &&
        !beforeAt.has(moved.pointer) &&
        !afterAt.has(wrapper) &&
        moved.type === old.type
      ) {
        offer({ old, new: moved, wrapper, kind: "hoisted" });
      }
    }
  }
  for (const next of after) {
    if (beforeAt.has(next.pointer) || item(next)) continue;
    const segments = segmentsOfPointer(next.pointer);
    for (let at = 0; at < segments.length - 1; at += 1) {
      if (isWildcardSegment(segments[at])) continue;
      const wrapper = pointerOf(segments.slice(0, at + 1));
      const old = beforeAt.get(
        pointerOf([...segments.slice(0, at), ...segments.slice(at + 1)]),
      );
      if (
        old &&
        !afterAt.has(old.pointer) &&
        !beforeAt.has(wrapper) &&
        old.type === next.type
      ) {
        offer({ old, new: next, wrapper, kind: "nested" });
      }
    }
  }

  // Largest groups first, and each field in at most one move.
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  const chosen: Regrouped[] = [];
  for (const group of [...groups.values()].sort((a, b) => b.length - a.length)) {
    const free = group.filter(
      (pair) => !usedOld.has(pair.old.pointer) && !usedNew.has(pair.new.pointer),
    );
    if (free.length < 2) continue;
    for (const pair of free) {
      usedOld.add(pair.old.pointer);
      usedNew.add(pair.new.pointer);
      chosen.push(pair);
    }
  }
  // A field inside a moved object goes with it; its own move would act on
  // something the outer one already carried away.
  return chosen.filter(
    (pair) =>
      !chosen.some(
        (other) => other !== pair && pair.old.pointer.startsWith(`${other.old.pointer}/`),
      ),
  );
}

/** The fields that went, arrived and changed shape, or nothing when none did. */
function compare(
  before: FieldShape[],
  after: FieldShape[],
):
  | Pick<SchemaDelta, "removed" | "added" | "altered" | "replaced" | "regrouped">
  | undefined {
  // Keyed by pointer, which is what identifies a field; a nested name is
  // only for reading.
  const afterAt = new Map(after.map((field) => [field.pointer, field]));
  const beforeAt = new Map(before.map((field) => [field.pointer, field]));
  // Fields that moved with their siblings through one wrapper are moves, and
  // neither they, what they hold, nor the wrapper they left or arrived in is
  // a field removed or added.
  const regrouped = regroupedFields(before, after, beforeAt, afterAt);
  const under = (pointer: string, roots: readonly string[]) =>
    roots.some((root) => pointer === root || pointer.startsWith(`${root}/`));
  const movedFrom = regrouped.map((pair) => pair.old.pointer);
  const movedTo = regrouped.map((pair) => pair.new.pointer);
  const left = new Set(
    regrouped.filter((pair) => pair.kind === "hoisted").map((pair) => pair.wrapper),
  );
  const arrived = new Set(
    regrouped.filter((pair) => pair.kind === "nested").map((pair) => pair.wrapper),
  );
  // A field that went with the object holding it went because the object
  // did, and the op for the object says so; one of its own would then act on
  // something already gone. PayPal removed `office_bearers` and every field
  // inside it, and each inner removal was a draft that could not compile.
  const outermost = (fields: FieldShape[]) => {
    const pointers = fields.map((field) => field.pointer);
    return fields.filter(
      (field) => !pointers.some((other) => field.pointer.startsWith(`${other}/`)),
    );
  };
  // The items of a list are compared with the items of that list or not at
  // all. Nothing adds or removes an item the way it adds or removes a field:
  // a list whose items became a choice, or became an enum, still holds the
  // items it held, and drafting their addition asks the compiler for a place
  // in the new contract that a list has no name for.
  const item = (field: FieldShape) => field.pointer.endsWith("/*");
  // A schema's own value is compared with itself or not at all: a named
  // schema that became a scalar did not gain a field at its root.
  const removed = outermost(
    before.filter(
      (field) =>
        field.pointer !== "" &&
        !item(field) &&
        !afterAt.has(field.pointer) &&
        !under(field.pointer, movedFrom) &&
        !left.has(field.pointer),
    ),
  );
  const added = outermost(
    after.filter(
      (field) =>
        field.pointer !== "" &&
        !item(field) &&
        !beforeAt.has(field.pointer) &&
        !under(field.pointer, movedTo) &&
        !arrived.has(field.pointer),
    ),
  );
  const altered = before
    .filter((field) => afterAt.has(field.pointer))
    .map((field) => ({ old: field, new: afterAt.get(field.pointer) as FieldShape }))
    .filter((pair) => shapeDiffers(pair.old, pair.new));
  if (
    removed.length === 0 &&
    added.length === 0 &&
    altered.length === 0 &&
    regrouped.length === 0
  )
    return undefined;
  // Most of what it held gone, and other things in their place: another
  // schema under the same name, as PayPal's `payout_item` went from the item
  // a caller sends to the item a response reports. Its fields were not
  // dropped, they belong to a schema that now has another name.
  const top = (fields: FieldShape[]) =>
    fields.filter((field) => field.pointer.split("/").length === 2);
  const held = top(before);
  const kept = held.filter((field) => afterAt.has(field.pointer));
  const replaced =
    held.length >= 3 && kept.length * 2 < held.length && top(added).length > 0;
  return {
    removed,
    added,
    altered,
    ...(regrouped.length > 0 ? { regrouped } : {}),
    ...(replaced ? { replaced: true as const } : {}),
  };
}

/**
 * A named schema's fields, and the schema's own value where it is a scalar
 * with a vocabulary. Qdrant's `Memory` is a string enum used in a dozen
 * places; it gained `cached`, and with only object properties compared that
 * was never seen at all, so no decision was asked and every use of it stayed
 * unexplained. The value itself is the field at the schema's root.
 */
function shapeOf(
  document: OpenApiDocument,
  schema: JsonValue,
  name: string,
): FieldShape[] {
  const resolved = resolveSchema(document, schema);
  if (!isJsonObject(resolved)) return [];
  const declared = resolved["type"];
  const types = Array.isArray(declared) ? declared : [declared];
  const type = types.find((entry) => entry !== "null");
  const values = resolved["enum"];
  if (
    (type === "string" || type === "integer" || type === "number") &&
    Array.isArray(values) &&
    values.every((value) => typeof value === "string" || value === null)
  ) {
    return [
      {
        name,
        pointer: "",
        type,
        format: typeof resolved["format"] === "string" ? resolved["format"] : undefined,
        enumValues: values.filter((value): value is string => typeof value === "string"),
        ...(values.includes(null) ? { enumNull: true as const } : {}),
        description:
          typeof resolved["description"] === "string"
            ? resolved["description"]
            : undefined,
        required: true,
        nullable:
          types.includes("null") ||
          resolved["nullable"] === true ||
          values.includes(null),
      },
    ];
  }
  return fieldsOf(document, schema);
}

function shapeDiffers(a: FieldShape, b: FieldShape): boolean {
  if (
    a.type !== b.type ||
    a.format !== b.format ||
    a.required !== b.required ||
    a.nullable !== b.nullable
  )
    return true;
  const left = a.enumValues?.join("|");
  const right = b.enumValues?.join("|");
  if (left !== right || a.enumNull !== b.enumNull) return true;
  // Values listed in a named schema are compared there, but a field that
  // stopped referring to any list at all changed here.
  if (Boolean(a.unlistedValues) !== Boolean(b.unlistedValues)) return true;
  if (a.variants?.join("|") !== b.variants?.join("|")) return true;
  return JSON.stringify(a.bounds ?? {}) !== JSON.stringify(b.bounds ?? {});
}

/** Whether a schema is a choice between two or more others. */
function isUnion(document: OpenApiDocument, schema: JsonValue): boolean {
  const resolved = resolvedObject(document, schema);
  return ["oneOf", "anyOf"].some((keyword) => {
    const branches = resolved[keyword];
    return Array.isArray(branches) && branches.filter((b) => !isNullBranch(b)).length > 1;
  });
}

/**
 * Whether what a schema lost went into the variants it became a choice
 * between. Datadog's `TopologyMapWidgetDefinition` became a `oneOf` of a
 * data-streams and a service-map definition, each holding the fields it had:
 * none of them was dropped, and drafting their removal would take them from
 * every old caller. Okta's signing key request kept its `oneOf` and lost the
 * `allOf` base that held `kid` and `status`, which no variant has: those were
 * removed, and are drafted as removed.
 */
function movedIntoVariants(
  document: OpenApiDocument,
  schema: JsonValue,
  removed: readonly FieldShape[],
): boolean {
  if (removed.length === 0) return false;
  const resolved = resolvedObject(document, schema);
  const variants = ["oneOf", "anyOf"].flatMap((keyword) => {
    const branches = resolved[keyword];
    return Array.isArray(branches)
      ? branches.filter((branch) => !isNullBranch(branch))
      : [];
  });
  if (variants.length < 2) return false;
  const held = new Set(
    variants.flatMap((variant) =>
      fieldsOf(document, variant).map((field) => field.pointer),
    ),
  );
  return removed.every((field) => held.has(field.pointer));
}

/**
 * Whether a body that named a schema now names a different one that the new
 * contract also has under the old name. A name that is gone is a rename, and
 * is matched by where it is used; one that stayed is another schema, and what
 * this operation returns changed.
 */
function pointedElsewhere(
  document: OpenApiDocument,
  before: JsonObject,
  after: JsonValue,
  newSchemas: Record<string, JsonValue>,
): boolean {
  // A body that became a choice between schemas is not one schema to compare
  // this one with; what it holds now is the variants' to say.
  if (isUnion(document, after)) return false;
  const was = schemaName(before["$ref"] as string);
  const now =
    isJsonObject(after) && typeof after["$ref"] === "string"
      ? schemaName(after["$ref"])
      : undefined;
  return was !== undefined && now !== undefined && now !== was && was in newSchemas;
}

/**
 * `compare`, reading through a reference the new contract made where the old
 * one wrote an object in place, so the object is compared with what it
 * became rather than reported as gone.
 */
/**
 * A schema that states nothing at all: `{}` allows every value, so the old
 * description of it is one of the things it allows.
 */
function saysNothing(document: OpenApiDocument, schema: JsonValue): boolean {
  const resolved = resolveSchema(document, schema);
  if (!isJsonObject(resolved)) return false;
  return Object.keys(resolved).every((key) => DESCRIBES_NOTHING.has(key));
}

/** Keywords that say nothing about the value: documentation and examples. */
const DESCRIBES_NOTHING = new Set([
  "description",
  "title",
  "example",
  "examples",
  "deprecated",
  "externalDocs",
  "readOnly",
  "writeOnly",
]);

/**
 * What a body that stopped describing itself leaves an old caller: the
 * promise, not the values.
 *
 * Amazon replaced each of CloudDirectory's error schemas with `{}` between
 * two versions. An empty schema allows everything the old one did, so nothing
 * was removed and nothing became optional; what an old caller loses is being
 * told what it will be sent, which is a loss to declare, drafted here as the
 * type the schema no longer states.
 */
function stoppedDescribing(
  oldContract: OpenApiDocument,
  schema: JsonValue,
  name: string,
): ReturnType<typeof compare> {
  const resolved = resolveSchema(oldContract, schema);
  const declared = isJsonObject(resolved) ? resolved["type"] : undefined;
  const types = Array.isArray(declared) ? declared : [declared];
  const type = types.find((entry) => entry !== "null" && entry !== undefined);
  if (typeof type !== "string") return undefined;
  const root = {
    name,
    pointer: "",
    format: undefined,
    enumValues: undefined,
    description: undefined,
    required: true,
    nullable: false,
  };
  return {
    removed: [],
    added: [],
    altered: [{ old: { ...root, type }, new: { ...root, type: undefined } }],
  };
}

function compareReading(
  oldContract: OpenApiDocument,
  newContract: OpenApiDocument,
  oldSchemas: Record<string, JsonValue>,
  newSchemas: Record<string, JsonValue>,
  before: FieldShape[],
  after: FieldShape[],
  roots: { name: string; old: JsonValue; new: JsonValue },
): ReturnType<typeof compare> {
  const { name, old: oldRoot, new: newRoot } = roots;
  // A field pointed at another schema is read on both sides, so what differs
  // between the two is compared rather than passing unnoticed.
  const repointed = repointedFields(
    oldContract,
    newContract,
    oldSchemas,
    newSchemas,
    before,
    after,
  );
  const left = [...before, ...repointed.before];
  const right = [...after, ...repointed.after];
  if (saysNothing(newContract, newRoot) && !saysNothing(oldContract, oldRoot)) {
    return stoppedDescribing(oldContract, oldRoot, name);
  }
  const first = compare(left, right);
  const inlined =
    first && first.removed.length > 0
      ? referencesInPlace(
          newContract,
          right,
          first.removed.map((field) => field.pointer),
          newSchemas,
        )
      : [];
  const read = inlined.length > 0 ? [...right, ...inlined] : right;
  const compared = inlined.length > 0 ? compare(left, read) : first;
  if (!compared) return compared;
  const opened = wrappersOpened(
    oldContract,
    newContract,
    oldSchemas,
    newSchemas,
    compared,
  );
  if (opened.before.length === 0 && opened.after.length === 0) return compared;
  const regrouped = compare([...left, ...opened.before], [...read, ...opened.after]);
  return regrouped?.regrouped !== undefined ? regrouped : compared;
}

/**
 * What a wrapper that went, or arrived, holds, where it is a named schema.
 *
 * Datadog's custom rule revision kept twenty fields in `attributes`, a
 * reference to a schema of its own, and a later release listed those twenty
 * directly on the revision. A named schema is compared under its own name,
 * so the walk never lists what a referenced field holds, and the wrapper
 * looked removed with nothing in it to pair with the fields that arrived.
 * What it held is read here only to find fields that moved through it, and
 * kept only where some did: otherwise it is still one wrapper removed.
 */
function wrappersOpened(
  oldContract: OpenApiDocument,
  newContract: OpenApiDocument,
  oldSchemas: Record<string, JsonValue>,
  newSchemas: Record<string, JsonValue>,
  compared: NonNullable<ReturnType<typeof compare>>,
): { before: FieldShape[]; after: FieldShape[] } {
  const open = (
    document: OpenApiDocument,
    schemas: Record<string, JsonValue>,
    fields: readonly FieldShape[],
  ) =>
    fields.flatMap((field) => {
      const name = field.ref === undefined ? undefined : schemaName(field.ref);
      if (name === undefined || !(name in schemas)) return [];
      const depth = segmentsOfPointer(field.pointer).filter(
        (segment) => !isWildcardSegment(segment),
      ).length;
      return fieldsOf(
        document,
        schemas[name] as JsonValue,
        { name: field.name, pointer: field.pointer },
        depth,
      );
    });
  return {
    before: open(oldContract, oldSchemas, compared.removed),
    after: open(newContract, newSchemas, compared.added),
  };
}

/**
 * The fields under a field that points at a different schema than it did.
 *
 * Datadog's `last_revision` went from `CustomRuleRevision` to
 * `CustomRuleRevisionInput`, and both schemas stayed unchanged: each is
 * compared with itself, under its own name, and nothing compared what a
 * rule's revision became, so seven fields it gained and two it lost had
 * nothing to explain them. A name that is gone is a rename, matched by where
 * it is used, and is not read here; nor is one that changed under its own
 * name, which is drafted there. Only a schema whose fields the walk reads to
 * the same depth as it reads an object written in place.
 */
function repointedFields(
  oldContract: OpenApiDocument,
  newContract: OpenApiDocument,
  oldSchemas: Record<string, JsonValue>,
  newSchemas: Record<string, JsonValue>,
  before: readonly FieldShape[],
  after: readonly FieldShape[],
): { before: FieldShape[]; after: FieldShape[] } {
  const newAt = new Map(after.map((field) => [field.pointer, field]));
  const found = { before: [] as FieldShape[], after: [] as FieldShape[] };
  for (const field of before) {
    for (const [ref, pointer, name] of [
      [field.ref, field.pointer, field.name],
      [field.items?.ref, `${field.pointer}/*`, `${field.name}.*`],
    ] as [string | undefined, string, string][]) {
      const was = ref === undefined ? undefined : schemaName(ref);
      if (was === undefined || !(was in newSchemas)) continue;
      // Only where the schema it pointed at is itself unchanged: one that
      // changed is compared under its own name, and reading it here as well
      // would draft the same difference twice. Adyen's `BalanceAccount`
      // recased its status and the list beside it moved to
      // `BalanceAccountBase`, and the second draft met values the first had
      // already converted.
      if (JSON.stringify(oldSchemas[was]) !== JSON.stringify(newSchemas[was])) continue;
      const there = newAt.get(field.pointer);
      const now = schemaName(
        (pointer.endsWith("/*") ? there?.items?.ref : there?.ref) ?? "",
      );
      if (now === undefined || now === was || !(now in newSchemas)) continue;
      const depth = pointer
        .split("/")
        .filter(
          (segment) => segment !== "" && segment !== "*" && segment !== "{}",
        ).length;
      if (depth > NESTING) continue;
      const at = { name, pointer };
      found.before.push(
        ...fieldsOf(oldContract, oldSchemas[was] as JsonValue, at, depth),
      );
      found.after.push(...fieldsOf(newContract, newSchemas[now] as JsonValue, at, depth));
    }
  }
  return found;
}

/**
 * The fields of a named schema, read where a field now refers to it and the
 * old contract wrote the object in place.
 *
 * PayPal's error responses listed each issue as an object written in place,
 * and a later release made it a reference to a new `error_details`, in which
 * `issue` is required. A referenced schema is compared as itself, under its
 * own name, which says nothing about how it differs from the object written
 * here before: its fields looked removed from every error, and the one that
 * became required went unexplained. Only fields under a place something was
 * removed from are read, which is a place the old contract wrote in place, so
 * a reference that replaced nothing adds nothing and nothing is read twice.
 */
function referencesInPlace(
  document: OpenApiDocument,
  fields: readonly FieldShape[],
  removed: readonly string[],
  newSchemas: Record<string, JsonValue>,
): FieldShape[] {
  const found: FieldShape[] = [];
  const read = new Set<string>();
  // Read again through what was just read: PayPal nested its references, an
  // invoice's `detail` referring to one whose `attachments` refer to another.
  for (let pending = [...fields]; pending.length > 0; ) {
    const next: FieldShape[] = [];
    for (const field of pending) {
      const targets: [string | undefined, string, string][] = [
        [field.ref, field.pointer, field.name],
        [field.items?.ref, `${field.pointer}/*`, `${field.name}.*`],
      ];
      for (const [ref, pointer, name] of targets) {
        const target = ref === undefined ? undefined : schemaName(ref);
        if (target === undefined || !(target in newSchemas) || read.has(pointer))
          continue;
        // Only the outermost of what went is listed: the field itself,
        // something under it, or something it is under.
        const related = (gone: string) =>
          gone === pointer ||
          gone.startsWith(`${pointer}/`) ||
          pointer.startsWith(`${gone}/`);
        if (!removed.some(related)) continue;
        read.add(pointer);
        // As deep as the same object written in place would be read.
        const depth = pointer
          .split("/")
          .filter(
            (segment) => segment !== "" && segment !== "*" && segment !== "{}",
          ).length;
        // No deeper than the old side is ever read, or what it never listed
        // would look added.
        if (depth > NESTING) continue;
        const inner = fieldsOf(
          document,
          newSchemas[target] as JsonValue,
          { name, pointer },
          depth,
        );
        found.push(...inner);
        next.push(...inner);
      }
    }
    pending = next;
  }
  return found;
}

/** The named schemas a schema is built from through `allOf`, however deep. */
function composedOf(
  document: OpenApiDocument,
  schema: JsonValue,
  seen = new Set<string>(),
): Set<string> {
  const resolved = isJsonObject(schema) ? schema : {};
  for (const branch of Array.isArray(resolved["allOf"]) ? resolved["allOf"] : []) {
    if (!isJsonObject(branch) || typeof branch["$ref"] !== "string") continue;
    const name = schemaName(branch["$ref"]);
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    const target = schemasOf(document)[name];
    if (target !== undefined) composedOf(document, target, seen);
  }
  return seen;
}

/**
 * A field a schema has because it is built from another, through `allOf`, is
 * that other schema's to change.
 *
 * Figma's `devStatus` is declared once, on `DevStatusTrait`, and eight node
 * schemas are built from it. Compared schema by schema, the value it gained
 * was eight questions, and eight answers: the first changed the shared part
 * for all of them, and each of the rest then named values that were no longer
 * there. Kept only where it is declared, it is one question, and the one
 * answer reaches every schema built from it.
 */
function inheritedOnce(
  document: OpenApiDocument,
  schemas: Record<string, JsonValue>,
  newDocument: OpenApiDocument,
  newSchemas: Record<string, JsonValue>,
  deltas: SchemaDelta[],
): void {
  const byName = new Map(deltas.map((delta) => [delta.schema, delta]));
  for (const delta of [...deltas]) {
    // Only while it is still built from them: Okta's `EmailServerRequest` was
    // replaced by `BaseEmailServer` itself, so what the base changed is what
    // the request body changed too, and nothing else would say so.
    const stillComposed = composedOf(newDocument, newSchemas[delta.newSchema] ?? null);
    const bases = [...composedOf(document, schemas[delta.schema] ?? null)]
      .map((name) => byName.get(name))
      .filter(
        (base): base is SchemaDelta =>
          base !== undefined && stillComposed.has(base.newSchema),
      );
    if (bases.length === 0) continue;
    // The same change, not only the same place: a schema may declare its own
    // version of a property it inherits, and a change to that one is its own.
    const shape = ({ name: _name, ...field }: FieldShape) => JSON.stringify(field);
    const theirs = (pick: (base: SchemaDelta) => string[]) =>
      new Set(bases.flatMap(pick));
    const removed = theirs((base) => base.removed.map(shape));
    const added = theirs((base) => base.added.map(shape));
    const altered = theirs((base) =>
      base.altered.map((pair) => `${shape(pair.old)}>${shape(pair.new)}`),
    );
    delta.removed = delta.removed.filter((field) => !removed.has(shape(field)));
    delta.added = delta.added.filter((field) => !added.has(shape(field)));
    delta.altered = delta.altered.filter(
      (pair) => !altered.has(`${shape(pair.old)}>${shape(pair.new)}`),
    );
  }
  for (let index = deltas.length - 1; index >= 0; index -= 1) {
    const delta = deltas[index] as SchemaDelta;
    const moved = delta.regrouped?.length ?? 0;
    if (delta.removed.length + delta.added.length + delta.altered.length + moved === 0) {
      deltas.splice(index, 1);
    }
  }
}

/** What an old schema is compared with: a schema of the new contract, named or written in place. */
interface Counterpart {
  /** Its name, or where it is written when it has none. */
  name: string;
  schema: JsonValue;
}

const SCHEMA_REF = "#/components/schemas/";

function schemaName(ref: string): string | undefined {
  return ref.startsWith(SCHEMA_REF)
    ? ref.slice(SCHEMA_REF.length).replaceAll("~1", "/").replaceAll("~0", "~")
    : undefined;
}

/**
 * The schema written at a field's pointer, as the field is read: `*` is a
 * list's items, `{}` a map's values.
 */
function schemaAt(
  document: OpenApiDocument,
  schema: JsonValue,
  pointer: string,
): JsonValue | undefined {
  let node: JsonValue | undefined = schema;
  for (const raw of pointer.split("/").slice(1)) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    const resolved = throughNull(document, resolvedObject(document, node ?? null));
    node =
      segment === "*"
        ? resolved["items"]
        : segment === "{}"
          ? resolved["additionalProperties"]
          : isJsonObject(resolved["properties"])
            ? resolved["properties"][segment]
            : undefined;
    if (node === undefined) return undefined;
  }
  return node;
}

/** Where each schema refers to a named one, and the name it refers to. */
function referencesIn(
  document: OpenApiDocument,
  schemas: Record<string, JsonValue>,
): Map<string, Map<string, string>> {
  const references = new Map<string, Map<string, string>>();
  for (const [name, schema] of Object.entries(schemas)) {
    const here = new Map<string, string>();
    for (const field of fieldsOf(document, schema)) {
      const target = field.ref === undefined ? undefined : schemaName(field.ref);
      if (target) here.set(field.pointer, target);
      const item =
        field.items?.ref === undefined ? undefined : schemaName(field.items.ref);
      if (item) here.set(`${field.pointer}/*`, item);
    }
    if (here.size > 0) references.set(name, here);
  }
  return references;
}

/**
 * Schemas renamed, or written out in place, where they were used, matched by
 * where they are used.
 *
 * PayPal dropped its named `address_portable` schema in one release and wrote
 * the same object out in place wherever the payer's address, a shipping
 * address and the rest had referred to it. No operation names it, so a match
 * by operation never found it, and every field the address lost was reported
 * with nothing to explain it. A schema referred to from a property of a
 * schema already matched is compared with whatever that property holds in the
 * new contract: the schema it names, provided that name is new (one the old
 * contract also has is a different schema the property was pointed at), or
 * the object written there in its place. Matching repeats until nothing more
 * is found, so a rename two levels down is found through the one above it.
 */
function matchThroughReferences(
  oldContract: OpenApiDocument,
  newContract: OpenApiDocument,
  oldSchemas: Record<string, JsonValue>,
  newSchemas: Record<string, JsonValue>,
  counterparts: Map<string, Counterpart>,
): void {
  if (Object.keys(oldSchemas).every((name) => counterparts.has(name))) return;
  const oldReferences = referencesIn(oldContract, oldSchemas);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [parent, references] of oldReferences) {
      const counterpart = counterparts.get(parent);
      if (!counterpart) continue;
      for (const [pointer, child] of references) {
        if (counterparts.has(child)) continue;
        const there = schemaAt(newContract, counterpart.schema, pointer);
        if (!isJsonObject(there)) continue;
        const ref = there["$ref"];
        if (typeof ref === "string") {
          const renamed = schemaName(ref);
          if (renamed === undefined || renamed in oldSchemas || !(renamed in newSchemas))
            continue;
          counterparts.set(child, {
            name: renamed,
            schema: newSchemas[renamed] as JsonValue,
          });
        } else {
          const written = throughNull(newContract, resolvedObject(newContract, there));
          if (!isJsonObject(written["properties"])) continue;
          counterparts.set(child, {
            name: `${counterpart.name}${pointer}`,
            schema: there,
          });
        }
        grew = true;
      }
    }
  }
}

/**
 * A schema kept under its name for one direction and given a new one for the
 * other.
 *
 * Adyen's `AfterpayTouchInfo` was sent and received. A later release kept it
 * for requests and pointed responses at a new `AfterpayTouchResponseInfo`,
 * in which `supportUrl` is no longer required. Matched by name, the schema had
 * not changed, and old callers, promised the field in every response, were
 * left to find it missing.
 *
 * Where a schema matched under its own name, with nothing changed, is
 * replaced by a new one wherever a matched schema or an operation now refers
 * to it in one direction only, it is compared with that one, for that
 * direction. Only what can change for one direction alone is kept: that a
 * field may now be left out or null, which an op serves toward old callers'
 * responses and nowhere else. A field removed, renamed, given other values or
 * other bounds would be drafted with ops that act on requests too, where the
 * schema did not change, so those are left to be reported.
 */
function splitByDirection(
  oldContract: OpenApiDocument,
  newContract: OpenApiDocument,
  oldSchemas: Record<string, JsonValue>,
  newSchemas: Record<string, JsonValue>,
  counterparts: ReadonlyMap<string, Counterpart>,
  uses: {
    oldUses: ReadonlyMap<string, string[]>;
    newByUse: ReadonlyMap<string, string>;
    operationRenames: ReadonlyMap<string, string>;
  },
  deltas: SchemaDelta[],
): void {
  const { oldUses, newByUse, operationRenames } = uses;
  const changed = new Set(deltas.map((delta) => delta.schema));
  const splits = new Map<string, Set<string>>();
  const note = (child: string, there: JsonValue | undefined) => {
    if (!isJsonObject(there) || typeof there["$ref"] !== "string") return;
    const target = schemaName(there["$ref"]);
    if (target === undefined || target in oldSchemas || !(target in newSchemas)) return;
    if (counterparts.get(child)?.name !== child || changed.has(child)) return;
    splits.set(child, new Set([...(splits.get(child) ?? []), target]));
  };
  for (const [parent, references] of referencesIn(oldContract, oldSchemas)) {
    const counterpart = counterparts.get(parent);
    if (!counterpart) continue;
    for (const [pointer, child] of references) {
      note(child, schemaAt(newContract, counterpart.schema, pointer));
    }
  }
  for (const [name, uses] of oldUses) {
    for (const use of uses) {
      const [operationId, ...rest] = use.split(" ");
      const mapped = operationRenames.get(operationId as string) ?? operationId;
      const found = newByUse.get([mapped, ...rest].join(" "));
      if (found !== undefined) note(name, { $ref: `#/components/schemas/${found}` });
    }
  }

  for (const [name, targets] of splits) {
    // A field that may now be missing breaks only a response, so the schema
    // responses were given is the one compared; one, or it is not clear which.
    const responses = [...targets].filter((target) => {
      const direction = schemaDirections(newContract, `#/components/schemas/${target}`);
      return direction.response && !direction.request;
    });
    if (responses.length !== 1) continue;
    const [target = ""] = responses;
    const direction = { request: false, response: true };
    const compared = compare(
      shapeOf(oldContract, oldSchemas[name] as JsonValue, name),
      shapeOf(newContract, newSchemas[target] as JsonValue, name),
    );
    // The presence part of each change alone: the old field, as the new one
    // may be left out or null. What else changed about it stays reported.
    const presence = (compared?.altered ?? [])
      .filter(
        (pair) =>
          pair.old.required !== pair.new.required ||
          pair.old.nullable !== pair.new.nullable,
      )
      .map((pair) => ({
        old: pair.old,
        new: { ...pair.old, required: pair.new.required, nullable: pair.new.nullable },
      }));
    if (presence.length === 0) continue;
    deltas.push({
      schema: name,
      newSchema: target,
      removed: [],
      added: [],
      altered: presence,
      operations: [],
      sides: direction,
    });
  }
}

/**
 * Compares the two contracts schema by schema.
 *
 * Schemas are matched by name. A renamed schema is matched by the operation it
 * serves instead, or by the property of a matched schema that refers to it,
 * so a rename does not read as one schema vanishing and an unrelated one
 * appearing.
 */
export function schemaDeltas(
  oldContract: OpenApiDocument,
  newContract: OpenApiDocument,
  /** Old operationId to new operationId, where a route change renamed one. */
  operationRenames: ReadonlyMap<string, string> = new Map(),
): SchemaDelta[] {
  const oldSchemas = schemasOf(oldContract);
  const newSchemas = schemasOf(newContract);
  const oldUses = operationsUsing(oldContract);
  const newUses = operationsUsing(newContract);

  /** New schema names, keyed by the operation position they occupy. */
  const newByUse = new Map<string, string>();
  for (const [name, uses] of newUses) {
    for (const use of uses) newByUse.set(use, name);
  }

  const deltas: SchemaDelta[] = [];

  const counterparts = new Map<string, Counterpart>();
  for (const name of Object.keys(oldSchemas)) {
    if (name in newSchemas) {
      counterparts.set(name, { name, schema: newSchemas[name] as JsonValue });
      continue;
    }
    for (const use of oldUses.get(name) ?? []) {
      const [operationId, ...rest] = use.split(" ");
      const mapped = operationRenames.get(operationId as string) ?? operationId;
      const found = newByUse.get([mapped, ...rest].join(" "));
      if (found) {
        counterparts.set(name, { name: found, schema: newSchemas[found] as JsonValue });
        break;
      }
    }
  }
  matchThroughReferences(oldContract, newContract, oldSchemas, newSchemas, counterparts);

  for (const name of Object.keys(oldSchemas).sort()) {
    const counterpart = counterparts.get(name);
    if (!counterpart) continue;

    const compared = compareReading(
      oldContract,
      newContract,
      oldSchemas,
      newSchemas,
      shapeOf(oldContract, oldSchemas[name] as JsonValue, name),
      shapeOf(newContract, counterpart.schema, name),
      { name, old: oldSchemas[name] as JsonValue, new: counterpart.schema },
    );
    if (!compared) continue;
    deltas.push({
      schema: name,
      newSchema: counterpart.name,
      ...compared,
      ...(movedIntoVariants(newContract, counterpart.schema, compared.removed)
        ? { replaced: true as const }
        : {}),
      operations: oldUses.get(name) ?? [],
    });
  }

  splitByDirection(
    oldContract,
    newContract,
    oldSchemas,
    newSchemas,
    counterparts,
    { oldUses, newByUse, operationRenames },
    deltas,
  );
  inheritedOnce(oldContract, oldSchemas, newContract, newSchemas, deltas);

  // Request bodies declared inline, as Twilio and Stripe declare theirs, have
  // no name to be compared by, so the operation is the name, found where it
  // stands or by the operationId a route change gave it.
  const newOps = operationsOf(newContract);
  const newAt = new Map(
    newOps.map((operation) => [`${operation.method} ${operation.path}`, operation]),
  );
  const newById = new Map(newOps.map((operation) => [operation.operationId, operation]));
  for (const operation of operationsOf(oldContract)) {
    if (operation.webhook) continue;
    const body = requestBodySchema(oldContract, operation.operation);
    if (!isJsonObject(body) || typeof body["$ref"] === "string") continue;
    const counterpart =
      newAt.get(`${operation.method} ${operation.path}`) ??
      newById.get(operationRenames.get(operation.operationId) ?? operation.operationId);
    if (!counterpart) continue;
    const after = requestBodySchema(newContract, counterpart.operation);
    if (after === undefined) continue;
    const compared = compareReading(
      oldContract,
      newContract,
      oldSchemas,
      newSchemas,
      fieldsOf(oldContract, body),
      fieldsOf(newContract, after),
      { name: `${operation.operationId} request body`, old: body, new: after },
    );
    if (!compared) continue;
    deltas.push({
      schema: `${operation.operationId} request body`,
      newSchema: `${counterpart.operationId} request body`,
      ...compared,
      operations: [
        `${operation.operationId} request (${operation.method.toUpperCase()} ${operation.path})`,
      ],
      scope: { operation: operation.operationId, location: "body" },
      sides: { request: true, response: false },
    });
  }

  // Response bodies written in place, as PayPal writes its errors, compared
  // per operation and status the same way, and scoped to that response.
  for (const operation of operationsOf(oldContract)) {
    if (operation.webhook) continue;
    const counterpart =
      newAt.get(`${operation.method} ${operation.path}`) ??
      newById.get(operationRenames.get(operation.operationId) ?? operation.operationId);
    if (!counterpart) continue;
    const after = new Map(
      responseSchemas(newContract, counterpart.operation).map((entry) => [
        entry.status,
        entry.schema,
      ]),
    );
    for (const { status, schema } of responseSchemas(oldContract, operation.operation)) {
      if (!isJsonObject(schema)) continue;
      const next = after.get(status);
      if (next === undefined) continue;
      // A response that names a schema is compared under that name, unless
      // this operation now names another one: Plaid pointed three consent
      // operations at `FDXError` while `PlaidError` stayed for everything
      // else, so nothing compared the two.
      if (
        typeof schema["$ref"] === "string" &&
        !pointedElsewhere(newContract, schema, next, newSchemas)
      ) {
        continue;
      }
      const compared = compareReading(
        oldContract,
        newContract,
        oldSchemas,
        newSchemas,
        fieldsOf(oldContract, schema),
        fieldsOf(newContract, next),
        { name: `${operation.operationId} ${status} response`, old: schema, new: next },
      );
      if (!compared) continue;
      deltas.push({
        schema: `${operation.operationId} ${status} response`,
        newSchema: `${counterpart.operationId} ${status} response`,
        ...compared,
        operations: [
          `${operation.operationId} ${status} response (${operation.method.toUpperCase()} ${operation.path})`,
        ],
        scope: { operation: operation.operationId, response: status },
        sides: { request: false, response: true },
      });
    }
  }

  return deltas;
}
