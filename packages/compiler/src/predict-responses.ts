/**
 * A Change to one operation's response body where the body's schema is
 * written in place, predicted into the operation's own copy of it.
 *
 * The same schema ops as anywhere else, rooted at the body. What differs is
 * finding the body: the operation the old one's calls now reach, its response
 * at the status the scope names, and that response's own copy, so a response
 * shared from `components/responses` is not changed for every operation that
 * uses it. A body that is a named schema is refused, because a schema scope
 * says the same thing for every place the schema is used.
 */
import {
  bodySchemaFor,
  type OpenApiDocument,
  operationsOf,
  resolveRef,
  resolveSchema,
} from "@invariant/contract";
import {
  type DataOp,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  parsePointer,
  type ResponseScope,
} from "@invariant/ir";
import { importReferences } from "./import.ts";
import { operationById } from "./parameters.ts";
import { mapEndpoint, type PredictionIssue, type RouteMapping } from "./predict.ts";
import {
  SchemaOpError,
  schemaAdd,
  schemaConvert,
  schemaMove,
  schemaRelax,
  schemaRemove,
  schemaSetNullable,
  schemaSetRequired,
  schemaWiden,
} from "./schema.ts";

/** The JSON representation a response is served in, or the only one it has. */
function mediaOf(content: JsonObject): JsonObject | undefined {
  const json = Object.entries(content).find(
    ([type, media]) => isJsonObject(media) && /[/+]json(;|$)/.test(type),
  );
  return json && isJsonObject(json[1]) ? json[1] : undefined;
}

/**
 * The body schema of `status` on the predicted operation, as the operation's
 * own, or the reason there is none to change.
 */
function ownBody(
  document: OpenApiDocument,
  operation: JsonObject,
  status: string,
): JsonObject {
  const responses = operation["responses"];
  if (!isJsonObject(responses)) throw new SchemaOpError("the operation has no responses");
  let response = responses[status];
  if (response === undefined)
    throw new SchemaOpError(`the operation has no ${status} response`);
  // Always this operation's own copy: a response shared from components, or
  // one object reused by two operations, must not change for the other.
  const declared =
    isJsonObject(response) && typeof response["$ref"] === "string"
      ? resolveRef(document, response["$ref"])
      : response;
  response = isJsonObject(declared)
    ? (JSON.parse(JSON.stringify(declared)) as JsonObject)
    : undefined;
  if (response !== undefined) responses[status] = response;
  const content = isJsonObject(response) ? response["content"] : undefined;
  const media = isJsonObject(content) ? mediaOf(content) : undefined;
  const schema = media?.["schema"];
  if (!isJsonObject(schema))
    throw new SchemaOpError(`the ${status} response has no JSON body`);
  if (typeof schema["$ref"] === "string") {
    throw new SchemaOpError(
      `the ${status} response's body is ${schema["$ref"]}; a Change to it is scoped to that schema`,
    );
  }
  return schema;
}

/**
 * The field as the new contract declares it in the response at the same
 * place, reference and all, and whether it is required there.
 */
function shapeInNew(
  newContract: OpenApiDocument,
  method: string,
  path: string,
  status: string,
  pointer: string,
): { shape: JsonValue; required: boolean } | undefined {
  const operation = operationsOf(newContract).find(
    (candidate) => candidate.method === method && candidate.path === path,
  );
  if (!operation) return undefined;
  let declared = bodySchemaFor(newContract, operation.operation, "response", status);
  let required = false;
  for (const segment of parsePointer(pointer)) {
    // Walked as the differ reads it: references followed, `allOf` merged.
    const parent = resolveSchema(newContract, declared ?? {});
    const properties = isJsonObject(parent) ? parent["properties"] : undefined;
    if (!isJsonObject(properties) || properties[segment] === undefined) return undefined;
    declared = properties[segment];
    required =
      isJsonObject(parent) &&
      Array.isArray(parent["required"]) &&
      (parent["required"] as JsonValue[]).includes(segment);
  }
  return declared === undefined ? undefined : { shape: declared, required };
}

export function applyResponseScope(
  document: OpenApiDocument,
  oldContract: OpenApiDocument,
  newContract: OpenApiDocument,
  routes: readonly RouteMapping[],
  scope: ResponseScope,
  ops: readonly DataOp[],
  issues: PredictionIssue[],
  changeId: string,
): void {
  const refuse = (message: string) => issues.push({ changeId, message });
  const old = operationById(oldContract, scope.operation);
  if (!old) {
    refuse(`no operation called ${scope.operation} to scope a response change to`);
    return;
  }
  const target = mapEndpoint(routes, old.method, old.path);
  const paths = document["paths"];
  const item = isJsonObject(paths) ? paths[target.path] : undefined;
  const operation = isJsonObject(item) ? item[target.method] : undefined;
  if (!isJsonObject(operation)) {
    refuse(`${scope.operation} has no operation in the predicted contract`);
    return;
  }
  let root: JsonObject;
  try {
    root = ownBody(document, operation, scope.response);
  } catch (error) {
    refuse(
      `${scope.operation} ${scope.response}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  for (const op of ops) {
    try {
      switch (op.op) {
        case "move":
          schemaMove(document, root, op.from, op.to);
          break;
        case "convert":
          schemaConvert(document, root, op.path, op.codec);
          break;
        case "remove":
          schemaRemove(document, root, op.path);
          break;
        case "add": {
          const found = shapeInNew(
            newContract,
            target.method,
            target.path,
            scope.response,
            op.path,
          );
          if (!found) {
            throw new SchemaOpError(
              `the new contract's ${scope.response} response has no ${op.path}`,
            );
          }
          importReferences(document, newContract, found.shape);
          schemaAdd(document, root, op.path, found.shape, found.required);
          break;
        }
        case "default": {
          const looser = op.toward === "old";
          if (op.when !== "null") schemaSetRequired(document, root, op.path, !looser);
          if (op.when !== "absent") schemaSetNullable(document, root, op.path, looser);
          break;
        }
        case "dropNull":
          schemaSetNullable(document, root, op.path, op.toward === "old");
          break;
        case "relax":
          // A response is never sent by an old caller, so a bound may move
          // either way.
          schemaRelax(
            document,
            root,
            op.path,
            op.set as Record<string, JsonValue>,
            false,
          );
          break;
        case "widen":
          if (resolveRef(newContract, op.variant) === undefined) {
            throw new SchemaOpError(`${op.variant} is not in the new contract`);
          }
          importReferences(document, newContract, { $ref: op.variant });
          schemaWiden(document, root, op.path, op.variant, op.show);
          break;
      }
    } catch (error) {
      refuse(
        `${op.op} on ${scope.operation}'s ${scope.response} response: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
