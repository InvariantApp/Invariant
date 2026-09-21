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
  /**
   * True for an entry under `webhooks` rather than `paths`.
   *
   * It travels with the operation because the difference matters downstream:
   * nothing calls a webhook, the provider sends it, so the request and response
   * middleware has no point at which to rewrite one. A change here is real and
   * worth reporting, and it cannot be adapted by this runtime.
   */
  webhook?: true;
}

/**
 * Places whose contents describe an API without constraining the wire, so a
 * reference that dangles inside one is not a reason to refuse the document.
 *
 * `stripNonWire` already leaves these out of the digest for the same reason.
 * Adyen publishes contracts that reference example components they never
 * define, 55 times in one of them, and refusing those cost real comparisons
 * over missing illustrations.
 */
const NON_WIRE_CONTAINERS = new Set(["examples", "example"]);

/**
 * External `$ref`s are refused rather than fetched. A provider spec is
 * untrusted input to the control plane, and resolving a remote reference would
 * turn parsing it into an outbound request.
 */
function collectRefs(value: JsonValue, found: Map<string, string[]>, where = "#"): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      collectRefs(item, found, `${where}/${index}`);
    }
    return;
  }
  if (!isJsonObject(value)) return;

  const ref = value["$ref"];
  if (typeof ref === "string") {
    if (!ref.startsWith("#/")) {
      throw new ContractError(`External $ref is not allowed at ${where}: ${ref}`);
    }
    const sites = found.get(ref);
    if (sites) sites.push(where);
    else found.set(ref, [where]);
  }
  for (const [key, child] of Object.entries(value)) {
    if (NON_WIRE_CONTAINERS.has(key)) continue;
    collectRefs(child, found, `${where}/${key}`);
  }
}

/**
 * Every internal `$ref` must point at something that exists.
 *
 * A document with a dangling reference is not a document this system can reason
 * about: the schema behind a field is simply missing, so no site resolves and
 * no closure check means anything. It also is not hypothetical. Intercom's
 * published contract references `#/components/schemas/custom_attributes` from
 * four places and defines 213 schemas, none of them that one.
 *
 * The reason this is checked here rather than left to the differ is what the
 * differ says about it: `exited with 102`. A provider reading that learns
 * nothing, and the gate that produced it looks broken rather than the document
 * it was given.
 */
function assertRefsResolve(document: OpenApiDocument): void {
  const found = new Map<string, string[]>();
  collectRefs(document, found);

  const dangling = [...found].filter(([ref]) => resolveRef(document, ref) === undefined);
  if (dangling.length === 0) return;

  const [firstRef, sites] = dangling[0] as [string, string[]];
  const more =
    dangling.length > 1
      ? ` (and ${dangling.length - 1} other unresolved reference${dangling.length > 2 ? "s" : ""})`
      : "";
  throw new ContractError(
    `\`${firstRef}\` is referenced but not defined, from ${sites.length} ` +
      `place${sites.length === 1 ? "" : "s"} including ${sites[0]}${more}. ` +
      "The document has to define everything it points at before it can be compared.",
  );
}

/**
 * Path templates that are the same endpoint once the parameter names come out.
 *
 * Reported rather than refused, which is a correction. Refusing them looked
 * right: a request for `/v1/x/dataExchanges` matches both
 * `/v1/{organization}/dataExchanges` and `/v1/{parent}/dataExchanges`, so there
 * is no fact about which operation it belongs to. But real providers ship this
 * deliberately and it mostly works, because the value's own shape tells the two
 * apart. GitHub declares `/orgs/{org}/attestations/{attestation_id}` beside
 * `/orgs/{org}/attestations/{subject_digest}`, and refusing that traded one
 * Google document for seven GitHub ones that had been comparing fine.
 *
 * So this is used to explain a failure rather than to cause one. The differ
 * refuses some of these itself, with `exited with 104`, and this turns that
 * number into a sentence.
 */
export function ambiguousPaths(document: OpenApiDocument): string[][] {
  const paths = document["paths"];
  if (!isJsonObject(paths)) return [];

  const byShape = new Map<string, string[]>();
  for (const path of Object.keys(paths)) {
    const shape = path.replace(/\{[^}]*\}/g, "{}");
    const seen = byShape.get(shape);
    if (seen) seen.push(path);
    else byShape.set(shape, [path]);
  }
  return [...byShape.values()].filter((group) => group.length > 1);
}

export function normalizeDocument(document: OpenApiDocument): OpenApiDocument {
  assertRefsResolve(document);
  const version = document["openapi"];
  if (typeof version !== "string" || !version.startsWith("3.")) {
    throw new ContractError(`Only OpenAPI 3.x is supported, got ${String(version)}`);
  }
  // A 3.1 document may carry `webhooks` instead of `paths`, and real ones do:
  // Adyen publishes its notification contracts that way. Such a document is
  // loaded and compared like any other. What cannot be done is adapting one at
  // request time, and that is refused where the adapter is built rather than
  // here, so a provider still gets told what changed.
  if (!isJsonObject(document["paths"]) && !isJsonObject(document["webhooks"])) {
    throw new ContractError("Document has no paths or webhooks object");
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
  const paths = isJsonObject(document["paths"]) ? document["paths"] : {};
  const webhooks = isJsonObject(document["webhooks"]) ? document["webhooks"] : {};

  // Named the way the differ names them, so a delta it reports against
  // `webhook:AUTHORISATION` lines up with the operation found here instead of
  // looking like a delta about an endpoint nobody declared.
  const entries: [string, JsonValue, boolean][] = [
    ...Object.keys(paths)
      .sort()
      .map((path): [string, JsonValue, boolean] => [
        path,
        paths[path] as JsonValue,
        false,
      ]),
    ...Object.keys(webhooks)
      .sort()
      .map((name): [string, JsonValue, boolean] => [
        `webhook:${name}`,
        webhooks[name] as JsonValue,
        true,
      ]),
  ];

  const out: OperationRef[] = [];
  for (const [path, rawItem, isWebhook] of entries) {
    const item = rawItem;
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
      out.push({
        operationId,
        method,
        path,
        operation,
        ...(isWebhook ? { webhook: true as const } : {}),
      });
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
