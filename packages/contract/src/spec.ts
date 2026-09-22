import { readFile } from "node:fs/promises";
import {
  HTTP_METHODS,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "@invariant-app/ir";
import { upgradeFromTwoToThree } from "@scalar/openapi-upgrader/2.0-to-3.0";
import { BundleError, bundleDocument } from "./bundle.ts";
import { digestOf, stripNonWire } from "./canonical.ts";
import { DocumentTooLargeError, parseDocumentText } from "./parse.ts";
import { correctUpgrade } from "./swagger.ts";

export type OpenApiDocument = JsonObject;

export { HTTP_METHODS };
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
  /**
   * Set when the document was converted before anything read it, and by
   * what, so a digest or a report can always be traced to the bytes the
   * provider actually published.
   */
  convertedFrom?: { format: "swagger-2.0"; by: string };
}

/** What converts a Swagger 2.0 document, pinned and named in every contract it produced. */
export const SWAGGER_CONVERTER =
  "@scalar/openapi-upgrader@0.2.16 2.0-to-3.0, with Invariant's corrections 1";

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

/** A key as a JSON Pointer segment writes it. */
function pointerSegment(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** Keywords whose value is one schema, which a list cannot be. */
const ONE_SCHEMA = ["items", "additionalProperties", "not"] as const;
/** Keywords whose value is a list of schemas, or a map of them. */
const SCHEMA_LISTS = ["allOf", "anyOf", "oneOf"] as const;
const SCHEMA_MAPS = ["properties", "patternProperties"] as const;

/**
 * The first place a schema holds a list where OpenAPI takes one schema.
 *
 * Slack's document writes `items: [{ $ref: message }, { type: "null" }]`,
 * JSON Schema draft 4's positional tuple, which neither Swagger 2.0 nor
 * OpenAPI 3.0 has. The differ refuses it with an exit code; saying where and
 * why is the difference between a provider fixing it and giving up. What the
 * author meant is not guessed at: "the first item is a message and the second
 * is null" and "each item is a message or null" are different APIs.
 */
function misplacedList(
  schema: JsonValue,
  at: string,
  seen: Set<JsonValue>,
): string | undefined {
  if (!isJsonObject(schema) || seen.has(schema)) return undefined;
  seen.add(schema);
  for (const keyword of ONE_SCHEMA) {
    const value = schema[keyword];
    if (Array.isArray(value)) return `${at}/${keyword}`;
    const inner =
      value === undefined ? undefined : misplacedList(value, `${at}/${keyword}`, seen);
    if (inner) return inner;
  }
  for (const keyword of SCHEMA_LISTS) {
    const value = schema[keyword];
    if (!Array.isArray(value)) continue;
    for (const [index, branch] of value.entries()) {
      const inner = misplacedList(branch, `${at}/${keyword}/${index}`, seen);
      if (inner) return inner;
    }
  }
  for (const keyword of SCHEMA_MAPS) {
    const value = schema[keyword];
    if (!isJsonObject(value)) continue;
    for (const [name, child] of Object.entries(value)) {
      const inner = misplacedList(
        child,
        `${at}/${keyword}/${pointerSegment(name)}`,
        seen,
      );
      if (inner) return inner;
    }
  }
  return undefined;
}

/** Every schema a document declares or uses in place, with where it is. */
function schemaRoots(document: OpenApiDocument): [string, JsonValue][] {
  const roots: [string, JsonValue][] = [];
  const components = document["components"];
  const schemas = isJsonObject(components) ? components["schemas"] : undefined;
  if (isJsonObject(schemas)) {
    for (const [name, schema] of Object.entries(schemas)) {
      roots.push([`#/components/schemas/${pointerSegment(name)}`, schema]);
    }
  }
  // A schema written in place sits under a `schema` key, in a parameter, a
  // header or a media type, wherever those are.
  const visit = (value: JsonValue, at: string) => {
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) visit(item, `${at}/${index}`);
      return;
    }
    if (!isJsonObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "schema") roots.push([`${at}/schema`, child]);
      else if (key !== "example" && key !== "examples")
        visit(child, `${at}/${pointerSegment(key)}`);
    }
  };
  visit(document["paths"] ?? {}, "#/paths");
  if (isJsonObject(components)) {
    for (const section of ["parameters", "responses", "requestBodies", "headers"]) {
      visit(components[section] ?? {}, `#/components/${section}`);
    }
  }
  return roots;
}

function assertSchemasWellFormed(document: OpenApiDocument): void {
  const seen = new Set<JsonValue>();
  for (const [at, schema] of schemaRoots(document)) {
    const where = misplacedList(schema, at, seen);
    if (where === undefined) continue;
    throw new ContractError(
      `${where} is a list of schemas, where OpenAPI takes one. A list there is JSON ` +
        "Schema's positional tuple, which neither Swagger 2.0 nor OpenAPI 3.0 has. If " +
        "each value may be one of several shapes, write that as anyOf.",
    );
  }
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

/**
 * A Swagger 2.0 document as the OpenAPI 3.0 it describes.
 *
 * Kubernetes, Slack, Square, Docker Engine, Gitea and GitLab still publish
 * 2.0, and refusing it left them out of everything. Converted to 3.0 rather
 * than 3.1, as the smallest step from what was published. The input is never
 * mutated.
 */
export function upgradeSwagger(document: OpenApiDocument): OpenApiDocument {
  const converted = upgradeFromTwoToThree(structuredClone(document) as never);
  if (!isJsonObject(converted as JsonValue)) {
    throw new ContractError("The Swagger 2.0 document could not be converted");
  }
  correctUpgrade(document, converted as JsonObject);
  return converted as OpenApiDocument;
}

export function isSwagger2(document: OpenApiDocument): boolean {
  return document["swagger"] === "2.0";
}

/** What a Response object may hold, so a component of another kind can stand in for one. */
const RESPONSE_KEYS = new Set(["description", "content", "headers", "links"]);

/** Every place a response may sit, with how to replace it. */
function responseSlots(
  document: OpenApiDocument,
): { value: JsonValue; set: (next: JsonValue) => void }[] {
  const slots: { value: JsonValue; set: (next: JsonValue) => void }[] = [];
  const add = (responses: JsonValue | undefined) => {
    if (!isJsonObject(responses)) return;
    for (const [status, value] of Object.entries(responses)) {
      slots.push({ value, set: (next) => (responses[status] = next) });
    }
  };
  const paths = document["paths"];
  if (isJsonObject(paths)) {
    for (const item of Object.values(paths)) {
      if (!isJsonObject(item)) continue;
      for (const operation of Object.values(item)) {
        if (isJsonObject(operation)) add(operation["responses"]);
      }
    }
  }
  const components = document["components"];
  if (isJsonObject(components)) add(components["responses"]);
  return slots;
}

/**
 * A response that refers to a request body, written as a response.
 *
 * PagerDuty's document answers two operations with
 * `$ref: "#/components/requestBodies/OrchestrationCacheVariableDataPutResponse"`,
 * reusing a request body that happens to have exactly a response's shape: a
 * description and content. Their tooling accepts it and the differ refuses
 * it, which cost every PagerDuty pair. Only that case is taken: a target
 * holding nothing a response cannot hold becomes a response of the same name.
 * Anything else still fails, with the differ's reason. The input is not
 * changed; a copy is, and only when there is something to change.
 */
function responsesFromRequestBodies(input: OpenApiDocument): OpenApiDocument {
  const PREFIX = "#/components/requestBodies/";
  const misplaced = (value: JsonValue) =>
    isJsonObject(value) &&
    typeof value["$ref"] === "string" &&
    value["$ref"].startsWith(PREFIX);
  if (!responseSlots(input).some((slot) => misplaced(slot.value))) return input;

  const document = structuredClone(input);
  const components = document["components"] as JsonObject;
  const responses = isJsonObject(components["responses"]) ? components["responses"] : {};
  components["responses"] = responses;
  for (const slot of responseSlots(document)) {
    if (!misplaced(slot.value)) continue;
    const ref = (slot.value as JsonObject)["$ref"] as string;
    const target = resolveRef(document, ref);
    const fits =
      isJsonObject(target) &&
      typeof target["description"] === "string" &&
      Object.keys(target).every((key) => RESPONSE_KEYS.has(key) || key.startsWith("x-"));
    if (!fits) continue;
    const name = ref.slice(PREFIX.length);
    const existing = responses[name];
    const key =
      existing === undefined || JSON.stringify(existing) === JSON.stringify(target)
        ? name
        : `${name}_response`;
    responses[key] = structuredClone(target);
    slot.set({
      $ref: `#/components/responses/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
    });
  }
  return document;
}

/**
 * An empty list of choices, read as no list at all.
 *
 * Discord's generator writes `oneOf: []` and `enum: []` for the lists it has
 * not filled in: `NameplatePalette` was `oneOf: []` for months before its
 * palettes were listed, while every response carried one. JSON Schema asks for
 * at least one choice, and an empty list taken literally allows no value, so
 * every palette the list later named was reported as a value added to a field
 * that could hold none. What the document meant is a field it did not
 * constrain, and that is how it is read. The input is not changed; a copy
 * is, and only when there is something to change.
 */
function emptyChoicesAsAbsent(input: OpenApiDocument): OpenApiDocument {
  let changed = false;
  const visit = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isJsonObject(value)) return value;
    const out: JsonObject = {};
    // Beside another statement of its values, what the empty list meant is
    // not clear: Discord's webhook event types were `enum: []` beside
    // `allOf` of every gateway event, and read as unconstrained they became a
    // hundred values the field never took. Those are left as written.
    const elsewhere = ["$ref", "allOf", "not", "const"].some((key) => key in value);
    for (const [key, entry] of Object.entries(value)) {
      if (
        !elsewhere &&
        (key === "enum" || key === "oneOf" || key === "anyOf") &&
        Array.isArray(entry) &&
        entry.length === 0
      ) {
        changed = true;
        continue;
      }
      out[key] = visit(entry);
    }
    return out;
  };
  const rewritten = visit(input) as OpenApiDocument;
  return changed ? rewritten : input;
}

/** Keywords a branch of a union of constants may carry beside its one value. */
const CONSTANT_BRANCH_KEYS = new Set(["type", "enum", "const", "description", "title"]);
/** Keywords that may sit beside such a union without changing what it means. */
const CONSTANT_UNION_SIBLINGS = new Set([
  "type",
  "format",
  "oneOf",
  "anyOf",
  "description",
  "title",
  "default",
  "example",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

/**
 * A union of constants, written as the enum it is.
 *
 * Generators document an enum's values by writing each as its own branch:
 * Qdrant's `Memory` was `oneOf` three strings, `cold`, `cached` and `pinned`,
 * each with a description, and the next release wrote the same three as one
 * `enum`. The two mean the same thing, and the differ does not see it: it
 * reported `cached` as a value added in every one of the 222 places the schema
 * is used. Discord writes the same with the type stated once, on the union.
 * Only unions whose every branch is one or more values of the same scalar
 * type are taken, so nothing is rewritten that means anything else.
 * The input is not changed; a copy is, and only when there is something to
 * change.
 */
function constantUnionsAsEnums(input: OpenApiDocument): OpenApiDocument {
  let changed = false;
  const visit = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isJsonObject(value)) return value;
    const out: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) out[key] = visit(entry);
    for (const union of ["oneOf", "anyOf"]) {
      const branches = out[union];
      if (!Array.isArray(branches) || branches.length === 0) continue;
      if (Object.keys(out).some((key) => !CONSTANT_UNION_SIBLINGS.has(key))) continue;
      if (out["oneOf"] !== undefined && out["anyOf"] !== undefined) continue;
      // Discord states the type once, on the union, and gives each branch
      // only its value, a title and a description.
      let type: JsonValue | undefined = out["type"];
      const values: JsonValue[] = [];
      const constant = branches.every((branch) => {
        if (!isJsonObject(branch)) return false;
        if (Object.keys(branch).some((key) => !CONSTANT_BRANCH_KEYS.has(key)))
          return false;
        const branchType = branch["type"] ?? type;
        if (!["string", "integer", "number", "boolean"].includes(branchType as string)) {
          return false;
        }
        if (type !== undefined && branchType !== type) return false;
        type = branchType;
        const own = Array.isArray(branch["enum"])
          ? branch["enum"]
          : branch["const"] !== undefined
            ? [branch["const"]]
            : undefined;
        if (!own || own.length === 0 || own.some((entry) => typeof entry === "object")) {
          return false;
        }
        values.push(...own);
        return true;
      });
      if (
        !constant ||
        new Set(values.map((entry) => JSON.stringify(entry))).size !== values.length
      ) {
        continue;
      }
      delete out[union];
      out["type"] = type as JsonValue;
      out["enum"] = values;
      changed = true;
    }
    return out;
  };
  const rewritten = visit(input) as OpenApiDocument;
  return changed ? rewritten : input;
}

export function normalizeDocument(input: OpenApiDocument): OpenApiDocument {
  const document = constantUnionsAsEnums(
    emptyChoicesAsAbsent(
      responsesFromRequestBodies(isSwagger2(input) ? upgradeSwagger(input) : input),
    ),
  );
  assertRefsResolve(document);
  assertSchemasWellFormed(document);
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
    ...(isSwagger2(document)
      ? { convertedFrom: { format: "swagger-2.0" as const, by: SWAGGER_CONVERTER } }
      : {}),
  };
}

/** A document as its file has it, before any conversion. */
export async function readDocument(path: string): Promise<OpenApiDocument> {
  const text = await readFile(path, "utf8");
  let parsed: JsonValue;
  try {
    parsed = parseDocumentText(path, text);
  } catch (error) {
    if (error instanceof DocumentTooLargeError) throw new ContractError(error.message);
    throw error;
  }
  if (!isJsonObject(parsed)) {
    throw new ContractError(`${path} does not contain an OpenAPI document`);
  }
  return parsed;
}

/**
 * A contract from a file, with any other files it refers to gathered into it.
 * Only here: a document that arrives any other way may refer to nothing
 * outside itself.
 */
export async function loadContract(path: string, label: string): Promise<Contract> {
  let document: OpenApiDocument;
  try {
    document = await bundleDocument(path);
  } catch (error) {
    if (error instanceof BundleError) throw new ContractError(error.message);
    throw error;
  }
  return contractOf(label, document);
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
    // A fragment is a URI fragment first, so `%7B` is `{`, and a pointer
    // after that, so `~1` is `/`.
    let key: string;
    try {
      key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    } catch {
      return undefined;
    }
    let next: JsonValue | undefined;
    // PagerDuty points into a union's branches by position, which a pointer
    // allows: `.../schema/oneOf/0`.
    if (Array.isArray(current))
      next = /^(0|[1-9]\d*)$/.test(key) ? current[Number(key)] : undefined;
    else if (isJsonObject(current)) next = current[key];
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

export const FORM_MEDIA_TYPE = "application/x-www-form-urlencoded";

export interface RequestBodyMedia {
  /** Which representation the schema came from. */
  media: "json" | "form";
  schema: JsonValue;
  /** A form's OpenAPI `encoding` object, per top-level property. */
  encoding?: JsonObject;
  /** True when the operation also accepts the other representation. */
  alsoForm?: boolean;
}

/**
 * The schema of an operation's request body, from its JSON representation or,
 * where it has none, its form one.
 *
 * A form body describes fields exactly as a JSON body does; only the wire
 * encoding differs, and the runtime decodes it before any instruction runs.
 * Stripe and Twilio declare nothing but forms, and reading only JSON left
 * every request body they have invisible to everything downstream.
 */
export function requestBodyMedia(
  document: OpenApiDocument,
  operation: JsonObject,
): RequestBodyMedia | undefined {
  const body = deref(document, operation["requestBody"] ?? null);
  if (!isJsonObject(body)) return undefined;
  const content = body["content"];
  if (!isJsonObject(content)) return undefined;
  const form = content[FORM_MEDIA_TYPE];
  const json = content["application/json"];
  if (isJsonObject(json) && json["schema"] !== undefined) {
    return {
      media: "json",
      schema: json["schema"],
      ...(isJsonObject(form) ? { alsoForm: true } : {}),
      ...(isJsonObject(form) && isJsonObject(form["encoding"])
        ? { encoding: form["encoding"] }
        : {}),
    };
  }
  if (isJsonObject(form) && form["schema"] !== undefined) {
    return {
      media: "form",
      schema: form["schema"],
      ...(isJsonObject(form["encoding"]) ? { encoding: form["encoding"] } : {}),
    };
  }
  return undefined;
}

/** The schema of an operation's request body, JSON or form. */
export function requestBodySchema(
  document: OpenApiDocument,
  operation: JsonObject,
): JsonValue | undefined {
  return requestBodyMedia(document, operation)?.schema;
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
