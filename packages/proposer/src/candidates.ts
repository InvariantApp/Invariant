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
  schemasOf,
} from "@invariant/contract";
import {
  CONSTRAINT_KEYWORDS,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type Scope,
} from "@invariant/ir";

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
  return isJsonObject(raw) && typeof raw["$ref"] === "string" ? { ref: raw["$ref"] } : {};
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

const isNullBranch = (branch: JsonValue): boolean =>
  isJsonObject(branch) && branch["type"] === "null" && Object.keys(branch).length === 1;

/**
 * A field that may also be null, written as a union of its value and null, as
 * Mistral's `tools` became `anyOf: [array, null]`: the field is its value.
 * Read as a union instead, its list items looked removed, and a `remove` was
 * drafted for items the compiler could not find. A branch that names another
 * schema stays as it is, since that schema is compared under its own name.
 */
function throughNull(document: OpenApiDocument, value: JsonObject): JsonObject {
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = value[key];
    if (!Array.isArray(branches) || !branches.some(isNullBranch)) continue;
    const others = branches.filter((branch) => !isNullBranch(branch));
    const [only] = others;
    if (others.length !== 1 || !isJsonObject(only) || typeof only["$ref"] === "string") {
      return value;
    }
    const resolved = resolveSchema(document, only);
    if (!isJsonObject(resolved)) return value;
    const { [key]: _union, ...rest } = value;
    return { ...resolved, ...rest };
  }
  return value;
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
    const declaredEnum = value["enum"];
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
            Array.isArray(outer[key]) &&
            (outer[key] as JsonValue[]).some(
              (branch) => isJsonObject(branch) && branch["type"] === "null",
            ),
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
    const itemUnion = items ? unionOf(items) : {};
    const listed: FieldShape[] =
      itemUnion.variants === undefined
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

/** The fields that went, arrived and changed shape, or nothing when none did. */
function compare(
  before: FieldShape[],
  after: FieldShape[],
): Pick<SchemaDelta, "removed" | "added" | "altered"> | undefined {
  // Keyed by pointer, which is what identifies a field; a nested name is
  // only for reading.
  const afterAt = new Map(after.map((field) => [field.pointer, field]));
  const beforeAt = new Map(before.map((field) => [field.pointer, field]));
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
  // A schema's own value is compared with itself or not at all: a named
  // schema that became a scalar did not gain a field at its root.
  const removed = outermost(
    before.filter((field) => field.pointer !== "" && !afterAt.has(field.pointer)),
  );
  const added = outermost(
    after.filter((field) => field.pointer !== "" && !beforeAt.has(field.pointer)),
  );
  const altered = before
    .filter((field) => afterAt.has(field.pointer))
    .map((field) => ({ old: field, new: afterAt.get(field.pointer) as FieldShape }))
    .filter((pair) => shapeDiffers(pair.old, pair.new));
  if (removed.length === 0 && added.length === 0 && altered.length === 0)
    return undefined;
  return { removed, added, altered };
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
  if (a.variants?.join("|") !== b.variants?.join("|")) return true;
  return JSON.stringify(a.bounds ?? {}) !== JSON.stringify(b.bounds ?? {});
}

/**
 * Compares the two contracts schema by schema.
 *
 * Schemas are matched by name. A renamed schema is matched by the operation it
 * serves instead, so a rename does not read as one schema vanishing and an
 * unrelated one appearing.
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

  for (const name of Object.keys(oldSchemas).sort()) {
    let counterpart = name in newSchemas ? name : undefined;

    if (!counterpart) {
      for (const use of oldUses.get(name) ?? []) {
        const [operationId, ...rest] = use.split(" ");
        const mapped = operationRenames.get(operationId as string) ?? operationId;
        const found = newByUse.get([mapped, ...rest].join(" "));
        if (found) {
          counterpart = found;
          break;
        }
      }
    }
    if (!counterpart) continue;

    const compared = compare(
      shapeOf(oldContract, oldSchemas[name] as JsonValue, name),
      shapeOf(newContract, newSchemas[counterpart] as JsonValue, name),
    );
    if (!compared) continue;
    deltas.push({
      schema: name,
      newSchema: counterpart,
      ...compared,
      operations: oldUses.get(name) ?? [],
    });
  }

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
    const compared = compare(fieldsOf(oldContract, body), fieldsOf(newContract, after));
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
      if (!isJsonObject(schema) || typeof schema["$ref"] === "string") continue;
      const next = after.get(status);
      if (next === undefined) continue;
      const compared = compare(
        fieldsOf(oldContract, schema),
        fieldsOf(newContract, next),
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
