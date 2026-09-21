/**
 * Replaying declared Changes over the old contract to predict the new one.
 */
import {
  bodySchemaFor,
  findSchemaSites,
  type OpenApiDocument,
  operationsOf,
  resolveSchema,
  type Site,
} from "@invariant/contract";
import {
  type Change,
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
import { applyParameterScope } from "./predict-parameters.ts";
import {
  schemaAdd,
  schemaConvert,
  schemaMove,
  schemaRemove,
  schemaRequiredAt,
  schemaSetNullable,
  schemaSetRequired,
} from "./schema.ts";

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
        applyParameterScope(
          document,
          oldContract,
          newContract,
          routes,
          scope,
          dataOps,
          issues,
          change.id,
        );
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
            case "default": {
              // Facing old, the new contract is the looser side; facing new,
              // the stricter one.
              const looser = op.toward === "old";
              if (op.when !== "null")
                schemaSetRequired(document, schema, op.path, !looser);
              if (op.when !== "absent")
                schemaSetNullable(document, schema, op.path, looser);
              break;
            }
            case "dropNull":
              // Deleting a null is only a valid answer where the field may be
              // left out, and only matters where the op does work: a schema
              // that is never a response gets nothing deleted on the way out.
              if (
                oldSites.some(
                  (site) =>
                    site.direction === (op.toward === "new" ? "request" : "response"),
                ) &&
                schemaRequiredAt(document, schema, op.path)
              ) {
                throw new Error(
                  `${op.path} is required, so a null cannot be sent as the field left out`,
                );
              }
              schemaSetNullable(document, schema, op.path, op.toward === "old");
              break;
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
