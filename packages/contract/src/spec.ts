import { readFile } from "node:fs/promises";
import { isJsonObject, type JsonObject, type JsonValue } from "@invariant/ir";
import { parse as parseYaml } from "yaml";
import { digestOf, stripNonWire } from "./canonical.ts";

export type OpenApiDocument = JsonObject;

export const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

export interface Contract {
  label: string;
  digest: string;
  document: OpenApiDocument;
}

export interface OperationRef {
  operationId: string;
  method: HttpMethod;
  path: string;
  operation: JsonObject;
}

/**
 * External `$ref`s are refused rather than fetched. A provider spec is
 * untrusted input to the control plane, and resolving a remote reference would
 * turn parsing it into an outbound request.
 */
function assertNoExternalRefs(value: JsonValue, where = "#"): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoExternalRefs(item, `${where}/${index}`);
    }
    return;
  }
  if (!isJsonObject(value)) return;

  const ref = value["$ref"];
  if (typeof ref === "string" && !ref.startsWith("#/")) {
    throw new ContractError(`External $ref is not allowed at ${where}: ${ref}`);
  }
  for (const [key, child] of Object.entries(value)) {
    assertNoExternalRefs(child, `${where}/${key}`);
  }
}

export function normalizeDocument(document: OpenApiDocument): OpenApiDocument {
  assertNoExternalRefs(document);
  const version = document["openapi"];
  if (typeof version !== "string" || !version.startsWith("3.")) {
    throw new ContractError(`Only OpenAPI 3.x is supported, got ${String(version)}`);
  }
  if (!isJsonObject(document["paths"])) {
    // A 3.1 document may describe webhooks instead of paths, and several real
    // ones do: Adyen publishes its notification contracts that way. Those are
    // valid documents this system does not cover yet, and saying "no paths
    // object" reads as if they were malformed.
    if (isJsonObject(document["webhooks"])) {
      throw new ContractError(
        "Document describes webhooks rather than paths. Outbound webhooks are " +
          "not supported yet, so there is no request path to adapt.",
      );
    }
    throw new ContractError("Document has no paths object");
  }
  return document;
}

export function contractOf(label: string, document: OpenApiDocument): Contract {
  const normalized = normalizeDocument(document);
  return {
    label,
    digest: digestOf(stripNonWire(normalized)),
    document: normalized,
  };
}

export async function loadContract(path: string, label: string): Promise<Contract> {
  const text = await readFile(path, "utf8");
  const parsed: unknown = path.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  if (!isJsonObject(parsed)) {
    throw new ContractError(`${path} does not contain an OpenAPI document`);
  }
  return contractOf(label, parsed);
}

export function schemasOf(document: OpenApiDocument): JsonObject {
  const components = document["components"];
  if (!isJsonObject(components)) return {};
  const schemas = components["schemas"];
  return isJsonObject(schemas) ? schemas : {};
}

/** Every operation in the document, in a stable order. */
export function operationsOf(document: OpenApiDocument): OperationRef[] {
  const paths = document["paths"];
  if (!isJsonObject(paths)) return [];

  const out: OperationRef[] = [];
  for (const path of Object.keys(paths).sort()) {
    const item = paths[path];
    if (!isJsonObject(item)) continue;
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!isJsonObject(operation)) continue;
      // `operationId` is optional in OpenAPI and plenty of real documents
      // leave it out. Refusing them was a limitation of this code rather than
      // a fact about the document, and it stopped a real specification dead
      // the first time one was tried. Method and path already identify an
      // operation uniquely, so a missing id is derived rather than demanded.
      const declared = operation["operationId"];
      const operationId =
        typeof declared === "string" && declared !== ""
          ? declared
          : `${method}${path.replace(/[^a-zA-Z0-9]+/g, "_").replace(/_+$/, "")}`;
      out.push({ operationId, method, path, operation });
    }
  }
  return out;
}

export function resolveRef(
  document: OpenApiDocument,
  ref: string,
): JsonValue | undefined {
  if (!ref.startsWith("#/")) return undefined;
  let current: JsonValue = document;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isJsonObject(current)) return undefined;
    const next: JsonValue | undefined = current[key];
    if (next === undefined) return undefined;
    current = next;
  }
  return current;
}

/** Follows a chain of `$ref`s to the object they ultimately point at. */
export function deref(document: OpenApiDocument, value: JsonValue): JsonValue {
  let current = value;
  for (let hops = 0; hops < 32; hops += 1) {
    if (!isJsonObject(current)) return current;
    const ref = current["$ref"];
    if (typeof ref !== "string") return current;
    const next = resolveRef(document, ref);
    if (next === undefined) throw new ContractError(`Unresolvable $ref: ${ref}`);
    current = next;
  }
  throw new ContractError("$ref chain is too deep");
}

/** The `application/json` schema of an operation's request body, if it has one. */
export function requestBodySchema(
  document: OpenApiDocument,
  operation: JsonObject,
): JsonValue | undefined {
  const body = deref(document, operation["requestBody"] ?? null);
  if (!isJsonObject(body)) return undefined;
  const content = body["content"];
  if (!isJsonObject(content)) return undefined;
  const json = content["application/json"];
  if (!isJsonObject(json)) return undefined;
  return json["schema"];
}

export interface ResponseSchema {
  status: string;
  schema: JsonValue;
}

export function responseSchemas(
  document: OpenApiDocument,
  operation: JsonObject,
): ResponseSchema[] {
  const responses = operation["responses"];
  if (!isJsonObject(responses)) return [];

  const out: ResponseSchema[] = [];
  for (const status of Object.keys(responses).sort()) {
    const response = deref(document, responses[status] as JsonValue);
    if (!isJsonObject(response)) continue;
    const content = response["content"];
    if (!isJsonObject(content)) continue;
    const json = content["application/json"];
    if (!isJsonObject(json)) continue;
    const schema = json["schema"];
    if (schema === undefined) continue;
    out.push({ status, schema });
  }
  return out;
}
