/**
 * Parameters, as the compiler reads and addresses them.
 *
 * An op in a parameter scope names a parameter relative to its location, so
 * `/limit` in a query scope is `/@query/limit` in the request envelope. A
 * pointer whose first segment starts with `@` names another part of the
 * request outright, which is how a parameter moves from the query string into
 * a header or the body.
 *
 * Each parameter an instruction touches travels with how it is written on the
 * wire, read from its declaration: the old contract's for decoding what an old
 * caller sends, the current one's for encoding what the provider receives.
 */
import {
  type OpenApiDocument,
  operationsOf,
  resolveRef,
  resolveSchema,
} from "@invariant/contract";
import {
  ENVELOPE_PARTS,
  formatPointer,
  isDeniedHeader,
  isJsonObject,
  type JsonObject,
  type ParamCodec,
  type ParameterLocation,
  parsePointer,
} from "@invariant/ir";

const SCALARS = new Set(["string", "integer", "number", "boolean"]);

const PART_LOCATIONS: Record<string, ParameterLocation | "body"> = {
  "@path": "path",
  "@query": "query",
  "@header": "header",
  "@cookie": "cookie",
  "@body": "body",
};

/** Where an envelope pointer points: a part of the request and what is in it. */
export interface EnvelopeAddress {
  part: ParameterLocation | "body";
  /** The parameter's name; undefined for the body. */
  name: string | undefined;
  pointer: string;
}

/**
 * The envelope pointer for a pointer written in a parameter scope. Header
 * names are case-insensitive, so they are always written lowercase.
 */
export function envelopePointer(location: ParameterLocation, pointer: string): string {
  const segments = parsePointer(pointer);
  const first = segments[0];
  const absolute = first?.startsWith("@") === true;
  const part = absolute ? PART_LOCATIONS[first as string] : location;
  if (part === undefined) throw new Error(`${pointer} names no part of a request`);
  const rest = absolute ? segments.slice(1) : segments;
  if (part === "header" && rest[0] !== undefined) rest[0] = rest[0].toLowerCase();
  return formatPointer([ENVELOPE_PARTS[part], ...rest]);
}

export function addressOf(pointer: string): EnvelopeAddress {
  const segments = parsePointer(pointer);
  const part = PART_LOCATIONS[segments[0] ?? ""];
  if (part === undefined) throw new Error(`${pointer} names no part of a request`);
  return { part, name: part === "body" ? undefined : segments[1], pointer };
}

/** An operation's parameters in effect: the path item's, unless the operation redeclares one. */
export function parametersOf(
  document: OpenApiDocument,
  method: string,
  path: string,
): JsonObject[] {
  const paths = document["paths"];
  const item = isJsonObject(paths) ? paths[path] : undefined;
  if (!isJsonObject(item)) return [];
  const operation = item[method];
  const resolve = (list: unknown): JsonObject[] =>
    (Array.isArray(list) ? list : []).flatMap((entry) => {
      const resolved =
        isJsonObject(entry) && typeof entry["$ref"] === "string"
          ? resolveRef(document, entry["$ref"])
          : entry;
      return isJsonObject(resolved) ? [resolved] : [];
    });
  const own = resolve(isJsonObject(operation) ? operation["parameters"] : undefined);
  const shared = resolve(item["parameters"]).filter(
    (parameter) =>
      !own.some((mine) => mine["in"] === parameter["in"] && sameName(mine, parameter)),
  );
  return [...shared, ...own];
}

function sameName(a: JsonObject, b: JsonObject): boolean {
  const left = String(a["name"]);
  const right = String(b["name"]);
  return a["in"] === "header"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

export function findParameter(
  parameters: readonly JsonObject[],
  location: ParameterLocation,
  name: string,
): JsonObject | undefined {
  return parameters.find(
    (parameter) =>
      parameter["in"] === location &&
      (location === "header"
        ? String(parameter["name"]).toLowerCase() === name.toLowerCase()
        : parameter["name"] === name),
  );
}

/** Header names the document's own security schemes carry credentials in. */
export function credentialHeaders(document: OpenApiDocument): Set<string> {
  const components = document["components"];
  const schemes = isJsonObject(components) ? components["securitySchemes"] : undefined;
  const names = new Set<string>();
  if (!isJsonObject(schemes)) return names;
  for (const scheme of Object.values(schemes)) {
    if (
      isJsonObject(scheme) &&
      scheme["type"] === "apiKey" &&
      scheme["in"] === "header" &&
      typeof scheme["name"] === "string"
    ) {
      names.add(scheme["name"].toLowerCase());
    }
  }
  return names;
}

/** Why no program may touch this header, if one is the case. */
export function headerRefusal(
  document: OpenApiDocument,
  name: string,
): string | undefined {
  if (isDeniedHeader(name)) {
    return `the ${name} header carries credentials, framing or a signature, and no Change may touch it`;
  }
  if (credentialHeaders(document).has(name.toLowerCase())) {
    return `the ${name} header is where this API's security scheme reads a credential, and no Change may touch it`;
  }
  return undefined;
}

const DEFAULT_STYLE: Record<ParameterLocation, ParamCodec["style"]> = {
  path: "simple",
  query: "form",
  header: "simple",
  cookie: "form",
};

const SERVED_STYLES: Record<ParameterLocation, readonly string[]> = {
  path: ["simple"],
  query: ["form", "spaceDelimited", "pipeDelimited", "deepObject"],
  header: ["simple"],
  cookie: ["form"],
};

/**
 * How a declared parameter is written, or why it cannot be served.
 */
export function codecOf(
  document: OpenApiDocument,
  parameter: JsonObject,
): ParamCodec | { refused: string } {
  const location = parameter["in"] as ParameterLocation;
  const name = String(parameter["name"]);
  const label = `the ${location} parameter ${name}`;
  if (parameter["content"] !== undefined) {
    return { refused: `${label} is written as serialized content, which is not served` };
  }
  const style = (parameter["style"] as string | undefined) ?? DEFAULT_STYLE[location];
  if (!SERVED_STYLES[location]?.includes(style)) {
    return { refused: `${label} is written in the ${style} style, which is not served` };
  }
  const explode =
    typeof parameter["explode"] === "boolean" ? parameter["explode"] : style === "form";

  const schema = resolveSchema(document, parameter["schema"] ?? {});
  const declared = isJsonObject(schema) ? schema["type"] : undefined;
  const types = (Array.isArray(declared) ? declared : [declared]).filter(
    (type): type is string => typeof type === "string" && type !== "null",
  );
  const type = (types[0] ?? "string") as ParamCodec["type"];
  if (!["string", "integer", "number", "boolean", "array", "object"].includes(type)) {
    return { refused: `${label} has a type that is not served` };
  }
  if (type === "object" && explode && style === "form") {
    return {
      refused: `${label} is an exploded form object, whose properties cannot be told apart from other parameters`,
    };
  }
  if (style === "deepObject" && type !== "object") {
    return { refused: `${label} is a deepObject that is not an object` };
  }
  let items: ParamCodec["items"];
  if (type === "array" && isJsonObject(schema)) {
    const item = resolveSchema(document, schema["items"] ?? {});
    const itemType = isJsonObject(item) ? item["type"] : undefined;
    if (typeof itemType === "string" && SCALARS.has(itemType)) {
      items = itemType as ParamCodec["items"];
    }
  }
  return {
    in: location,
    name: location === "header" ? name.toLowerCase() : name,
    style: style as ParamCodec["style"],
    explode,
    type,
    ...(items === undefined ? {} : { items }),
  };
}

/** The operation an operationId names in a document. */
export function operationById(document: OpenApiDocument, operationId: string) {
  return operationsOf(document).find(
    (candidate) => candidate.operationId === operationId,
  );
}
