/**
 * Schemas that say the same values another way.
 *
 * Figma rewrote a node's `Effect` from one object, whose `type` named its
 * kinds, into a choice between a shadow and a blur, each declaring the fields
 * that kind has. The differ reads that as a union that gained branches, sixty
 * places in one release, and no field was renamed, retyped or dropped for a
 * judge to pair. What changed is how the values are written down, and where
 * that is provably all that changed, the Change is a `restate`.
 *
 * Only drafted where it is proved, with the same containment check the
 * compiler proves it with again: every value old callers may now be sent is
 * one their contract allowed, and every value they send is one the new
 * contract accepts, in whichever of those directions the schema is used. And
 * only where how a choice is written changed, since everywhere else a
 * difference is a field, and a field has its own op.
 */
import { covers, type OpenApiDocument, schemaDirections } from "@invariant-app/contract";
import {
  type Change,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "@invariant-app/ir";

/** The keywords that say how a choice, or a single value, is written. */
const CHOICE_KEYWORDS = ["oneOf", "anyOf", "allOf", "discriminator", "const"] as const;

/** How deep into a schema written in place this looks. */
const DEPTH = 8;

export interface Restatement {
  /** The named schema. */
  schema: string;
  /** Where in it, as a pointer; empty for the whole schema. */
  path: string;
  /**
   * Every other named schema the place refers to, on either side. The proof
   * holds for them as they stand, so a draft that changes one of them
   * changes what was proved.
   */
  reaches: ReadonlySet<string>;
  change: Change;
}

export function restatements(
  oldContract: OpenApiDocument,
  newContract: OpenApiDocument,
): Restatement[] {
  const oldSchemas = schemasOf(oldContract);
  const newSchemas = schemasOf(newContract);
  const found: Restatement[] = [];
  for (const [name, before] of Object.entries(oldSchemas)) {
    const after = newSchemas[name];
    if (after === undefined || JSON.stringify(before) === JSON.stringify(after)) continue;
    const moved = choicesMoved(before, after);
    if (moved.length === 0) continue;
    const sides = schemaDirections(oldContract, `#/components/schemas/${name}`);
    if (!sides.request && !sides.response) continue;
    const proved = (path: string) => {
      const was = at(before, path);
      const now = at(after, path);
      if (was === undefined || now === undefined) return false;
      const old = { document: oldContract, schema: was };
      const next = { document: newContract, schema: now };
      return (
        (!sides.response || covers(old, next).covered) &&
        (!sides.request || covers(next, old).covered)
      );
    };
    // The whole schema where it can be shown, which is one statement for
    // everything under it; otherwise the outermost place above each change
    // that can be.
    const paths = proved("")
      ? [""]
      : outermost(
          moved.flatMap((pointer) => {
            const found = ancestors(pointer).find(proved);
            return found === undefined ? [] : [found];
          }),
        );
    for (const path of paths) {
      const reaches = new Set<string>();
      referencesFrom(oldSchemas, at(before, path) ?? null, reaches);
      referencesFrom(newSchemas, at(after, path) ?? null, reaches);
      reaches.delete(name);
      found.push({ schema: name, path, reaches, change: restateChange(name, path) });
    }
  }
  return found;
}

function restateChange(name: string, path: string): Change {
  const where = path === "" ? `\`${name}\`` : `\`${readable(path)}\` on ${name}`;
  return {
    irVersion: 1,
    id: `chg_${slug(name)}${path === "" ? "" : `_${slug(readable(path))}`}_restated`.slice(
      0,
      128,
    ),
    summary: `${where} states the same values another way.`,
    scopes: [{ schema: `#/components/schemas/${name}` }],
    ops: [{ op: "restate", path }],
    provenance: { proposed_by: { judge: "rules", confidence: 1 } },
  };
}

/**
 * The places, inside one schema written in place, where how a choice or a
 * single value is written differs between the two versions.
 */
function choicesMoved(before: JsonValue, after: JsonValue): string[] {
  const was = choicesIn(before);
  const now = choicesIn(after);
  const places = new Set([...was.keys(), ...now.keys()]);
  return [...places].filter((place) => was.get(place) !== now.get(place));
}

function choicesIn(
  schema: JsonValue,
  pointer = "",
  found = new Map<string, string>(),
  depth = 0,
): Map<string, string> {
  if (!isJsonObject(schema) || depth > DEPTH) return found;
  // A reference standing where an object was written out says nothing new:
  // PayPal named its invoice's parts and no value changed.
  const written = CHOICE_KEYWORDS.filter((keyword) => schema[keyword] !== undefined).map(
    (keyword) => `${keyword}=${JSON.stringify(schema[keyword])}`,
  );
  if (written.length > 0) found.set(pointer, written.join(" "));
  for (const [key, child] of Object.entries(childrenOf(schema))) {
    choicesIn(child, `${pointer}/${key}`, found, depth + 1);
  }
  return found;
}

/** What a schema written in place holds, by the segment that reaches it. */
function childrenOf(schema: JsonObject): Record<string, JsonValue> {
  const children: Record<string, JsonValue> = {};
  const properties = schema["properties"];
  if (isJsonObject(properties)) {
    for (const [name, child] of Object.entries(properties)) {
      children[escapeSegment(name)] = child;
    }
  }
  if (isJsonObject(schema["items"])) children["*"] = schema["items"];
  if (isJsonObject(schema["additionalProperties"]))
    children["{}"] = schema["additionalProperties"];
  return children;
}

/** The schema at a pointer, through what is written in place only. */
function at(schema: JsonValue, pointer: string): JsonValue | undefined {
  let here: JsonValue | undefined = schema;
  for (const segment of pointer === "" ? [] : pointer.slice(1).split("/")) {
    if (!isJsonObject(here) || typeof here["$ref"] === "string") return undefined;
    here = childrenOf(here)[segment];
  }
  return here;
}

/** A pointer and every place above it but the root, outermost first. */
function ancestors(pointer: string): string[] {
  const segments = pointer === "" ? [] : pointer.slice(1).split("/");
  return segments.map((_, index) => `/${segments.slice(0, index + 1).join("/")}`);
}

function outermost(pointers: string[]): string[] {
  const unique = [...new Set(pointers)];
  return unique.filter(
    (pointer) =>
      !unique.some((other) => other !== pointer && pointer.startsWith(`${other}/`)),
  );
}

/** The named schemas a schema refers to, however deep. */
function referencesFrom(
  schemas: Record<string, JsonValue>,
  schema: JsonValue,
  found: Set<string>,
): void {
  const pending: JsonValue[] = [schema];
  while (pending.length > 0) {
    const value = pending.pop() as JsonValue;
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (!isJsonObject(value)) continue;
    const ref = value["$ref"];
    if (typeof ref === "string" && ref.startsWith(SCHEMA_REF)) {
      const name = ref
        .slice(SCHEMA_REF.length)
        .replaceAll("~1", "/")
        .replaceAll("~0", "~");
      if (!found.has(name) && schemas[name] !== undefined) {
        found.add(name);
        pending.push(schemas[name] as JsonValue);
      }
    }
    pending.push(...Object.values(value));
  }
}

const SCHEMA_REF = "#/components/schemas/";

function schemasOf(document: OpenApiDocument): Record<string, JsonValue> {
  const components = (document as unknown as JsonObject)["components"];
  const schemas = isJsonObject(components) ? components["schemas"] : undefined;
  return isJsonObject(schemas) ? schemas : {};
}

const escapeSegment = (segment: string) =>
  segment.replaceAll("~", "~0").replaceAll("/", "~1");

const readable = (pointer: string) =>
  pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .join(".");

function slug(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9*{}]+/g, "_")
    .replaceAll("*", "items")
    .replaceAll("{}", "values")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}
