/**
 * Scenarios from a contract's own document, for a provider who has written
 * none.
 *
 * The differential check is only as good as what it asks, and hand-written
 * scenarios are what a stranger adopting the product does not have. A
 * document already says most of what one would say: which operations make a
 * thing, which read it back by id, which list, update and delete it, and,
 * where the provider wrote them, examples of every value. So a collection
 * with an item path becomes a chain, create then read it back, update, list
 * and delete, with the id the create returned carried into the rest, and any
 * other operation whose inputs can be filled in becomes a single step.
 *
 * Values come from the document: an example, a default, the first value an
 * enum allows. Where it gives none, a value is made from the type alone, and
 * where not even that is possible the operation is left out and said so,
 * rather than sent with something invented that proves nothing. Written in the
 * contract's own shapes, like any scenario, because that is the traffic whose
 * meaning has to survive.
 */
import {
  deref,
  type OpenApiDocument,
  type OperationRef,
  operationsOf,
  requestBodyMedia,
  resolveSchema,
  responseSchemas,
} from "@invariant-app/contract";
import { isJsonObject, type JsonObject, type JsonValue } from "@invariant-app/ir";
import type { Scenario, ScenarioStep } from "./scenarios.ts";

export interface GeneratedScenarios {
  scenarios: Scenario[];
  /** Operations left out, each with why, so a reviewer knows what was not asked. */
  skipped: string[];
}

export interface GenerateOptions {
  /** Headers every request carries, such as a test credential. */
  headers?: Record<string, string>;
}

const MAX_DEPTH = 6;

/** A value the schema allows, from what the document says, or nothing. */
export function exampleOf(
  document: OpenApiDocument,
  schema: JsonValue | undefined,
  depth = 0,
): JsonValue | undefined {
  if (schema === undefined || depth > MAX_DEPTH) return undefined;
  const resolved = resolveSchema(document, schema);
  if (!isJsonObject(resolved)) return undefined;
  if (resolved["example"] !== undefined) return resolved["example"];
  const examples = resolved["examples"];
  if (Array.isArray(examples) && examples.length > 0) return examples[0] as JsonValue;
  if (resolved["default"] !== undefined) return resolved["default"];
  if (resolved["const"] !== undefined) return resolved["const"];
  const allowed = resolved["enum"];
  if (Array.isArray(allowed)) {
    const value = allowed.find((entry) => entry !== null);
    if (value !== undefined) return value as JsonValue;
  }
  for (const union of ["oneOf", "anyOf"]) {
    const branches = resolved[union];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        const value = exampleOf(document, branch as JsonValue, depth + 1);
        if (value !== undefined) return value;
      }
      return undefined;
    }
  }
  const declared = resolved["type"];
  const type = Array.isArray(declared)
    ? declared.find((entry) => entry !== "null")
    : declared;
  const properties = isJsonObject(resolved["properties"]) ? resolved["properties"] : {};
  switch (type ?? (Object.keys(properties).length > 0 ? "object" : undefined)) {
    case "object": {
      // The required fields only: an optional one left out is still a
      // request the contract allows, and one fewer value to make up.
      const required = Array.isArray(resolved["required"])
        ? (resolved["required"] as JsonValue[]).filter(
            (name): name is string => typeof name === "string",
          )
        : [];
      const out: JsonObject = {};
      for (const name of required) {
        const property = properties[name];
        const field = isJsonObject(property)
          ? resolveSchema(document, property)
          : property;
        if (isJsonObject(field) && field["readOnly"] === true) continue;
        const value = exampleOf(document, property, depth + 1);
        if (value === undefined) return undefined;
        out[name] = value;
      }
      return out;
    }
    case "array": {
      const minimum = typeof resolved["minItems"] === "number" ? resolved["minItems"] : 0;
      if (minimum === 0) return [];
      const item = exampleOf(document, resolved["items"] as JsonValue, depth + 1);
      return item === undefined ? undefined : Array.from({ length: minimum }, () => item);
    }
    case "string":
      return stringFor(resolved);
    case "integer":
      return typeof resolved["minimum"] === "number" ? Math.ceil(resolved["minimum"]) : 1;
    case "number":
      return typeof resolved["minimum"] === "number" ? resolved["minimum"] : 1;
    case "boolean":
      return true;
  }
  return undefined;
}

function stringFor(schema: JsonObject): string | undefined {
  // A pattern cannot be satisfied without knowing what it means.
  if (typeof schema["pattern"] === "string") return undefined;
  switch (schema["format"]) {
    case "date-time":
      return "2026-01-01T00:00:00Z";
    case "date":
      return "2026-01-01";
    case "email":
      return "someone@example.com";
    case "uuid":
      return "00000000-0000-4000-8000-000000000000";
    case "uri":
    case "url":
      return "https://example.com";
  }
  const minimum = typeof schema["minLength"] === "number" ? schema["minLength"] : 0;
  return "example".padEnd(minimum, "x");
}

interface Parameter {
  name: string;
  in: string;
  required: boolean;
  schema: JsonValue | undefined;
  example: JsonValue | undefined;
}

function parametersOf(
  document: OpenApiDocument,
  path: string,
  operation: JsonObject,
): Parameter[] {
  const item = (document["paths"] as JsonObject | undefined)?.[path];
  const shared =
    isJsonObject(item) && Array.isArray(item["parameters"]) ? item["parameters"] : [];
  const own = Array.isArray(operation["parameters"]) ? operation["parameters"] : [];
  const byKey = new Map<string, Parameter>();
  for (const raw of [...shared, ...own]) {
    const parameter = deref(document, raw as JsonValue);
    if (!isJsonObject(parameter) || typeof parameter["name"] !== "string") continue;
    const examples = parameter["examples"];
    const first = isJsonObject(examples) ? Object.values(examples)[0] : undefined;
    const example =
      parameter["example"] ??
      (isJsonObject(first) ? (deref(document, first) as JsonObject)["value"] : undefined);
    byKey.set(`${parameter["in"]} ${parameter["name"]}`, {
      name: parameter["name"],
      in: String(parameter["in"]),
      required: parameter["required"] === true || parameter["in"] === "path",
      schema: parameter["schema"],
      example,
    });
  }
  return [...byKey.values()];
}

const text = (value: JsonValue): string =>
  typeof value === "string" ? value : JSON.stringify(value);

/**
 * One request for an operation, or why it cannot be made. `known` supplies
 * path parameters an earlier step captured, as `${step.name}` references.
 */
function stepFor(
  document: OpenApiDocument,
  operation: OperationRef,
  id: string,
  known: Record<string, string>,
  options: GenerateOptions,
): ScenarioStep | string {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  let path = operation.path;
  const query: string[] = [];
  for (const parameter of parametersOf(document, operation.path, operation.operation)) {
    if (!parameter.required) continue;
    const value =
      parameter.in === "path" && known[parameter.name] !== undefined
        ? known[parameter.name]
        : (parameter.example ?? exampleOf(document, parameter.schema));
    if (value === undefined) {
      return `its ${parameter.in} parameter ${parameter.name} has no example and no type to make one from`;
    }
    const written = text(value);
    if (parameter.in === "path") {
      path = path.replace(
        `{${parameter.name}}`,
        written.startsWith("${") ? written : encodeURIComponent(written),
      );
    } else if (parameter.in === "query") {
      query.push(`${encodeURIComponent(parameter.name)}=${encodeURIComponent(written)}`);
    } else if (parameter.in === "header") {
      headers[parameter.name.toLowerCase()] = written;
    } else {
      return `its required ${parameter.in} parameter ${parameter.name} is not something a scenario sends`;
    }
  }
  // A template parameter the document never declares can still be filled
  // from what an earlier step captured; otherwise nothing says what it holds.
  // A `${step.name}` reference is filled in when the scenario runs, and is not
  // a parameter.
  path = path.replace(
    /(?<!\$)\{([^{}]+)\}/g,
    (whole, name: string) => known[name] ?? whole,
  );
  if (/(?<!\$)\{[^}]+\}/.test(path)) {
    return "its path has a parameter the document does not declare";
  }

  let body: JsonValue | undefined;
  const requestBody = deref(document, operation.operation["requestBody"] ?? null);
  if (isJsonObject(requestBody)) {
    const media = requestBodyMedia(document, operation.operation);
    if (media?.media !== "json") {
      if (requestBody["required"] === true) return "its body is not JSON";
    } else {
      const content = requestBody["content"] as JsonObject;
      const json = content["application/json"] as JsonObject;
      const examples = json["examples"];
      const first = isJsonObject(examples) ? Object.values(examples)[0] : undefined;
      body =
        json["example"] ??
        (isJsonObject(first)
          ? (deref(document, first) as JsonObject)["value"]
          : undefined) ??
        exampleOf(document, media.schema);
      if (body === undefined)
        return "its body has no example and a required field nothing can fill";
      headers["content-type"] = "application/json";
    }
  }

  return {
    id,
    method: operation.method.toUpperCase(),
    path: query.length > 0 ? `${path}?${query.join("&")}` : path,
    headers,
    body,
    capture: {},
    expectStatus: undefined,
  };
}

/** Whether a successful answer to this operation carries a top-level `id`. */
function returnsId(document: OpenApiDocument, operation: OperationRef): boolean {
  return responseSchemas(document, operation.operation)
    .filter((entry) => entry.media === "json" && entry.status.startsWith("2"))
    .some((entry) => {
      const schema = resolveSchema(document, entry.schema);
      return (
        isJsonObject(schema) &&
        isJsonObject(schema["properties"]) &&
        "id" in schema["properties"]
      );
    });
}

/** The single parameter an item path adds to its collection's, as in `/things/{id}`. */
function itemParameter(collection: string, path: string): string | undefined {
  const match = /^\/\{([^{}]+)\}$/.exec(path.slice(collection.length));
  return path.startsWith(collection) ? match?.[1] : undefined;
}

export function scenariosFromDocument(
  document: OpenApiDocument,
  contract: string,
  options: GenerateOptions = {},
): GeneratedScenarios {
  const operations = operationsOf(document).filter((operation) => !operation.webhook);
  const scenarios: Scenario[] = [];
  const skipped: string[] = [];
  const used = new Set<OperationRef>();
  const find = (method: string, path: string) =>
    operations.find(
      (operation) => operation.method === method && operation.path === path,
    );

  // A collection with an item path: make one, then use it.
  for (const create of operations) {
    if (create.method !== "post" || !returnsId(document, create)) continue;
    const items = operations.filter(
      (operation) => itemParameter(create.path, operation.path) !== undefined,
    );
    const read = items.find((operation) => operation.method === "get");
    if (!read) continue;
    const name = itemParameter(create.path, read.path) as string;
    const first = stepFor(document, create, "create", {}, options);
    if (typeof first === "string") {
      skipped.push(`${create.method.toUpperCase()} ${create.path}: ${first}`);
      continue;
    }
    first.capture["id"] = "/id";
    const steps: ScenarioStep[] = [first];
    used.add(create);
    const then = (operation: OperationRef | undefined, id: string) => {
      if (!operation) return;
      const step = stepFor(document, operation, id, { [name]: `\${create.id}` }, options);
      if (typeof step === "string") {
        skipped.push(`${operation.method.toUpperCase()} ${operation.path}: ${step}`);
        return;
      }
      steps.push(step);
      used.add(operation);
    };
    then(read, "read");
    then(
      items.find((operation) => operation.method === "patch") ??
        items.find((operation) => operation.method === "put"),
      "update",
    );
    then(find("get", create.path), "list");
    then(
      items.find((operation) => operation.method === "delete"),
      "delete",
    );
    scenarios.push({
      name: `make ${create.path} and use it (generated)`,
      contract,
      steps,
      acknowledged: [],
    });
  }

  // Everything else that can be asked on its own.
  for (const operation of operations) {
    if (used.has(operation)) continue;
    const step = stepFor(document, operation, "call", {}, options);
    if (typeof step === "string") {
      skipped.push(`${operation.method.toUpperCase()} ${operation.path}: ${step}`);
      continue;
    }
    scenarios.push({
      name: `${operation.method.toUpperCase()} ${operation.path} (generated)`,
      contract,
      steps: [step],
      acknowledged: [],
    });
  }
  return { scenarios, skipped };
}
