/**
 * Replaying declared Changes over the old contract to predict the new one.
 */
import {
  bodySchemaFor,
  deref,
  findSchemaSites,
  type OpenApiDocument,
  operationsOf,
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
 * Reads through a schema, following `$ref`s as it goes. Navigating the new
 * contract crosses reference boundaries (a list's items are usually a `$ref`),
 * so a read has to resolve them; writes never do, because they would mutate a
 * schema shared with somewhere the change does not apply.
 */
function navigate(
  document: OpenApiDocument,
  schema: JsonValue,
  segments: readonly string[],
): JsonValue | undefined {
  let current: JsonValue | undefined = deref(document, schema);
  for (const segment of segments) {
    if (!isJsonObject(current)) return undefined;
    const next =
      segment === "*"
        ? current["items"]
        : isJsonObject(current["properties"])
          ? (current["properties"] as JsonObject)[segment]
          : undefined;
    if (next === undefined) return undefined;
    current = deref(document, next);
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
        issues.push({ changeId: change.id, message: "only schema scopes are supported" });
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
              schemaMove(schema, op.from, op.to);
              break;
            case "convert":
              schemaConvert(schema, op.path, op.codec);
              break;
            case "remove":
              schemaRemove(schema, op.path);
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
              schemaAdd(schema, op.path, resolved.shape, resolved.required);
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
