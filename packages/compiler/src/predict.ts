/**
 * Replaying declared Changes over the old contract to predict the new one.
 */
import {
  bodySchemaFor,
  findSchemaSites,
  type OpenApiDocument,
  operationsOf,
  resolveRef,
  resolveSchema,
  type Site,
} from "@invariant/contract";
import {
  type Change,
  type DataOp,
  isDataOp,
  isJsonObject,
  isSchemaScope,
  type JsonObject,
  type JsonValue,
  parsePointer,
  type RetireOp,
  type RouteOp,
  type Scope,
} from "@invariant/ir";
import { schemaAdd, schemaConvert, schemaMove, schemaRemove } from "./schema.ts";

export interface PredictionIssue {
  changeId: string;
  message: string;
}

export interface Prediction {
  document: OpenApiDocument;
  issues: PredictionIssue[];
}

export interface RouteMapping {
  from: { method: string; path: string };
  to: { method: string; path: string };
  changeId: string;
}

export function routeMappings(changes: readonly Change[]): RouteMapping[] {
  const out: RouteMapping[] = [];
  for (const change of changes) {
    for (const op of change.ops) {
      if (op.op === "route") {
        out.push({ from: op.from, to: op.to, changeId: change.id });
      }
    }
  }
  return out;
}

/** Where an old endpoint ends up after the declared route changes. */
export function mapEndpoint(
  routes: readonly RouteMapping[],
  method: string,
  path: string,
): { method: string; path: string } {
  for (const route of routes) {
    if (route.from.method === method.toLowerCase() && route.from.path === path) {
      return route.to;
    }
  }
  return { method: method.toLowerCase(), path };
}

function applyRoute(
  document: OpenApiDocument,
  op: RouteOp,
  issues: PredictionIssue[],
  changeId: string,
): void {
  const paths = document["paths"];
  if (!isJsonObject(paths)) return;

  const item = paths[op.from.path];
  if (!isJsonObject(item)) {
    issues.push({
      changeId,
      message: `route source path ${op.from.path} does not exist`,
    });
    return;
  }
  const operation = item[op.from.method];
  if (!isJsonObject(operation)) {
    issues.push({
      changeId,
      message: `route source ${op.from.method.toUpperCase()} ${op.from.path} does not exist`,
    });
    return;
  }

  delete item[op.from.method];
  if (Object.keys(item).filter((key) => key !== "parameters").length === 0) {
    delete paths[op.from.path];
  }

  const moved: JsonObject = { ...operation };
  if (op.operationId) moved["operationId"] = op.operationId.to;

  const target = paths[op.to.path];
  if (isJsonObject(target)) {
    target[op.to.method] = moved;
  } else {
    paths[op.to.path] = { [op.to.method]: moved };
  }
}

/**
 * Applies data ops to an operation's query, path or header parameters.
 *
 * Added last of the three scopes, and only after real documents showed why it
 * mattered: 483 breaking deltas across sixty real version pairs were about
 * parameters, and the compiler answered "only schema scopes are supported" to
 * every one. `ParameterScope` had been in the IR the whole time with nothing
 * behind it.
 *
 * A parameter is named by the first segment of the op's pointer, because a
 * parameter has a name and no nesting above it. Ops reach the parameter's
 * schema, which is where an enum or a type lives.
 */
function applyParameterScope(
  document: OpenApiDocument,
  scope: { operation: string; location: string },
  ops: readonly DataOp[],
  issues: PredictionIssue[],
  changeId: string,
): void {
  const operation = operationsOf(document).find(
    (candidate) => candidate.operationId === scope.operation,
  );
  if (!operation) {
    issues.push({
      changeId,
      message: `no operation called ${scope.operation} to scope a parameter change to`,
    });
    return;
  }

  const paths = document["paths"];
  const item = isJsonObject(paths) ? paths[operation.path] : undefined;
  const declared = [
    ...(isJsonObject(item) && Array.isArray(item["parameters"])
      ? item["parameters"]
      : []),
    ...(Array.isArray(operation.operation["parameters"])
      ? operation.operation["parameters"]
      : []),
  ];

  for (const op of ops) {
    const pointer = op.op === "move" ? op.from : op.path;
    const name = pointer.split("/").filter((part) => part !== "")[0];
    if (name === undefined) {
      issues.push({ changeId, message: `${pointer} does not name a parameter` });
      continue;
    }

    // Parameters are often `$ref`s to a shared component, which is how Google
    // declares `alt` on every operation it has. Matching only on the literal
    // array missed all of them.
    const index = declared.findIndex((entry) => {
      const resolved = resolvedParameter(document, entry);
      return resolved?.["name"] === name && resolved["in"] === scope.location;
    });
    if (index === -1) {
      issues.push({
        changeId,
        message: `${scope.operation} has no ${scope.location} parameter called ${name}`,
      });
      continue;
    }

    // A shared parameter is shared. Changing it where it is defined would move
    // it for every operation that points at it, so the reference is replaced
    // with a copy belonging to this operation alone.
    const entry = declared[index];
    let parameter: JsonObject;
    if (isJsonObject(entry) && typeof entry["$ref"] === "string") {
      parameter = structuredClone(resolvedParameter(document, entry) as JsonObject);
      declared[index] = parameter;
      replaceParameter(operation.operation, item, entry, parameter);
    } else {
      parameter = entry as JsonObject;
    }

    const schema = parameter["schema"];
    if (!isJsonObject(schema)) {
      issues.push({ changeId, message: `the ${name} parameter has no schema to change` });
      continue;
    }

    applyToParameterSchema(schema, op, parameter, issues, changeId, name);
  }
}

/** A parameter entry, following a `$ref` when there is one. */
function resolvedParameter(
  document: OpenApiDocument,
  entry: unknown,
): JsonObject | undefined {
  if (!isJsonObject(entry)) return undefined;
  const ref = entry["$ref"];
  if (typeof ref !== "string") return entry;
  const target = resolveRef(document, ref);
  return isJsonObject(target) ? target : undefined;
}

/** Swaps a shared reference for the operation's own copy, wherever it was listed. */
function replaceParameter(
  operation: JsonObject,
  pathItem: unknown,
  from: unknown,
  to: JsonObject,
): void {
  for (const holder of [operation, pathItem]) {
    if (!isJsonObject(holder)) continue;
    const list = holder["parameters"];
    if (!Array.isArray(list)) continue;
    const at = (list as unknown[]).indexOf(from);
    if (at !== -1) (list as unknown[])[at] = to;
  }
}

/** The per-op half of the above, kept separate so each op reads on its own. */
function applyToParameterSchema(
  schema: JsonObject,
  op: DataOp,
  parameter: JsonObject,
  issues: PredictionIssue[],
  changeId: string,
  name: string,
): void {
  switch (op.op) {
    case "convert": {
      if (op.codec.kind === "enumMap") {
        // The predicted vocabulary is what the mapping says it becomes, in the
        // order the new contract would list it.
        schema["enum"] = [...new Set(op.codec.pairs.map(([, to]) => to))];
        return;
      }
      if (op.codec.kind === "cast") {
        schema["type"] = op.codec.to;
        return;
      }
      // scale10 changes a number's units, not its declared type, so the
      // predicted schema is unchanged and saying so is the correct answer.
      return;
    }
    case "move": {
      const to = op.to.split("/").filter((part) => part !== "")[0];
      if (to === undefined) {
        issues.push({ changeId, message: `${op.to} does not name a parameter` });
        return;
      }
      parameter["name"] = to;
      return;
    }
    case "remove": {
      parameter["x-invariant-removed"] = true;
      return;
    }
    case "add": {
      parameter["required"] = true;
      return;
    }
    default:
      issues.push({
        changeId,
        message: `no rule for applying this op to the ${name} parameter`,
      });
  }
}

/**
 * Deletes a retired operation from the predicted document.
 *
 * The spec half of `retire`. There is no runtime half and there cannot be: the
 * handler is gone, so nothing can be rewritten into reaching it.
 */
function applyRetire(
  document: OpenApiDocument,
  op: RetireOp,
  issues: PredictionIssue[],
  changeId: string,
): void {
  const paths = document["paths"];
  if (!isJsonObject(paths)) return;

  const item = paths[op.endpoint.path];
  if (!isJsonObject(item) || !isJsonObject(item[op.endpoint.method])) {
    issues.push({
      changeId,
      message:
        `retired ${op.endpoint.method.toUpperCase()} ${op.endpoint.path} does not ` +
        "exist in the contract it is being retired from",
    });
    return;
  }

  delete item[op.endpoint.method];
  if (Object.keys(item).filter((key) => key !== "parameters").length === 0) {
    delete paths[op.endpoint.path];
  }
}

/**
 * Reads through a schema as it applies on the wire, following `$ref`s and
 * merging `allOf` as it goes, through the same resolution the rest of the
 * compiler writes with.
 */
function navigate(
  document: OpenApiDocument,
  schema: JsonValue,
  segments: readonly string[],
): JsonValue | undefined {
  let current: JsonValue | undefined = resolveSchema(document, schema);
  for (const segment of segments) {
    if (!isJsonObject(current)) return undefined;
    const next =
      segment === "*"
        ? current["items"]
        : isJsonObject(current["properties"])
          ? (current["properties"] as JsonObject)[segment]
          : undefined;
    if (next === undefined) return undefined;
    current = resolveSchema(document, next);
  }
  return current;
}

function sitesForScope(document: OpenApiDocument, scope: Scope): Site[] {
  if (!isSchemaScope(scope)) return [];
  return findSchemaSites(document, scope.schema).sites;
}

/**
 * The shape a newly added field has in the new contract. Resolved by position
 * rather than by schema name, so a renamed schema still lines up.
 */
function shapeFromNewContract(
  newDocument: OpenApiDocument,
  routes: readonly RouteMapping[],
  site: Site,
  path: string,
): { shape: JsonValue; required: boolean } | undefined {
  const target = mapEndpoint(routes, site.method, site.path);
  const operation = operationsOf(newDocument).find(
    (candidate) => candidate.method === target.method && candidate.path === target.path,
  );
  if (!operation) return undefined;

  const body = bodySchemaFor(
    newDocument,
    operation.operation,
    site.direction,
    site.status ?? undefined,
  );
  if (body === undefined) return undefined;

  const segments = [...parsePointer(site.prefix), ...parsePointer(path)];
  const shape = navigate(newDocument, body, segments);
  if (shape === undefined) return undefined;

  const parent = navigate(newDocument, body, segments.slice(0, -1));
  const name = segments[segments.length - 1] as string;
  const required =
    isJsonObject(parent) &&
    Array.isArray(parent["required"]) &&
    (parent["required"] as JsonValue[]).includes(name);

  return { shape, required };
}

/**
 * Applies every declared Change to a copy of the old document.
 *
 * Schema-scoped data ops are applied once to the named schema, so one statement
 * covers every place that schema reaches the wire.
 */
export function predictDocument(
  oldContract: OpenApiDocument,
  newContract: OpenApiDocument,
  changes: readonly Change[],
): Prediction {
  const document = structuredClone(oldContract);
  const issues: PredictionIssue[] = [];
  const routes = routeMappings(changes);

  for (const change of changes) {
    for (const op of change.ops) {
      if (op.op === "route") applyRoute(document, op, issues, change.id);
      if (op.op === "retire") applyRetire(document, op, issues, change.id);
    }
  }

  for (const change of changes) {
    const dataOps = change.ops.filter(isDataOp);
    if (dataOps.length === 0) continue;

    const scopes = change.scopes ?? [];
    if (scopes.length === 0) {
      issues.push({ changeId: change.id, message: "data ops need at least one scope" });
      continue;
    }

    for (const scope of scopes) {
      if (!isSchemaScope(scope)) {
        applyParameterScope(document, scope, dataOps, issues, change.id);
        continue;
      }

      const name = scope.schema.slice("#/components/schemas/".length);
      const components = document["components"];
      const schemas = isJsonObject(components) ? components["schemas"] : undefined;
      const schema = isJsonObject(schemas) ? schemas[name] : undefined;
      if (!isJsonObject(schema)) {
        issues.push({
          changeId: change.id,
          message: `no schema named ${name} in the old contract`,
        });
        continue;
      }

      const oldSites = sitesForScope(oldContract, scope);
      for (const op of dataOps) {
        try {
          switch (op.op) {
            case "move":
              schemaMove(document, schema, op.from, op.to);
              break;
            case "convert":
              schemaConvert(document, schema, op.path, op.codec);
              break;
            case "remove":
              schemaRemove(document, schema, op.path);
              break;
            case "add": {
              const site = oldSites[0];
              const resolved = site
                ? shapeFromNewContract(newContract, routes, site, op.path)
                : undefined;
              if (!resolved) {
                issues.push({
                  changeId: change.id,
                  message: `add ${op.path} has no matching field in the new contract for ${name}`,
                });
                break;
              }
              schemaAdd(document, schema, op.path, resolved.shape, resolved.required);
              break;
            }
          }
        } catch (error) {
          issues.push({
            changeId: change.id,
            message: `${op.op} on ${name}: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    }
  }

  return { document, issues };
}
