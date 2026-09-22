/**
 * Where the Swagger 2.0 upgrade is wrong about the API, put right.
 *
 * Every correction here was found by converting the corpus's real 2.0
 * documents with a second, independent converter and diffing the two results
 * (`proving/swagger/oracle.mts`), then reading the 2.0 source to see which one
 * described the provider's API. Each is applied to the upgrader's output
 * rather than by patching the upgrader, so a new release of it that fixes the
 * same thing makes the correction a no-op instead of a conflict, and the
 * regression tests say whether it did.
 */
import { isJsonObject, type JsonObject, type JsonValue } from "@invariant-app/ir";

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch"] as const;

function mediaTypes(value: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const types = value.filter((entry): entry is string => typeof entry === "string");
  return types.length > 0 ? types : undefined;
}

function parametersOf(pathItem: JsonObject, operation: JsonObject): JsonObject[] {
  return [
    ...(Array.isArray(pathItem["parameters"]) ? pathItem["parameters"] : []),
    ...(Array.isArray(operation["parameters"]) ? operation["parameters"] : []),
  ].filter(isJsonObject);
}

/**
 * An operation's own `produces` replaces the document's, as 2.0 defines it.
 * The upgrader reads them the other way round, so Gitea's raw file download,
 * which declares `application/octet-stream`, came out as JSON.
 */
function responseMediaTypes(source: JsonObject, operation: JsonObject): void {
  const produces = mediaTypes(source["produces"]);
  const responses = operation["responses"];
  if (produces === undefined || !isJsonObject(responses)) return;
  for (const response of Object.values(responses)) {
    if (!isJsonObject(response) || !isJsonObject(response["content"])) continue;
    const content = response["content"];
    const first = Object.values(content).find(isJsonObject);
    if (first === undefined) continue;
    response["content"] = Object.fromEntries(
      produces.map((type) => {
        const existing = content[type];
        // The schema is the response's, whatever it is written as; an example
        // belongs to the media type it was given for, and stays only there.
        const kept = isJsonObject(existing) ? existing : undefined;
        return [
          type,
          kept ?? (first["schema"] === undefined ? {} : { schema: first["schema"] }),
        ];
      }),
    );
  }
}

/**
 * A form with a required field is a required body. The upgrader carries
 * `required` over from a `body` parameter and not from `formData` ones, so a
 * request that leaves the whole form out looked allowed.
 */
function requiredForm(parameters: JsonObject[], operation: JsonObject): void {
  const body = operation["requestBody"];
  if (!isJsonObject(body) || body["required"] === true) return;
  if (
    parameters.some(
      (parameter) => parameter["in"] === "formData" && parameter["required"] === true,
    )
  ) {
    body["required"] = true;
  }
}

/**
 * `x-nullable`, the extension go-swagger and Docker use because 2.0 has no
 * way to say null is allowed, is what 3.0 calls `nullable`. Left as an
 * extension, every field Docker declares nullable reads as one that never is.
 */
function nullableFromExtension(value: JsonValue): void {
  if (Array.isArray(value)) {
    for (const item of value) nullableFromExtension(item);
    return;
  }
  if (!isJsonObject(value)) return;
  if (value["x-nullable"] === true) {
    // On a parameter, the upgrader has moved the type into its schema.
    const target =
      typeof value["in"] === "string" && isJsonObject(value["schema"])
        ? value["schema"]
        : value;
    target["nullable"] = true;
    delete value["x-nullable"];
  } else if (value["x-nullable"] === false) {
    delete value["x-nullable"];
  }
  for (const child of Object.values(value)) nullableFromExtension(child);
}

const REQUEST_BODIES = "#/components/requestBodies/";

const isBodyRef = (parameter: JsonValue): boolean =>
  isJsonObject(parameter) &&
  typeof parameter["$ref"] === "string" &&
  parameter["$ref"].startsWith(REQUEST_BODIES);

/**
 * A shared `in: body` parameter is the operation's body, in the media types
 * the operation consumes. The upgrader moves the parameter to
 * `components.requestBodies`, leaves every reference to it among the
 * parameters, where it names something that is not a parameter, and gives
 * the shared body one media type for every operation. Kubernetes shares one
 * `DeleteOptions` body across 183 operations that consume any media type, and
 * one patch body across 143 that consume five patch formats: every one was
 * unreadable to the differ, and would have been read as JSON.
 */
function bodyFromSharedParameter(
  converted: JsonObject,
  consumed: string[] | undefined,
  sourceItem: JsonObject,
  item: JsonObject,
): void {
  const withoutBody = (holder: JsonObject): JsonObject | undefined => {
    if (!Array.isArray(holder["parameters"])) return undefined;
    const parameters = holder["parameters"] as JsonValue[];
    const body = parameters.find(isBodyRef);
    if (body === undefined) return undefined;
    holder["parameters"] = parameters.filter((parameter) => !isBodyRef(parameter));
    if ((holder["parameters"] as JsonValue[]).length === 0) delete holder["parameters"];
    return body as JsonObject;
  };
  const shared = withoutBody(item);
  const components = converted["components"];
  const bodies = isJsonObject(components) ? components["requestBodies"] : undefined;
  for (const method of METHODS) {
    const operation = item[method];
    if (!isJsonObject(operation)) continue;
    // An operation's own body overrides one declared for the whole path.
    const reference = withoutBody(operation) ?? shared;
    if (reference === undefined || operation["requestBody"] !== undefined) continue;
    const name = (reference["$ref"] as string).slice(REQUEST_BODIES.length);
    const body = isJsonObject(bodies) ? bodies[name] : undefined;
    const content = isJsonObject(body) ? body["content"] : undefined;
    const first = isJsonObject(content) ? Object.values(content)[0] : undefined;
    const sourceOperation = sourceItem[method];
    const types =
      (isJsonObject(sourceOperation)
        ? mediaTypes(sourceOperation["consumes"])
        : undefined) ?? consumed;
    if (!isJsonObject(body) || !isJsonObject(first) || types === undefined) {
      operation["requestBody"] = { $ref: reference["$ref"] as string };
      continue;
    }
    operation["requestBody"] = {
      ...(body["description"] === undefined ? {} : { description: body["description"] }),
      content: Object.fromEntries(types.map((type) => [type, structuredClone(first)])),
      ...(body["required"] === true ? { required: true } : {}),
    };
  }
}

/** The upgrader's output, corrected against the 2.0 document it came from. Mutates `converted`. */
export function correctUpgrade(source: JsonObject, converted: JsonObject): void {
  const sourcePaths = source["paths"];
  const paths = converted["paths"];
  if (isJsonObject(sourcePaths) && isJsonObject(paths)) {
    for (const [path, sourceItem] of Object.entries(sourcePaths)) {
      const item = paths[path];
      if (!isJsonObject(sourceItem) || !isJsonObject(item)) continue;
      for (const method of METHODS) {
        const sourceOperation = sourceItem[method];
        const operation = item[method];
        if (!isJsonObject(sourceOperation) || !isJsonObject(operation)) continue;
        responseMediaTypes(sourceOperation, operation);
        requiredForm(parametersOf(sourceItem, sourceOperation), operation);
      }
    }
    for (const [path, sourceItem] of Object.entries(sourcePaths)) {
      const item = paths[path];
      if (isJsonObject(sourceItem) && isJsonObject(item)) {
        bodyFromSharedParameter(
          converted,
          mediaTypes(source["consumes"]),
          sourceItem,
          item,
        );
      }
    }
  }
  nullableFromExtension(converted);
}
