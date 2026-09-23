/**
 * Replaying parameter-scoped Changes over the predicted document.
 *
 * Each op edits the one operation its scope names, found where earlier route
 * changes moved it, and only that operation: a parameter declared once for a
 * whole path, or shared through a reference, is copied into the operation
 * before it is touched, so no other operation changes with it.
 *
 * Anything that appears, a new parameter or a field a parameter moved into,
 * takes its declaration from the new contract. The op says only that it
 * moved or arrived; how it is declared is the provider's own statement, and
 * inventing one here would make closure prove whatever was invented.
 */
import {
  bodySchemaFor,
  FORM_MEDIA_TYPE,
  jsonMedia,
  type OpenApiDocument,
  operationsOf,
  resolveRef,
  resolveSchema,
} from "@invariant-app/contract";
import {
  type DataOp,
  HTTP_METHODS,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  narrows,
  type ParameterLocation,
  type ParameterScope,
  parsePointer,
} from "@invariant-app/ir";
import { importReferences } from "./import.ts";
import { PATH_PARAMETER_REFUSAL, servesPathParameter } from "./lens.ts";
import {
  addressOf,
  envelopePointer,
  findParameter,
  operationById,
} from "./parameters.ts";
import { mapEndpoint, type PredictionIssue, type RouteMapping } from "./predict.ts";
import { proveRestated } from "./restate.ts";
import {
  applyCodecToSchema,
  relaxTypes,
  SchemaOpError,
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
  setNullable,
} from "./schema.ts";

interface Located {
  item: JsonObject;
  operation: JsonObject;
  method: string;
  path: string;
}

/** The predicted operation an old operation's calls now reach. */
function locate(
  document: OpenApiDocument,
  oldContract: OpenApiDocument,
  routes: readonly RouteMapping[],
  operationId: string,
): Located | undefined {
  const old = operationById(oldContract, operationId);
  if (!old) return undefined;
  const target = mapEndpoint(routes, old.method, old.path);
  const paths = document["paths"];
  const item = isJsonObject(paths) ? paths[target.path] : undefined;
  const operation = isJsonObject(item) ? item[target.method] : undefined;
  if (!isJsonObject(item) || !isJsonObject(operation)) return undefined;
  return { item, operation, method: target.method, path: target.path };
}

/**
 * The operation's parameters as a list it owns outright.
 *
 * Parameters declared for the whole path are copied into every operation of
 * that path first, which describes exactly the same API, so that changing
 * one operation's copy cannot change another's.
 */
function ownParameters(document: OpenApiDocument, located: Located): JsonObject[] {
  const shared = located.item["parameters"];
  if (Array.isArray(shared) && shared.length > 0) {
    for (const method of HTTP_METHODS) {
      const value = located.item[method];
      if (!isJsonObject(value)) continue;
      const own = Array.isArray(value["parameters"])
        ? (value["parameters"] as JsonValue[])
        : [];
      const inherited = shared.filter((entry) => {
        const resolved = resolveEntry(document, entry);
        return !own.some((mine) => {
          const other = resolveEntry(document, mine);
          return (
            resolved !== undefined &&
            other !== undefined &&
            other["in"] === resolved["in"] &&
            other["name"] === resolved["name"]
          );
        });
      });
      value["parameters"] = [...structuredClone(inherited), ...own];
    }
    delete located.item["parameters"];
  }
  const list = Array.isArray(located.operation["parameters"])
    ? (located.operation["parameters"] as JsonValue[])
    : [];
  // References are replaced with this operation's own copies, for the same
  // reason: a shared parameter changed in place changes everywhere.
  const owned = list.flatMap((entry) => {
    const resolved = resolveEntry(document, entry);
    return resolved ? [structuredClone(resolved)] : [];
  });
  located.operation["parameters"] = owned;
  return owned;
}

function resolveEntry(document: OpenApiDocument, entry: unknown): JsonObject | undefined {
  if (!isJsonObject(entry)) return undefined;
  const ref = entry["$ref"];
  if (typeof ref !== "string") return entry;
  const target = resolveRef(document, ref);
  return isJsonObject(target) ? target : undefined;
}

/** The new contract's declaration of a parameter, where the old one's calls now land. */
function declaredInNew(
  newContract: OpenApiDocument,
  located: Located,
  location: ParameterLocation,
  name: string,
): JsonObject | undefined {
  const paths = newContract["paths"];
  const item = isJsonObject(paths) ? paths[located.path] : undefined;
  if (!isJsonObject(item)) return undefined;
  const operation = item[located.method];
  const lists = [
    item["parameters"],
    isJsonObject(operation) ? operation["parameters"] : [],
  ];
  const all = lists.flatMap((list) =>
    (Array.isArray(list) ? list : []).flatMap((entry) => {
      const resolved = resolveEntry(newContract, entry);
      return resolved ? [resolved] : [];
    }),
  );
  return findParameter(all, location, name);
}

/** The JSON request body schema's holder on an operation this change owns, made if asked. */
function bodyHolder(
  document: OpenApiDocument,
  operation: JsonObject,
  create: boolean,
): JsonObject | undefined {
  let body = operation["requestBody"];
  if (isJsonObject(body) && typeof body["$ref"] === "string") {
    const resolved = resolveRef(document, body["$ref"]);
    body = isJsonObject(resolved) ? structuredClone(resolved) : undefined;
    if (body !== undefined) operation["requestBody"] = body;
  }
  if (!isJsonObject(body)) {
    if (!create) return undefined;
    body = {
      content: { "application/json": { schema: { type: "object", properties: {} } } },
    };
    operation["requestBody"] = body;
  }
  const content = (body as JsonObject)["content"];
  // The JSON representation where there is one, otherwise the form: a form
  // describes its fields exactly as JSON does.
  const holder = isJsonObject(content)
    ? (jsonMedia(content)?.media ?? content[FORM_MEDIA_TYPE])
    : undefined;
  if (!isJsonObject(holder) || !isJsonObject(holder["schema"])) {
    if (!create) return undefined;
    throw new SchemaOpError(
      "the request body is neither JSON nor a form, so nothing can move into it",
    );
  }
  return holder["schema"] as JsonObject;
}

/** A body field's declaration in the new contract, where the operation now lives. */
function bodyShapeInNew(
  newContract: OpenApiDocument,
  located: Located,
  segments: readonly string[],
): { shape: JsonValue; required: boolean } | undefined {
  const operation = operationsOf(newContract).find(
    (candidate) => candidate.method === located.method && candidate.path === located.path,
  );
  if (!operation) return undefined;
  const body = bodySchemaFor(newContract, operation.operation, "request");
  if (body === undefined) return undefined;
  let current: JsonValue | undefined = resolveSchema(newContract, body);
  let parent: JsonValue | undefined;
  for (const segment of segments) {
    parent = current;
    if (!isJsonObject(current) || !isJsonObject(current["properties"])) return undefined;
    const next = (current["properties"] as JsonObject)[segment];
    if (next === undefined) return undefined;
    current = resolveSchema(newContract, next);
  }
  if (current === undefined) return undefined;
  const name = segments[segments.length - 1] as string;
  const required =
    isJsonObject(parent) &&
    Array.isArray(parent["required"]) &&
    (parent["required"] as JsonValue[]).includes(name);
  return { shape: current, required };
}

export function applyParameterScope(
  document: OpenApiDocument,
  oldContract: OpenApiDocument,
  newContract: OpenApiDocument,
  routes: readonly RouteMapping[],
  scope: ParameterScope,
  ops: readonly DataOp[],
  issues: PredictionIssue[],
  changeId: string,
): void {
  const refuse = (message: string) => issues.push({ changeId, message });
  const located = locate(document, oldContract, routes, scope.operation);
  if (!located) {
    refuse(`no operation called ${scope.operation} to scope a parameter change to`);
    return;
  }

  for (const op of ops) {
    try {
      applyOne(document, newContract, located, scope, op);
    } catch (error) {
      refuse(
        `${op.op} on ${scope.operation}'s ${scope.location} parameters: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * An op on the operation's own request body, declared inline rather than as
 * a named schema, applied through the same schema edits a schema scope uses.
 */
function applyToBody(
  document: OpenApiDocument,
  newContract: OpenApiDocument,
  located: Located,
  op: DataOp,
): void {
  const root = bodyHolder(document, located.operation, false);
  if (!root) throw new SchemaOpError("the operation has no request body to change");
  switch (op.op) {
    case "move":
      schemaMove(document, root, op.from, op.to);
      return;
    case "convert":
      schemaConvert(document, root, op.path, op.codec);
      return;
    case "remove":
      schemaRemove(document, root, op.path);
      return;
    case "add": {
      const shape = bodyShapeInNew(newContract, located, parsePointer(op.path));
      if (!shape)
        throw new SchemaOpError(`the new contract's request body has no ${op.path}`);
      importReferences(document, newContract, shape.shape);
      schemaAdd(document, root, op.path, shape.shape, shape.required);
      return;
    }
    case "default": {
      const looser = op.toward === "old";
      if (op.when !== "null") schemaSetRequired(document, root, op.path, !looser);
      if (op.when !== "absent") schemaSetNullable(document, root, op.path, looser);
      return;
    }
    case "dropNull":
      if (op.toward === "new" && schemaRequiredAt(document, root, op.path)) {
        throw new SchemaOpError(
          `${op.path} is required, so a null cannot be sent as it left out`,
        );
      }
      schemaSetNullable(document, root, op.path, op.toward === "old");
      return;
    case "relax":
      // An operation's own body is only ever sent by old callers.
      schemaRelax(document, root, op.path, op.set as Record<string, JsonValue>, true);
      return;
    case "restate": {
      // Only ever sent by old callers, so what they send has to be shown to
      // be what the new contract accepts, as the body stands at this op.
      const segments = parsePointer(op.path);
      const next = bodyShapeInNew(newContract, located, segments);
      const before = bodyShapeInNew(document, located, segments);
      if (!next || !before) {
        throw new SchemaOpError(
          `the ${next ? "old" : "new"} contract's request body has no ${op.path || "schema"}`,
        );
      }
      proveRestated(
        { document, schema: before.shape },
        { document: newContract, schema: next.shape },
        { request: true, response: false },
        `the request body${op.path ? ` at ${op.path}` : ""}`,
      );
      importReferences(document, newContract, next.shape);
      schemaRestate(document, root, op.path, next.shape);
      return;
    }
    case "widen":
      // A request body that accepts one more kind of value breaks nobody,
      // but saying so is still a true account of what changed.
      if (resolveRef(newContract, op.variant) === undefined) {
        throw new SchemaOpError(`${op.variant} is not in the new contract`);
      }
      importReferences(document, newContract, { $ref: op.variant });
      schemaWiden(document, root, op.path, op.variant, op.show);
      return;
  }
}

function applyOne(
  document: OpenApiDocument,
  newContract: OpenApiDocument,
  located: Located,
  scope: ParameterScope,
  op: DataOp,
): void {
  if (scope.location === "body") {
    applyToBody(document, newContract, located, op);
    return;
  }
  const params = ownParameters(document, located);
  const at = (pointer: string) => {
    const address = addressOf(envelopePointer(scope.location, pointer));
    const segments = parsePointer(address.pointer).slice(1);
    if (address.part !== "body" && segments.length !== 1) {
      throw new SchemaOpError(`${pointer} must name one parameter, not a part of one`);
    }
    return { address, segments };
  };
  const indexOf = (location: ParameterLocation, name: string) =>
    params.findIndex(
      (parameter) =>
        parameter["in"] === location &&
        (location === "header"
          ? String(parameter["name"]).toLowerCase() === name
          : parameter["name"] === name),
    );
  const existing = (location: ParameterLocation, name: string): JsonObject => {
    const index = indexOf(location, name);
    if (index === -1) {
      throw new SchemaOpError(`there is no ${location} parameter called ${name}`);
    }
    return params[index] as JsonObject;
  };
  const schemaOf = (parameter: JsonObject): JsonObject => {
    const schema = parameter["schema"];
    if (!isJsonObject(schema)) throw new SchemaOpError("the parameter has no schema");
    // Its own copy, so a referenced schema is not changed for anyone else.
    const resolved = resolveSchema(document, schema);
    const owned = structuredClone(isJsonObject(resolved) ? resolved : schema);
    parameter["schema"] = owned;
    return owned;
  };

  if (op.op === "move") {
    const from = at(op.from);
    const to = at(op.to);
    if (from.address.part === "path" || to.address.part === "path") {
      throw new SchemaOpError(
        "a path parameter is renamed by a route change, not a move",
      );
    }
    if (from.address.part === "body") {
      throw new SchemaOpError(
        "a body field moves with a schema scope, not a parameter scope",
      );
    }
    const name = from.address.name as string;
    const index = indexOf(from.address.part, name);
    if (index === -1) {
      throw new SchemaOpError(
        `there is no ${from.address.part} parameter called ${name}`,
      );
    }
    const parameter = params[index] as JsonObject;
    if (to.address.part === "body") {
      const shape = bodyShapeInNew(newContract, located, to.segments);
      if (!shape) {
        throw new SchemaOpError(
          `the new contract's request body has no ${op.to.slice(1)}`,
        );
      }
      params.splice(index, 1);
      const root = bodyHolder(document, located.operation, true) as JsonObject;
      importReferences(document, newContract, shape.shape);
      schemaAdd(document, root, `/${to.segments.join("/")}`, shape.shape, shape.required);
      return;
    }
    const target = to.address.part;
    const renamed = to.address.name as string;
    parameter["name"] = renamed;
    if (parameter["in"] !== target) {
      parameter["in"] = target;
      // How a parameter is written depends on where it is, so the new
      // location's style is the one its declaration there states.
      const declared = declaredInNew(newContract, located, target, renamed);
      for (const key of ["style", "explode", "allowReserved"]) {
        if (declared?.[key] !== undefined) parameter[key] = declared[key] as JsonValue;
        else delete parameter[key];
      }
    }
    return;
  }

  const { address } = at(op.path);
  if (address.part === "body") {
    throw new SchemaOpError(
      `a body field is changed with a schema scope, not a parameter scope`,
    );
  }
  const name = address.name as string;
  if (address.part === "path" && !servesPathParameter(op)) {
    throw new SchemaOpError(PATH_PARAMETER_REFUSAL);
  }

  switch (op.op) {
    case "convert": {
      const parameter = existing(address.part, name);
      const converted = applyCodecToSchema(schemaOf(parameter), op.codec, document);
      parameter["schema"] = converted;
      return;
    }
    case "add": {
      if (indexOf(address.part, name) !== -1) {
        throw new SchemaOpError(`the ${address.part} parameter ${name} already exists`);
      }
      const declared = declaredInNew(newContract, located, address.part, name);
      if (!declared) {
        throw new SchemaOpError(
          `the new contract declares no ${address.part} parameter ${name}`,
        );
      }
      importReferences(document, newContract, declared);
      params.push(structuredClone(declared));
      return;
    }
    case "remove": {
      const index = indexOf(address.part, name);
      if (index === -1) {
        throw new SchemaOpError(`there is no ${address.part} parameter called ${name}`);
      }
      params.splice(index, 1);
      return;
    }
    case "default": {
      if (op.toward === "old") {
        throw new SchemaOpError(
          "a parameter is only ever sent, never received, so there is nothing to fill in toward old callers",
        );
      }
      const parameter = existing(address.part, name);
      if (op.when !== "null") parameter["required"] = true;
      if (op.when !== "absent") setNullable(document, schemaOf(parameter), false, name);
      return;
    }
    case "widen":
      throw new SchemaOpError(
        "a parameter is only ever sent, and a caller never sends a kind of value its contract does not describe",
      );
    case "restate": {
      // A parameter is only ever sent: every value old callers send has to be
      // shown to be one the new declaration accepts.
      const parameter = existing(address.part, name);
      const declared = declaredInNew(newContract, located, address.part, name);
      if (!declared || declared["schema"] === undefined) {
        throw new SchemaOpError(
          `the new contract declares no ${address.part} parameter ${name} to restate it as`,
        );
      }
      const next = resolveSchema(newContract, declared["schema"] as JsonValue);
      proveRestated(
        { document, schema: parameter["schema"] as JsonValue },
        { document: newContract, schema: next },
        { request: true, response: false },
        `the ${address.part} parameter ${name}`,
      );
      importReferences(document, newContract, next);
      parameter["schema"] = structuredClone(next);
      return;
    }
    case "relax": {
      // A parameter is only ever sent, so a bound may widen and never narrow.
      const parameter = existing(address.part, name);
      const schema = schemaOf(parameter);
      for (const [keyword, value] of Object.entries(op.set) as [string, JsonValue][]) {
        if (keyword === "type" && Array.isArray(value)) {
          relaxTypes(schema, value as string[], name);
          continue;
        }
        if (narrows(keyword, schema[keyword], value)) {
          throw new SchemaOpError(
            `${name} now allows less (${keyword}), so old callers would be refused for what their contract allowed`,
          );
        }
        if (value === null) delete schema[keyword];
        else schema[keyword] = value;
      }
      return;
    }
    case "dropNull": {
      if (op.toward === "old") {
        throw new SchemaOpError(
          "a parameter is only ever sent, never received, so there is no null to keep from old callers",
        );
      }
      const parameter = existing(address.part, name);
      if (parameter["required"] === true) {
        throw new SchemaOpError(
          `${name} is required, so a null cannot be sent as it left out`,
        );
      }
      setNullable(document, schemaOf(parameter), false, name);
      return;
    }
  }
}
