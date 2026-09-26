/**
 * What the matcher needs to know about each of a contract's schemas: the
 * properties it has, which of them are pinned to one value, and which other
 * schemas its properties refer to.
 */
import { type OpenApiDocument, operationsOf, schemasOf } from "@invariant-app/contract";
import { isJsonObject, type JsonObject, type JsonValue } from "@invariant-app/ir";
import type { Language } from "./types.ts";

const PREFIX = "#/components/schemas/";

export interface SchemaShape {
  name: string;
  /**
   * `object` when it has properties, `union` when it is a choice between
   * other schemas, `other` for anything else (an enum, a primitive).
   */
  kind: "object" | "union" | "other";
  /** Property names, its own and those of every schema it is `allOf`. */
  properties: string[];
  /** Properties pinned to one string value, as Stripe's `object`. */
  constants: Record<string, string>;
  /** Each property that refers to exactly one other schema, to that schema. */
  refs: [property: string, schema: string][];
  /**
   * Each property that is one of several schemas, as Stripe's
   * `payment_method_options.link`, either its own options or a shared one.
   */
  choices: [property: string, schemas: string[]][];
  /**
   * The type name a generator's extension on the schema gives it, and which
   * extension: Fern's `x-fern-type-name`, Speakeasy's
   * `x-speakeasy-name-override`, Stainless's `x-stainless-naming` for the
   * language.
   */
  named?: { name: string; extension: string };
  /**
   * Whether requests, responses, both or neither carry the schema, directly
   * or inside another, so a request's type can be told from a response's
   * where a generator makes one of each.
   */
  role: "request" | "response" | "both" | "neither";
}

/** Every schema a JSON value refers to, however deep. */
function refsIn(value: JsonValue | undefined, into: Set<string>): Set<string> {
  if (Array.isArray(value)) {
    for (const each of value) refsIn(each, into);
  } else if (isJsonObject(value)) {
    const ref = value["$ref"];
    if (typeof ref === "string" && ref.startsWith(PREFIX))
      into.add(ref.slice(PREFIX.length));
    for (const [key, each] of Object.entries(value)) {
      if (key !== "$ref") refsIn(each, into);
    }
  }
  return into;
}

/** Which schemas requests reach, and which responses reach. */
function roles(document: OpenApiDocument): {
  request: Set<string>;
  response: Set<string>;
} {
  const schemas = schemasOf(document);
  const graph = new Map<string, Set<string>>();
  for (const [name, schema] of Object.entries(schemas)) {
    graph.set(name, refsIn(schema, new Set()));
  }
  const reach = (seeds: Set<string>) => {
    const queue = [...seeds];
    while (queue.length > 0) {
      const next = queue.pop() as string;
      for (const each of graph.get(next) ?? []) {
        if (seeds.has(each)) continue;
        seeds.add(each);
        queue.push(each);
      }
    }
    return seeds;
  };
  const request = new Set<string>();
  const response = new Set<string>();
  for (const operation of operationsOf(document)) {
    const value = operation.operation;
    refsIn(value["requestBody"], request);
    refsIn(value["parameters"], request);
    refsIn(value["responses"], response);
  }
  // Components a request or response names by reference.
  const components = isJsonObject(document["components"]) ? document["components"] : {};
  for (const [kind, into] of [
    ["requestBodies", request],
    ["parameters", request],
    ["responses", response],
  ] as const) {
    const section = components[kind];
    if (!isJsonObject(section)) continue;
    for (const each of Object.values(section)) refsIn(each, into);
  }
  return { request: reach(request), response: reach(response) };
}

/** The keys `x-stainless-naming` uses for each language. */
const STAINLESS_LANGUAGES: Record<Language, string[]> = {
  typescript: ["typescript", "node"],
  python: ["python"],
  go: ["go"],
};

/** The type name an extension on a schema records, where one does. */
function namedBy(
  schema: JsonValue | undefined,
  language: Language,
): SchemaShape["named"] | undefined {
  if (!isJsonObject(schema)) return undefined;
  for (const extension of ["x-fern-type-name", "x-speakeasy-name-override"]) {
    const name = schema[extension];
    if (typeof name === "string" && name !== "") return { name, extension };
  }
  const stainless = schema["x-stainless-naming"];
  if (isJsonObject(stainless)) {
    for (const key of STAINLESS_LANGUAGES[language]) {
      const entry = stainless[key];
      if (!isJsonObject(entry)) continue;
      const name = entry["type_name"] ?? entry["model_name"];
      if (typeof name === "string" && name !== "") {
        return { name, extension: `x-stainless-naming.${key}` };
      }
    }
  }
  return undefined;
}

/** The one schema a property refers to, directly or as the only non-null choice. */
export function refOf(property: JsonValue | undefined): string | undefined {
  if (!isJsonObject(property)) return undefined;
  const ref = property["$ref"];
  if (typeof ref === "string" && ref.startsWith(PREFIX)) return ref.slice(PREFIX.length);
  const choices = property["anyOf"] ?? property["allOf"];
  if (!Array.isArray(choices)) return undefined;
  const found = choices.map(refOf).filter((each) => each !== undefined);
  return found.length === 1 ? found[0] : undefined;
}

/** The single string a property may take, where it is pinned to one. */
function constantOf(
  schemas: JsonObject,
  property: JsonValue | undefined,
): string | undefined {
  let value = property;
  const ref = refOf(value);
  if (ref !== undefined && isJsonObject(value) && typeof value["$ref"] === "string") {
    value = schemas[ref];
  }
  if (!isJsonObject(value)) return undefined;
  if (typeof value["const"] === "string") return value["const"];
  const choices = value["enum"];
  if (Array.isArray(choices) && choices.length === 1 && typeof choices[0] === "string") {
    return choices[0];
  }
  return undefined;
}

function propertiesOf(
  schemas: JsonObject,
  schema: JsonValue | undefined,
  seen: Set<string>,
): [string, JsonValue][] {
  if (!isJsonObject(schema)) return [];
  const own = isJsonObject(schema["properties"])
    ? Object.entries(schema["properties"])
    : [];
  const inherited: [string, JsonValue][] = [];
  const members = schema["allOf"];
  if (Array.isArray(members)) {
    for (const member of members) {
      const ref =
        isJsonObject(member) && typeof member["$ref"] === "string"
          ? member["$ref"]
          : undefined;
      if (ref?.startsWith(PREFIX)) {
        const name = ref.slice(PREFIX.length);
        if (seen.has(name)) continue;
        seen.add(name);
        inherited.push(...propertiesOf(schemas, schemas[name], seen));
      } else {
        inherited.push(...propertiesOf(schemas, member, seen));
      }
    }
  }
  const out = new Map<string, JsonValue>(inherited);
  for (const [key, value] of own) out.set(key, value);
  return [...out];
}

/** Every schema of a document, in the order the document lists them. */
export function schemaShapes(
  document: OpenApiDocument,
  language: Language,
): SchemaShape[] {
  const schemas = schemasOf(document);
  const { request, response } = roles(document);
  return Object.entries(schemas).map(([name, schema]): SchemaShape => {
    const named = namedBy(schema, language);
    const role =
      request.has(name) && response.has(name)
        ? "both"
        : request.has(name)
          ? "request"
          : response.has(name)
            ? "response"
            : "neither";
    const properties = propertiesOf(schemas, schema, new Set([name]));
    const constants: Record<string, string> = {};
    const refs: [string, string][] = [];
    const choices: [string, string[]][] = [];
    for (const [property, value] of properties) {
      const constant = constantOf(schemas, value);
      if (constant !== undefined) constants[property] = constant;
      const ref = refOf(value);
      if (ref !== undefined) refs.push([property, ref]);
      else if (isJsonObject(value)) {
        const options = value["anyOf"] ?? value["oneOf"];
        const several = Array.isArray(options)
          ? options.map(refOf).filter((each) => each !== undefined)
          : [];
        if (several.length > 1) choices.push([property, several]);
      }
    }
    const union =
      isJsonObject(schema) &&
      (Array.isArray(schema["oneOf"]) || Array.isArray(schema["anyOf"]));
    return {
      name,
      kind: properties.length > 0 ? "object" : union ? "union" : "other",
      properties: properties.map(([property]) => property),
      constants,
      refs,
      choices,
      ...(named ? { named } : {}),
      role,
    };
  });
}
