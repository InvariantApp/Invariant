/**
 * Error bodies that point at a request field.
 *
 * Most systems that version an API forget this. A validation error says which
 * parameter was wrong, and once that parameter has been renamed the error names
 * a field the caller has never heard of. The information needed to fix it is
 * already present: the same move ops that relocate the value also say what the
 * field used to be called.
 *
 * A provider marks the field holding that name with `x-invariant-error-param`,
 * and the compiler turns its moves into a mapping back to the old names.
 */
import {
  bodySchemaFor,
  findSchemaSites,
  type OpenApiDocument,
  operationsOf,
} from "@invariant/contract";
import {
  type Change,
  formatPointer,
  isJsonObject,
  isSchemaScope,
  type JsonValue,
  type Pointer,
  parsePointer,
} from "@invariant/ir";

export const ERROR_PARAM_EXTENSION = "x-invariant-error-param";

/** Pointers, within a response body, of fields that name a request parameter. */
export function findErrorParamPointers(
  document: OpenApiDocument,
  schema: JsonValue,
  depth = 0,
): Pointer[] {
  if (depth > 12 || !isJsonObject(schema)) return [];

  const found: Pointer[] = [];
  const properties = schema["properties"];
  if (isJsonObject(properties)) {
    for (const [name, child] of Object.entries(properties)) {
      if (isJsonObject(child) && child[ERROR_PARAM_EXTENSION] === true) {
        found.push(formatPointer([name]));
        continue;
      }
      for (const nested of findErrorParamPointers(document, child, depth + 1)) {
        found.push(formatPointer([name, ...parsePointer(nested)]));
      }
    }
  }

  const items = schema["items"];
  if (items !== undefined) {
    for (const nested of findErrorParamPointers(document, items, depth + 1)) {
      found.push(formatPointer(["*", ...parsePointer(nested)]));
    }
  }

  return found;
}

/** A parameter name as an error body spells it: dotted, without a leading slash. */
function dotted(pointer: Pointer): string {
  return parsePointer(pointer).join(".");
}

export interface ParamRename {
  /** Name in the new contract. */
  from: string;
  /** Name the old contract used. */
  to: string;
  changeId: string;
}

/**
 * Every request-field rename a step performs, as error bodies would spell them.
 */
export function paramRenames(
  oldContract: OpenApiDocument,
  changes: readonly Change[],
): Map<string, ParamRename[]> {
  const byOperation = new Map<string, ParamRename[]>();

  for (const change of changes) {
    const moves = change.ops.filter((op) => op.op === "move");
    if (moves.length === 0) continue;

    for (const scope of change.scopes ?? []) {
      if (!isSchemaScope(scope)) continue;
      for (const site of findSchemaSites(oldContract, scope.schema).sites) {
        if (site.direction !== "request") continue;
        const list = byOperation.get(site.operationId) ?? [];
        for (const move of moves) {
          list.push({
            from: dotted(
              formatPointer([...parsePointer(site.prefix), ...parsePointer(move.to)]),
            ),
            to: dotted(
              formatPointer([...parsePointer(site.prefix), ...parsePointer(move.from)]),
            ),
            changeId: change.id,
          });
        }
        byOperation.set(site.operationId, list);
      }
    }
  }

  return byOperation;
}

export interface ErrorParamTarget {
  operationId: string;
  method: string;
  path: string;
  status: string;
  pointer: Pointer;
}

/** Where, in the new contract, an error body names a request parameter. */
export function errorParamTargets(newContract: OpenApiDocument): ErrorParamTarget[] {
  const targets: ErrorParamTarget[] = [];

  for (const { operationId, method, path, operation } of operationsOf(newContract)) {
    const responses = operation["responses"];
    if (!isJsonObject(responses)) continue;
    for (const status of Object.keys(responses)) {
      const schema = bodySchemaFor(newContract, operation, "response", status);
      if (schema === undefined) continue;
      for (const pointer of findErrorParamPointers(newContract, schema)) {
        targets.push({ operationId, method, path, status, pointer });
      }
    }
  }

  return targets;
}
