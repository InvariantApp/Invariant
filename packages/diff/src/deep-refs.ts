/**
 * References into the middle of a schema, given a schema of their own for the
 * differ.
 *
 * `$ref: "#/components/schemas/Tag/allOf/0"` is a valid JSON Pointer and
 * PagerDuty's document uses a dozen like it, into branches of unions, into
 * the properties of other schemas and into schemas under `paths`. The differ loads one document with them and
 * fails to load the second of a pair ("map key allOf not found"), whichever
 * two documents they are, so every PagerDuty pair was lost to it.
 *
 * Each such target is copied to a component of its own, named from where it
 * was, and the references point there. The name is the same in both documents
 * of a pair, so a change inside the target is reported once, where it was
 * made, as it would have been. Only the document handed to the differ changes.
 */
import type { OpenApiDocument } from "@invariant-app/contract";
import { isJsonObject, type JsonObject, type JsonValue } from "@invariant-app/ir";

/** How many segments a reference to a whole component has: components, kind, name. */
const WHOLE = 3;

function segmentsOf(ref: string): string[] | undefined {
  if (!ref.startsWith("#/")) return undefined;
  try {
    return ref
      .slice(2)
      .split("/")
      .map((raw) => decodeURIComponent(raw).replaceAll("~1", "/").replaceAll("~0", "~"));
  } catch {
    return undefined;
  }
}

/**
 * What a pointer reaches, following a `$ref` met on the way. PagerDuty's
 * discriminator maps into a response's schema by the path it had when it was
 * written in place; that schema is now a `$ref`, and the path continues
 * inside what it refers to, which is how a reader following the pointer
 * would take it.
 */
function at(document: JsonObject, segments: string[], hops = 0): JsonValue | undefined {
  let node: JsonValue | undefined = document;
  for (const [index, key] of segments.entries()) {
    if (
      isJsonObject(node) &&
      node[key] === undefined &&
      typeof node["$ref"] === "string"
    ) {
      const through = segmentsOf(node["$ref"]);
      if (through === undefined || hops > 16) return undefined;
      return at(document, [...through, ...segments.slice(index)], hops + 1);
    }
    node = Array.isArray(node)
      ? node[Number(key)]
      : isJsonObject(node)
        ? node[key]
        : undefined;
    if (node === undefined) return undefined;
  }
  return node;
}

/**
 * Whether a reference points inside something rather than at a whole
 * component: into a component's middle, or anywhere under `paths`, where
 * PagerDuty also points, six levels into a response's schema.
 */
function isDeep(ref: string): boolean {
  const segments = segmentsOf(ref);
  if (segments === undefined) return false;
  return segments[0] === "components" ? segments.length > WHOLE : segments[0] === "paths";
}

/** Only a schema can be moved among the schemas; anything else is left as it was. */
function pointsAtSchema(segments: string[]): boolean {
  return (
    (segments[1] === "schemas" && segments.length > 3) ||
    segments.slice(2).includes("schema")
  );
}

function mentionsDeep(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(mentionsDeep);
  if (!isJsonObject(value)) return false;
  if (typeof value["$ref"] === "string" && isDeep(value["$ref"])) return true;
  const discriminator = value["discriminator"];
  if (
    isJsonObject(discriminator) &&
    isJsonObject(discriminator["mapping"]) &&
    Object.values(discriminator["mapping"]).some(
      (target) => typeof target === "string" && isDeep(target),
    )
  ) {
    return true;
  }
  return Object.values(value).some(mentionsDeep);
}

/** The document with every reference into a schema's middle pointed at a copy of its own. */
export function wholeSchemaRefs(input: OpenApiDocument): OpenApiDocument {
  if (!mentionsDeep(input)) return input;
  const document = structuredClone(input);
  const components = isJsonObject(document["components"]) ? document["components"] : {};
  document["components"] = components;
  const schemas = isJsonObject(components["schemas"]) ? components["schemas"] : {};
  components["schemas"] = schemas;
  /** What each deep reference now points at. */
  const moved = new Map<string, string>();

  /** Where a deep reference now points, copying its target the first time. */
  const whole = (ref: string): string | undefined => {
    const known = moved.get(ref);
    if (known !== undefined) return known;
    const segments = segmentsOf(ref) as string[];
    if (!pointsAtSchema(segments)) return undefined;
    const content = at(document, segments);
    if (content === undefined) return undefined;
    const name = segments
      .slice(1)
      .join("__")
      .replace(/[^A-Za-z0-9_.-]+/g, "_");
    const target = `#/components/schemas/${name}`;
    moved.set(ref, target);
    const copy = structuredClone(content);
    schemas[name] = copy;
    // The copy may itself refer into the middle of something.
    rewrite(copy);
    return target;
  };

  const rewrite = (value: JsonValue): void => {
    if (Array.isArray(value)) {
      for (const item of value) rewrite(item);
      return;
    }
    if (!isJsonObject(value)) return;
    const ref = value["$ref"];
    if (typeof ref === "string" && isDeep(ref)) {
      const target = whole(ref);
      if (target !== undefined) value["$ref"] = target;
    }
    // A discriminator's mapping names schemas by reference too, as plain
    // strings, and the differ follows those as well.
    const discriminator = value["discriminator"];
    if (isJsonObject(discriminator) && isJsonObject(discriminator["mapping"])) {
      const mapping = discriminator["mapping"];
      for (const [key, target] of Object.entries(mapping)) {
        if (typeof target !== "string" || !isDeep(target)) continue;
        const replacement = whole(target);
        if (replacement !== undefined) mapping[key] = replacement;
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "$ref") rewrite(child);
    }
  };
  // In any order: a rewritten reference points at a copy of what it pointed
  // at before, so a copy taken after it was rewritten means the same thing.
  rewrite(document);
  return document;
}
