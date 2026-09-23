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
  schemaDirections,
} from "@invariant-app/contract";
import {
  CHOOSE_ONE,
  type Change,
  type DataOp,
  isDataOp,
  isJsonObject,
  isParameterScope,
  isResponseScope,
  type JsonObject,
  type JsonValue,
  parsePointer,
  type RetireOp,
  type RouteOp,
  undecidedOps,
} from "@invariant-app/ir";
import { importReferences } from "./import.ts";
import { applyParameterScope } from "./predict-parameters.ts";
import { applyResponseScope, ownBody } from "./predict-responses.ts";
import { proveRestated } from "./restate.ts";
import {
  schemaAdd,
  schemaConvert,
  schemaMove,
  schemaRelax,
  schemaRemove,
  schemaRequiredAt,
  schemaRestate,
  schemaSetNullable,
  schemaSetRequired,
  schemaWiden,
} from "./schema.ts";
import { applyStatus, type StatusMapping, statusMappings, statusNow } from "./status.ts";

export interface PredictionIssue {
  changeId: string;
  message: string;
}

export interface Prediction {
  document: OpenApiDocument;
  issues: PredictionIssue[];
}

/**
 * Keys no program may name, the runtime's own list. It refuses a program that
 * names one at load, since a pointer through `__proto__` or `constructor`
 * reaches the shared prototype of every object in the process.
 */
const UNADDRESSABLE = new Set(["__proto__", "constructor", "prototype"]);

/**
 * A Change that names one of those keys, refused here rather than compiled
 * into a program the runtime will not load. `prototype` compiled without a
 * word and the program failed only when a provider deployed it. Found by the
 * threat-model tests.
 */
export function unaddressableKeys(changes: readonly Change[]): PredictionIssue[] {
  const issues: PredictionIssue[] = [];
  for (const change of changes) {
    change.ops.forEach((op, index) => {
      for (const field of ["path", "from", "to"] as const) {
        const pointer = (op as Record<string, unknown>)[field];
        if (typeof pointer !== "string" || !pointer.startsWith("/")) continue;
        const named = pointer
          .slice(1)
          .split("/")
          .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
          .find((segment) => UNADDRESSABLE.has(segment));
        if (named === undefined) continue;
        issues.push({
          changeId: change.id,
          message: `op ${index + 1} (${op.op}) names "${named}" in ${pointer}, which no program may address: every object shares it`,
        });
      }
    });
  }
  return issues;
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
  // Parameters its old path declared for every method go with it: they were
  // the operation's, whatever path it now lives at.
  const shared = item["parameters"];
  if (op.to.path !== op.from.path && Array.isArray(shared) && shared.length > 0) {
    const own = Array.isArray(moved["parameters"])
      ? (moved["parameters"] as JsonValue[])
      : [];
    const key = (entry: JsonValue): string | undefined => {
      const resolved =
        isJsonObject(entry) && typeof entry["$ref"] === "string"
          ? resolveRef(document, entry["$ref"])
          : entry;
      return isJsonObject(resolved)
        ? `${String(resolved["in"])} ${String(resolved["name"])}`
        : undefined;
    };
    const mine = new Set(own.map(key));
    moved["parameters"] = [
      ...structuredClone(shared).filter((entry: JsonValue) => !mine.has(key(entry))),
      ...own,
    ];
  }

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
        : segment === "{}"
          ? current["additionalProperties"]
          : isJsonObject(current["properties"])
            ? (current["properties"] as JsonObject)[segment]
            : undefined;
    if (next === undefined) return undefined;
    current = resolveSchema(document, next);
  }
  return current;
}

/**
 * A schema at a place, as it is written: references followed, and nothing
 * merged. Undefined where the way there runs through a composition, which
 * only a resolved reading can walk.
 */
export function writtenAt(
  document: OpenApiDocument,
  schema: JsonValue,
  segments: readonly string[],
): JsonValue | undefined {
  let current: JsonValue | undefined = topOf(document, schema);
  for (const segment of segments) {
    if (!isJsonObject(current)) return undefined;
    const properties = current["properties"];
    const next: JsonValue | undefined =
      segment === "*"
        ? current["items"]
        : segment === "{}"
          ? current["additionalProperties"]
          : isJsonObject(properties)
            ? properties[segment]
            : undefined;
    if (next === undefined) return undefined;
    current = topOf(document, next);
  }
  return current;
}

/**
 * A schema taken as written at its top: a reference is followed to what it
 * names, since a schema restated as a reference to its own name would state
 * nothing at all.
 */
export function topOf(document: OpenApiDocument, schema: JsonValue): JsonValue {
  let current = schema;
  for (
    let hops = 0;
    isJsonObject(current) && typeof current["$ref"] === "string" && hops < 16;
    hops += 1
  ) {
    current = resolveRef(document, current["$ref"]) ?? null;
  }
  return current;
}

/**
 * The shape a newly added field has in the new contract. Resolved by position
 * rather than by schema name, so a renamed schema still lines up.
 */
function shapeFromNewContract(
  newDocument: OpenApiDocument,
  routes: readonly RouteMapping[],
  statuses: readonly StatusMapping[],
  site: Site,
  path: string,
): { shape: JsonValue; required: boolean } | undefined {
  const target = mapEndpoint(routes, site.method, site.path);
  const operation = operationsOf(newDocument).find(
    (candidate) => candidate.method === target.method && candidate.path === target.path,
  );
  if (!operation) return undefined;

  // A response is found at the status the operation answers with now.
  const body = bodySchemaFor(
    newDocument,
    operation.operation,
    site.direction,
    site.status === undefined
      ? undefined
      : statusNow(statuses, site.method, site.path, site.status),
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

/** The shape a field has in the new contract's schema of the same name. */
function shapeByName(
  newDocument: OpenApiDocument,
  name: string,
  path: string,
): { shape: JsonValue; required: boolean } | undefined {
  const components = newDocument["components"];
  const schemas = isJsonObject(components) ? components["schemas"] : undefined;
  if (!isJsonObject(schemas) || schemas[name] === undefined) return undefined;
  const root = { $ref: `#/components/schemas/${name}` };
  const segments = parsePointer(path);
  const shape = navigate(newDocument, root, segments);
  if (shape === undefined) return undefined;
  const parent = navigate(newDocument, root, segments.slice(0, -1));
  const field = segments[segments.length - 1] as string;
  const required =
    isJsonObject(parent) &&
    Array.isArray(parent["required"]) &&
    (parent["required"] as JsonValue[]).includes(field);
  return { shape, required };
}

/**
 * How the new contract writes a place in a schema: under the schema's name,
 * or where the schema reaches the wire when the name is gone.
 */
function statementInNew(
  newContract: OpenApiDocument,
  routes: readonly RouteMapping[],
  statuses: readonly StatusMapping[],
  name: string,
  site: Site | undefined,
  path: string,
): JsonValue | undefined {
  const named = writtenAt(
    newContract,
    { $ref: `#/components/schemas/${name}` },
    parsePointer(path),
  );
  if (named !== undefined && named !== null) return named;
  const found = site
    ? shapeFromNewContract(newContract, routes, statuses, site, path)
    : undefined;
  return found && topOf(newContract, found.shape);
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
  const issues: PredictionIssue[] = [...unaddressableKeys(changes)];
  const routes = routeMappings(changes);
  const statuses = statusMappings(changes);

  for (const change of changes) {
    // Checked before anything is applied, so an open decision is reported as
    // one rather than as whatever its placeholder happens to break.
    for (const index of undecidedOps(change)) {
      const op = change.ops[index] as Change["ops"][number];
      issues.push({
        changeId: change.id,
        message: `op ${index + 1} (${op.op}${"path" in op ? ` at ${op.path}` : ""}) is a decision nobody has made yet: replace every ${CHOOSE_ONE} with an answer`,
      });
    }
  }

  for (const change of changes) {
    for (const op of change.ops) {
      if (op.op === "route") applyRoute(document, op, issues, change.id);
      if (op.op === "retire") applyRetire(document, op, issues, change.id);
    }
  }

  // What may now be missing or null in what old callers are sent, on a
  // schema they send too, settled once everything else is in place.
  const towardOld: TowardOld[] = [];

  for (const change of changes) {
    const dataOps = change.ops.filter(isDataOp);
    if (dataOps.length === 0) continue;

    const scopes = change.scopes ?? [];
    if (scopes.length === 0) {
      issues.push({ changeId: change.id, message: "data ops need at least one scope" });
      continue;
    }

    for (const scope of scopes) {
      if (isResponseScope(scope)) {
        applyResponseScope(
          document,
          oldContract,
          newContract,
          routes,
          scope,
          dataOps,
          issues,
          change.id,
          statuses,
        );
        continue;
      }
      if (isParameterScope(scope)) {
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

      const scan = findSchemaSites(oldContract, scope.schema);
      const oldSites = scan.sites;
      // Every place it reaches, listed; otherwise the shared schema speaks
      // for the places the scan could not list.
      const listed = scan.exhausted !== true && scan.unsupported.length === 0;
      for (const op of dataOps) {
        try {
          switch (op.op) {
            case "move":
              schemaMove(document, schema, op.from, op.to);
              break;
            case "convert":
              schemaConvert(document, schema, op.path, op.codec);
              break;
            case "remove": {
              // Already gone through a part this schema shares: a schema
              // built from another by `allOf` loses what that one lost, and
              // both Changes say so. The old contract had it, so this is not
              // a Change naming a field that never was.
              const segments = parsePointer(op.path);
              const oldSchema = (
                (oldContract["components"] as JsonObject | undefined)?.["schemas"] as
                  | JsonObject
                  | undefined
              )?.[name];
              if (
                navigate(document, schema, segments) === undefined &&
                oldSchema !== undefined &&
                navigate(oldContract, oldSchema, segments) !== undefined
              ) {
                break;
              }
              // Leaving it out of responses breaks an old caller who was
              // promised it; only a value put back serves them.
              if (
                op.restore === undefined &&
                oldSchema !== undefined &&
                schemaDirections(oldContract, scope.schema).response &&
                schemaRequiredAt(
                  oldContract,
                  structuredClone(oldSchema) as JsonObject,
                  op.path,
                )
              ) {
                issues.push({
                  changeId: change.id,
                  message: `remove ${op.path} has no restore, but old callers' responses always carried it: say what they are given in its place`,
                });
                break;
              }
              schemaRemove(document, schema, op.path);
              break;
            }
            case "add": {
              const site = oldSites[0];
              // By position first, so a renamed schema still lines up; then
              // by the schema's own name, for an operation whose path moved
              // in a way no declared route follows.
              const resolved =
                (site
                  ? shapeFromNewContract(newContract, routes, statuses, site, op.path)
                  : undefined) ?? shapeByName(newContract, name, op.path);
              if (!resolved) {
                issues.push({
                  changeId: change.id,
                  message: `add ${op.path} has no matching field in the new contract for ${name}`,
                });
                break;
              }
              importReferences(document, newContract, resolved.shape);
              schemaAdd(document, schema, op.path, resolved.shape, resolved.required);
              break;
            }
            case "default": {
              // Facing old, the new contract is the looser side; facing new,
              // the stricter one.
              const looser = op.toward === "old";
              if (looser && bothWays(oldSites)) {
                towardOld.push({
                  changeId: change.id,
                  name,
                  sites: oldSites,
                  listed,
                  op,
                });
                break;
              }
              if (op.when !== "null")
                schemaSetRequired(document, schema, op.path, !looser);
              if (op.when !== "absent")
                schemaSetNullable(
                  document,
                  schema,
                  op.path,
                  looser,
                  statementInNew(
                    newContract,
                    routes,
                    statuses,
                    name,
                    oldSites[0],
                    op.path,
                  ),
                );
              break;
            }
            case "relax":
              schemaRelax(
                document,
                schema,
                op.path,
                op.set as Record<string, JsonValue>,
                schemaDirections(oldContract, scope.schema).request,
              );
              break;
            case "restate": {
              // The new statement, found by the schema's name or, where the
              // name is gone, where it reaches the wire, is only taken once it
              // is proved to allow nothing the old one did not where old
              // callers receive it, and to refuse nothing they send. By name
              // first: Figma reaches a text node only through a choice of
              // twenty-four kinds of node, and the place on the wire names
              // the choice, not the text node.
              const site = oldSites[0];
              const next =
                shapeByName(newContract, name, op.path) ??
                (site
                  ? shapeFromNewContract(newContract, routes, statuses, site, op.path)
                  : undefined);
              if (!next) {
                throw new Error(
                  `the new contract has no ${op.path || name} to restate it as`,
                );
              }
              // As this schema stands when the op is reached, so a restatement
              // after other ops in the same Change is proved against what they
              // made of it.
              const before = navigate(document, schema, parsePointer(op.path));
              if (before === undefined) {
                throw new Error(`the old contract has no ${op.path} on ${name}`);
              }
              // Written as the new contract writes it, found by name where it
              // can be, and otherwise as it was proved. Plaid's account
              // identity is built from a base with `allOf` and declares the
              // base's mask again, nullable: merged here, the two statements
              // were reconciled one way, and the differ reconciles them
              // another, so the prediction said something the new contract
              // does not.
              const statement =
                writtenAt(
                  newContract,
                  { $ref: `#/components/schemas/${name}` },
                  parsePointer(op.path),
                ) ?? topOf(newContract, next.shape);
              if (!isJsonObject(statement)) {
                throw new Error(`the new contract's ${op.path || name} is not a schema`);
              }
              proveRestated(
                { document, schema: before },
                { document: newContract, schema: next.shape },
                schemaDirections(oldContract, scope.schema),
                op.path || name,
                {
                  before: writtenAt(document, schema, parsePointer(op.path)) ?? before,
                  after: statement,
                },
              );
              importReferences(document, newContract, statement);
              schemaRestate(document, schema, op.path, statement);
              break;
            }
            case "widen": {
              // The variant is the new contract's, and comes over with it.
              if (resolveRef(newContract, op.variant) === undefined) {
                throw new Error(`${op.variant} is not in the new contract`);
              }
              importReferences(document, newContract, { $ref: op.variant });
              schemaWiden(document, schema, op.path, op.variant, op.show);
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
              if (op.toward === "old" && bothWays(oldSites)) {
                towardOld.push({
                  changeId: change.id,
                  name,
                  sites: oldSites,
                  listed,
                  op,
                });
                break;
              }
              schemaSetNullable(
                document,
                schema,
                op.path,
                op.toward === "old",
                statementInNew(newContract, routes, statuses, name, oldSites[0], op.path),
              );
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

  for (const entry of towardOld) {
    looserInResponses(document, newContract, routes, entry, issues);
  }

  // Last, so every Change above found the old contract's responses where the
  // old contract keeps them.
  for (const change of changes) {
    for (const op of change.ops) {
      if (op.op === "status") {
        applyStatus(document, oldContract, newContract, routes, op, issues, change.id);
      }
    }
  }

  return { document, issues };
}

/** A presence op toward old callers on a schema that travels both ways. */
interface TowardOld {
  changeId: string;
  name: string;
  sites: readonly Site[];
  /** Whether the sites are every place the schema reaches. */
  listed: boolean;
  op: Extract<DataOp, { op: "default" | "dropNull" }>;
}

const bothWays = (sites: readonly Site[]) =>
  sites.some((site) => site.direction === "request") &&
  sites.some((site) => site.direction === "response");

/**
 * Whether the new contract still has what old callers send stated as strictly
 * as before somewhere, which is when loosening what they share would say
 * something the new contract does not. Where it loosened their requests too,
 * as Okta loosened the schemas an app's profile is defined with both ways,
 * the shared schema is loosened as it always was.
 */
function strictInNewRequests(
  newContract: OpenApiDocument,
  routes: readonly RouteMapping[],
  entry: TowardOld,
): boolean {
  const { op } = entry;
  const absent = op.op === "default" && op.when !== "null";
  const nulled = op.op === "dropNull" || op.when !== "absent";
  return entry.sites.some((site) => {
    if (site.direction !== "request") return false;
    const target = mapEndpoint(routes, site.method, site.path);
    const operation = operationsOf(newContract).find(
      (candidate) => candidate.method === target.method && candidate.path === target.path,
    );
    if (!operation) return false;
    const body = bodySchemaFor(newContract, operation.operation, "request");
    if (body === undefined) return false;
    const within = [...parsePointer(site.prefix), ...parsePointer(op.path)];
    const field = navigate(newContract, body, within);
    const parent = navigate(newContract, body, within.slice(0, -1));
    if (!isJsonObject(field) || !isJsonObject(parent)) return false;
    const name = within[within.length - 1] as string;
    const required =
      Array.isArray(parent["required"]) &&
      (parent["required"] as JsonValue[]).includes(name);
    return (absent && required) || (nulled && !mayBeNull(field));
  });
}

/** Whether a schema allows null, in any of the ways a document can say so. */
function mayBeNull(schema: JsonObject): boolean {
  const types = schema["type"];
  const values = schema["enum"];
  return (
    schema["nullable"] === true ||
    (Array.isArray(types) && types.includes("null")) ||
    (Array.isArray(values) && values.includes(null)) ||
    ["anyOf", "oneOf"].some(
      (key) =>
        Array.isArray(schema[key]) &&
        (schema[key] as JsonValue[]).some(
          (branch) => isJsonObject(branch) && branch["type"] === "null",
        ),
    )
  );
}

/**
 * A field that may now be missing or null where old callers are sent it,
 * predicted in their responses alone.
 *
 * The op only ever acts on what old callers are sent; what they send is as it
 * was. Loosening the schema they share said otherwise: Adyen's
 * `AfterpayTouchInfo` kept `supportUrl` required for the requests that set a
 * payment method up and pointed responses at a schema where it is optional,
 * and a prediction that made it optional everywhere found it newly required
 * in every request. So each response the schema reaches is loosened in that
 * response's own copy, once every other Change has been applied, and the
 * shared schema stays as requests have it. Where the new contract loosened
 * the requests as well, where a response cannot be walked to the field, or
 * where the schema reaches more places than can be listed, the shared schema
 * is loosened as before.
 */
function looserInResponses(
  document: OpenApiDocument,
  newContract: OpenApiDocument,
  routes: readonly RouteMapping[],
  entry: TowardOld,
  issues: PredictionIssue[],
): void {
  const { op } = entry;
  const segments = parsePointer(op.path);
  const places: { operation: JsonObject; status: string; path: string }[] = [];
  let walked = entry.listed && strictInNewRequests(newContract, routes, entry);
  for (const site of walked ? entry.sites : []) {
    if (site.direction !== "response" || site.status === undefined) continue;
    const target = mapEndpoint(routes, site.method, site.path);
    const paths = document["paths"];
    const item = isJsonObject(paths) ? paths[target.path] : undefined;
    const operation = isJsonObject(item) ? item[target.method] : undefined;
    // Retired, so no response is left to serve.
    if (!isJsonObject(operation)) continue;
    const body = bodySchemaFor(document, operation, "response", site.status);
    const within = [...parsePointer(site.prefix), ...segments];
    if (body === undefined || navigate(document, body, within) === undefined) {
      walked = false;
      break;
    }
    places.push({
      operation,
      status: site.status,
      path: `${site.prefix}${op.path}`,
    });
  }
  // Found by the schema's name alone: no site, so no status to follow.
  const written = statementInNew(newContract, routes, [], entry.name, undefined, op.path);
  const loosen = (root: JsonObject, path: string) => {
    if (op.op === "dropNull") {
      schemaSetNullable(document, root, path, true, written);
      return;
    }
    if (op.when !== "null") schemaSetRequired(document, root, path, false);
    if (op.when !== "absent") schemaSetNullable(document, root, path, true, written);
  };
  try {
    if (!walked) {
      const schemas = (document["components"] as JsonObject | undefined)?.["schemas"];
      const schema = isJsonObject(schemas) ? schemas[entry.name] : undefined;
      if (isJsonObject(schema)) loosen(schema, op.path);
      return;
    }
    for (const place of places) {
      loosen(ownBody(document, place.operation, place.status), place.path);
    }
  } catch (error) {
    issues.push({
      changeId: entry.changeId,
      message: `${op.op} on ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
