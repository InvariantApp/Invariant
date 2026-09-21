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
import { isJsonObject, type JsonObject, type JsonValue } from "@invariant/ir";

export interface FieldShape {
  name: string;
  /** JSON Pointer within the schema. Top level only for now. */
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
}

function fieldsOf(document: OpenApiDocument, schema: JsonValue): FieldShape[] {
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
          (v): v is string => typeof v === "string",
        ),
      )
    : new Set<string>();

  return Object.entries(properties).map(([name, raw]) => {
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

    return {
      name,
      pointer: `/${name}`,
      type: types.filter((t) => t !== "null")[0],
      format: typeof value["format"] === "string" ? value["format"] : undefined,
      enumValues,
      description:
        typeof value["description"] === "string" ? value["description"] : undefined,
      required: required.has(name),
      nullable: types.includes("null"),
      ...(value["default"] === undefined ? {} : { default: value["default"] }),
      ...(value["readOnly"] === true ? { readOnly: true } : {}),
    };
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

function shapeDiffers(a: FieldShape, b: FieldShape): boolean {
  if (a.type !== b.type || a.format !== b.format || a.required !== b.required)
    return true;
  const left = a.enumValues?.join("|");
  const right = b.enumValues?.join("|");
  return left !== right;
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

    const before = fieldsOf(oldContract, oldSchemas[name] as JsonValue);
    const after = fieldsOf(newContract, newSchemas[counterpart] as JsonValue);
    const afterByName = new Map(after.map((field) => [field.name, field]));
    const beforeByName = new Map(before.map((field) => [field.name, field]));

    const removed = before.filter((field) => !afterByName.has(field.name));
    const added = after.filter((field) => !beforeByName.has(field.name));
    const altered = before
      .filter((field) => afterByName.has(field.name))
      .map((field) => ({ old: field, new: afterByName.get(field.name) as FieldShape }))
      .filter((pair) => shapeDiffers(pair.old, pair.new));

    if (removed.length === 0 && added.length === 0 && altered.length === 0) continue;

    deltas.push({
      schema: name,
      newSchema: counterpart,
      removed,
      added,
      altered,
      operations: oldUses.get(name) ?? [],
    });
  }

  return deltas;
}
