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
import { isJsonObject, type JsonObject, type JsonValue, type Scope } from "@invariant/ir";

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
  description: string | undefined;
  required: boolean;
  nullable: boolean;
  /** The schema's own `default`, when it declares one. */
  default?: JsonValue;
  /** Declared `readOnly`: it appears in responses and never in requests. */
  readOnly?: boolean;
  /** For a union, the named schemas it can hold, as references. */
  variants?: string[];
  /** For a union, whether one of its branches is a plain string, as an id is. */
  idBranch?: boolean;
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
    const value: JsonObject = isJsonObject(child) ? child : {};
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
    const enumValues =
      Array.isArray(declaredEnum) &&
      (declaredEnum as JsonValue[]).every((v) => typeof v === "string")
        ? (declaredEnum as string[])
        : undefined;

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
      description:
        typeof value["description"] === "string" ? value["description"] : undefined,
      required: required.has(name),
      // Each way a document can say it: 3.1's type list, 3.0's flag, or a
      // union with a null branch.
      nullable:
        types.includes("null") ||
        value["nullable"] === true ||
        ["anyOf", "oneOf"].some(
          (key) =>
            Array.isArray(value[key]) &&
            (value[key] as JsonValue[]).some(
              (branch) => isJsonObject(branch) && branch["type"] === "null",
            ),
        ),
      ...(value["default"] === undefined ? {} : { default: value["default"] }),
      ...(value["readOnly"] === true ? { readOnly: true } : {}),
      ...unionOf(value),
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
    const nested = isJsonObject(value["properties"])
      ? fieldsOf(document, value, here, depth + 1)
      : items && isJsonObject(resolveSchema(document, items))
        ? fieldsOf(
            document,
            items,
            { name: `${here.name}.*`, pointer: `${here.pointer}/*` },
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
  const removed = before.filter((field) => !afterAt.has(field.pointer));
  const added = after.filter((field) => !beforeAt.has(field.pointer));
  const altered = before
    .filter((field) => afterAt.has(field.pointer))
    .map((field) => ({ old: field, new: afterAt.get(field.pointer) as FieldShape }))
    .filter((pair) => shapeDiffers(pair.old, pair.new));
  if (removed.length === 0 && added.length === 0 && altered.length === 0)
    return undefined;
  return { removed, added, altered };
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
  if (left !== right) return true;
  return a.variants?.join("|") !== b.variants?.join("|");
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
      fieldsOf(oldContract, oldSchemas[name] as JsonValue),
      fieldsOf(newContract, newSchemas[counterpart] as JsonValue),
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

  return deltas;
}
