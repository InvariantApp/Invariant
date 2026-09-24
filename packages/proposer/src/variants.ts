/**
 * A union written in place that gained a branch written in place.
 *
 * Supabase lists what keeps a project from upgrading as `validation_errors`,
 * a list whose items are a `oneOf` of objects written out in the list, each
 * told apart by the one `type` it names. A release added a ninth kind, and
 * another a tenth. A `widen` already serves a union that gained a named
 * schema: old callers are shown the new kind left out of the list. This is
 * the same change, to a branch with no name, so the branch is named the one
 * way a document can name it, by a reference to where it is written.
 *
 * Only where it is plainly that: the union is written in place in a named
 * schema, is the same kind of union on both sides, keeps every branch it had
 * as it was and in its place, and gains branches after them, none of them
 * named. Anything else changed about the union is a question this does not
 * answer, and is left to what reads the union otherwise.
 */
import {
  type OpenApiDocument,
  schemaDirections,
  unannotated,
} from "@invariant-app/contract";
import {
  type Change,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "@invariant-app/ir";

const SCHEMA_REF = "#/components/schemas/";

/** How deep into a named schema this looks for a union. */
const DEPTH = 8;

interface Place {
  /** The field's pointer, as a Change names it. */
  pointer: string;
  /** Where the union is written, as a reference into the document. */
  at: string;
  union: JsonObject;
  /** Whether a value there may be left out, or be null, where it stands. */
  optional: boolean;
  nullable: boolean;
}

/** Every `widen` of a union written in place that gained branches written in place. */
export function inlineVariantChanges(
  oldContract: OpenApiDocument,
  newContract: OpenApiDocument,
): { change: Change; notes: string[] }[] {
  const oldSchemas = schemasOf(oldContract);
  const newSchemas = schemasOf(newContract);
  const out: { change: Change; notes: string[] }[] = [];
  for (const [name, before] of Object.entries(oldSchemas)) {
    const after = newSchemas[name];
    if (after === undefined || JSON.stringify(before) === JSON.stringify(after)) continue;
    const ref = `${SCHEMA_REF}${escapeSegment(name)}`;
    const sides = schemaDirections(oldContract, ref);
    if (!sides.response) continue;
    const was = new Map(unionsIn(before, ref).map((place) => [place.pointer, place]));
    for (const now of unionsIn(after, ref)) {
      const then = was.get(now.pointer);
      if (then === undefined) continue;
      const gained = gainedBranches(then.union, now.union);
      if (gained === undefined || gained.length === 0) continue;
      const item = now.pointer.endsWith("/*") || now.pointer.endsWith("/{}");
      const show = then.nullable ? "null" : item || then.optional ? "absent" : undefined;
      if (show === undefined) continue;
      const key = Array.isArray(now.union["anyOf"]) ? "anyOf" : "oneOf";
      const field = now.pointer === "" ? name : `${readable(now.pointer)} on ${name}`;
      out.push({
        change: {
          irVersion: 1,
          id: `chg_${slug(name)}${now.pointer === "" ? "" : `_${slug(readable(now.pointer))}`}_widened`.slice(
            0,
            128,
          ),
          summary: `\`${field}\` can hold kinds of value old callers never saw.`,
          scopes: [{ schema: ref }],
          ops: gained.map((index) => ({
            op: "widen" as const,
            path: now.pointer,
            variant: `${now.at}/${key}/${index}`,
            show,
          })),
          provenance: { proposed_by: { judge: "rules", confidence: 1 } },
        },
        notes: [
          `\`${field}\` can now hold ${gained.length === 1 ? "a kind" : `${gained.length} kinds`} written out in its union, which old callers never heard of; they are shown ${show === "null" ? "null" : item ? "the item left out" : "the field left out"} instead, a declared loss to acknowledge`,
        ],
      });
    }
  }
  return out;
}

/**
 * The positions of the branches `now` gained after every branch `then` had,
 * each kept as it was; undefined where the union changed in any other way.
 */
function gainedBranches(then: JsonObject, now: JsonObject): number[] | undefined {
  const key = Array.isArray(then["anyOf"]) ? "anyOf" : "oneOf";
  const before = then[key];
  const after = now[key];
  if (!Array.isArray(before) || !Array.isArray(after) || after.length <= before.length) {
    return undefined;
  }
  // Everything beside the branches says the same.
  const rest = (union: JsonObject) => {
    const { anyOf: _anyOf, oneOf: _oneOf, ...others } = union;
    return JSON.stringify(unannotated(others));
  };
  if (rest(then) !== rest(now)) return undefined;
  const same = (a: JsonValue, b: JsonValue) =>
    JSON.stringify(unannotated(a)) === JSON.stringify(unannotated(b));
  if (!before.every((branch, index) => same(branch, after[index] as JsonValue))) {
    return undefined;
  }
  const gained = after.slice(before.length);
  // A named branch is a `widen` of its own, drafted where the union is read.
  if (gained.some((branch) => !isJsonObject(branch) || "$ref" in branch))
    return undefined;
  return gained.map((_, index) => before.length + index);
}

/** Every union written in place in a named schema, by the pointer a Change names it with. */
function unionsIn(schema: JsonValue, at: string): Place[] {
  const found: Place[] = [];
  const visit = (
    node: JsonValue,
    pointer: string,
    location: string,
    presence: { optional: boolean; nullable: boolean },
    depth: number,
  ) => {
    if (!isJsonObject(node) || depth > DEPTH || typeof node["$ref"] === "string") return;
    if (Array.isArray(node["anyOf"]) !== Array.isArray(node["oneOf"])) {
      found.push({ pointer, at: location, union: node, ...presence });
    }
    const required = new Set(
      Array.isArray(node["required"])
        ? node["required"].filter((entry): entry is string => typeof entry === "string")
        : [],
    );
    const properties = node["properties"];
    if (isJsonObject(properties)) {
      for (const [name, child] of Object.entries(properties)) {
        visit(
          child,
          `${pointer}/${escapeSegment(name)}`,
          `${location}/properties/${escapeSegment(name)}`,
          { optional: !required.has(name), nullable: nullable(child) },
          depth + 1,
        );
      }
    }
    if (isJsonObject(node["items"])) {
      visit(
        node["items"],
        `${pointer}/*`,
        `${location}/items`,
        { optional: false, nullable: nullable(node["items"]) },
        depth + 1,
      );
    }
    if (isJsonObject(node["additionalProperties"])) {
      visit(
        node["additionalProperties"],
        `${pointer}/{}`,
        `${location}/additionalProperties`,
        { optional: true, nullable: nullable(node["additionalProperties"]) },
        depth + 1,
      );
    }
  };
  visit(schema, "", at, { optional: false, nullable: false }, 0);
  return found;
}

/** Whether a schema written in place says it may be null, in any of the ways it can. */
function nullable(schema: JsonValue): boolean {
  if (!isJsonObject(schema)) return false;
  const type = schema["type"];
  if (schema["nullable"] === true || (Array.isArray(type) && type.includes("null"))) {
    return true;
  }
  const branches = (schema["anyOf"] ?? schema["oneOf"]) as JsonValue[] | undefined;
  return (
    Array.isArray(branches) &&
    branches.some((branch) => isJsonObject(branch) && branch["type"] === "null")
  );
}

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
