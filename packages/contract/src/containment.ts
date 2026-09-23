/**
 * Whether every value one schema allows, another allows too.
 *
 * This is what lets a Change say "nothing is translated here, and nothing
 * needs to be" and be believed. Figma rewrote a node's `Effect` from one
 * object, whose `type` named four kinds, into a choice between a drop shadow,
 * an inner shadow and a blur, each declaring the fields that kind has. Every
 * value the new API sends is one the old contract already allowed, so an old
 * caller is served exactly by passing it through; but no op could say so, and
 * sixty-odd places stayed unexplained. The claim has to be proved rather than
 * asserted, because an old caller who is sent a value its contract ruled out
 * is exactly what this product exists to prevent. So it is proved here, and
 * the compiler refuses the claim wherever this cannot prove it.
 *
 * Conservative throughout: anything this cannot show is reported as not
 * covered, with where and why. A keyword it does not understand in the outer
 * schema is only covered by the same keyword, stated the same way, in the
 * inner one.
 *
 * One assumption, stated because it is load-bearing: a property a schema does
 * not declare is taken never to be sent. JSON Schema leaves undeclared
 * properties open by default, so without this nothing real could ever be
 * shown; with it, this reads documents the way the differ and every generated
 * client already read them.
 */
import { isJsonObject, type JsonObject, type JsonValue } from "@invariant-app/ir";
import { resolveSchema } from "./resolve.ts";
import type { OpenApiDocument } from "./spec.ts";

/** A schema and the document its references resolve in. */
export interface Placed {
  document: OpenApiDocument;
  schema: JsonValue;
}

export type Coverage =
  | { covered: true }
  | {
      covered: false;
      /** Where inside the schema, as a pointer: `*` is a list's items, `{}` a map's values. */
      at: string;
      reason: string;
    };

const COVERED: Coverage = { covered: true };

/** Keywords that describe a value without constraining it. */
const ANNOTATIONS = new Set([
  "title",
  "description",
  "example",
  "examples",
  "default",
  "deprecated",
  "readOnly",
  "writeOnly",
  "externalDocs",
  "xml",
  "discriminator",
  "$comment",
  "$schema",
  "$id",
  "$anchor",
  "contentMediaType",
  "contentEncoding",
]);

/** Keywords this compares by meaning rather than by how they are written. */
const UNDERSTOOD = new Set([
  "type",
  "nullable",
  "enum",
  "const",
  "format",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "properties",
  "required",
  "additionalProperties",
  "minProperties",
  "oneOf",
  "anyOf",
  "allOf",
  "$ref",
]);

const TYPES = ["null", "boolean", "object", "array", "number", "integer", "string"];

/** How deep nested schemas are followed before this gives up and says so. */
const MAX_DEPTH = 64;

/**
 * Whether every value `inner` allows, `outer` allows too.
 *
 * For a response, `outer` is the old contract and `inner` the new one: what
 * the API may now send has to be something an old caller accepts. For a
 * request it is the other way round.
 */
export function covers(outer: Placed, inner: Placed): Coverage {
  return new Prover(outer.document, inner.document).covers(
    outer.schema,
    inner.schema,
    "",
    0,
  );
}

/**
 * Whether every property the first schema names, anywhere inside it, the
 * second still names at the same place.
 *
 * Containment alone cannot tell a field that was renamed from one that was
 * always absent: a property a schema does not declare is taken never to be
 * sent, so PayPal's optional `issues`, renamed `details`, was covered both
 * ways, and a restatement in place of the rename would have dropped every
 * issue on its way to an old caller. What a restatement may change is how the
 * values are written, never which names carry them.
 */
export function keepsNames(before: Placed, after: Placed): Coverage {
  const kept = namesIn(after.document, after.schema);
  for (const name of namesIn(before.document, before.schema)) {
    if (!kept.has(name)) {
      return missed(
        name,
        "the new schema no longer names it, so a value under it would be lost",
      );
    }
  }
  return COVERED;
}

/** How deep `keepsNames` reads. */
const NAME_DEPTH = 12;

function namesIn(document: OpenApiDocument, schema: JsonValue): Set<string> {
  const names = new Set<string>();
  const visit = (
    value: JsonValue,
    at: string,
    depth: number,
    refs: ReadonlySet<string>,
  ) => {
    if (!isJsonObject(value) || depth > NAME_DEPTH) return;
    const ref = value["$ref"];
    // A schema that holds itself names nothing new the second time round.
    if (typeof ref === "string" && refs.has(ref)) return;
    const through = typeof ref === "string" ? new Set([...refs, ref]) : refs;
    const here = resolved(document, value);
    if (!isJsonObject(here)) return;
    for (const keyword of ["oneOf", "anyOf", "allOf"]) {
      const branches = here[keyword];
      if (Array.isArray(branches)) {
        for (const branch of branches) visit(branch, at, depth + 1, through);
      }
    }
    const properties = here["properties"];
    if (isJsonObject(properties)) {
      for (const [name, child] of Object.entries(properties)) {
        const place = `${at}/${escapeSegment(name)}`;
        names.add(place);
        visit(child, place, depth + 1, through);
      }
    }
    if (here["items"] !== undefined) visit(here["items"], `${at}/*`, depth + 1, through);
    if (isJsonObject(here["additionalProperties"])) {
      visit(here["additionalProperties"], `${at}/{}`, depth + 1, through);
    }
  };
  visit(schema, "", 0, new Set());
  return names;
}

class Prover {
  /** Pairs of named schemas being compared, answered covered while in progress. */
  readonly #inProgress = new Set<string>();
  /** Pairs of named schemas already compared, and the answer. */
  readonly #known = new Map<string, Coverage>();

  readonly outerDocument: OpenApiDocument;
  readonly innerDocument: OpenApiDocument;

  constructor(outerDocument: OpenApiDocument, innerDocument: OpenApiDocument) {
    this.outerDocument = outerDocument;
    this.innerDocument = innerDocument;
  }

  covers(outer: JsonValue, inner: JsonValue, at: string, depth: number): Coverage {
    if (depth > MAX_DEPTH) return missed(at, "nests too deeply to compare");
    // A recursive schema compared with itself, as a node's children are
    // nodes: covered unless something else about it is not, which the
    // comparison already under way will find.
    const key = refPair(outer, inner);
    if (key !== undefined) {
      // Told where it was first found, which is where to look.
      const known = this.#known.get(key);
      if (known) return known;
      if (this.#inProgress.has(key)) return COVERED;
      this.#inProgress.add(key);
      const answer = this.#compare(outer, inner, at, depth);
      this.#inProgress.delete(key);
      this.#known.set(key, answer);
      return answer;
    }
    return this.#compare(outer, inner, at, depth);
  }

  #compare(outer: JsonValue, inner: JsonValue, at: string, depth: number): Coverage {
    const o = resolved(this.outerDocument, outer);
    const i = resolved(this.innerDocument, inner);
    if (o === true || (isJsonObject(o) && isOpen(o))) return COVERED;
    if (i === false) return COVERED;
    if (!isJsonObject(o)) return missed(at, "the outer schema allows nothing");
    if (!isJsonObject(i)) return missed(at, "the inner schema allows any value");

    // A choice on the inside: every branch has to be allowed.
    const innerBranches = branchesOf(i);
    if (innerBranches) {
      for (const [index, branch] of innerBranches.entries()) {
        const merged = withSiblings(this.innerDocument, i, branch);
        const answer = this.covers(outer, merged, at, depth + 1);
        if (!answer.covered) {
          return missed(
            answer.at,
            `choice ${index + 1} of ${innerBranches.length}: ${answer.reason}`,
          );
        }
      }
      return COVERED;
    }
    // A choice on the outside: some branch has to allow all of it, and for a
    // `oneOf`, no other branch may also allow it.
    const outerBranches = branchesOf(o);
    if (outerBranches) {
      const exclusive = Array.isArray(o["oneOf"]);
      const merged = outerBranches.map((branch) =>
        withSiblings(this.outerDocument, o, branch),
      );
      const whole = this.#oneBranch(merged, exclusive, inner, i, at, depth);
      if (whole.covered) return whole;
      // No one branch holds all of it, but each of its kinds may have its
      // own: a `kind` of `tag` or `owner`, stated as a branch for each.
      for (const name of this.#splitsOn(o, i)) {
        const pieces = piecesOf(this.innerDocument, i, name);
        if (!pieces) continue;
        const split = pieces
          .map((piece) => this.#oneBranch(merged, exclusive, piece, piece, at, depth))
          .find((answer) => !answer.covered);
        if (!split) return COVERED;
      }
      return whole;
    }

    const unknown = Object.keys(o).find(
      (keyword) =>
        !ANNOTATIONS.has(keyword) &&
        !UNDERSTOOD.has(keyword) &&
        !keyword.startsWith("x-") &&
        JSON.stringify(o[keyword]) !== JSON.stringify(i[keyword]),
    );
    if (unknown) return missed(at, `\`${unknown}\` is not something this can compare`);

    const outerTypes = typesOf(o);
    const innerTypes = typesOf(i);
    if (innerTypes === "any" && outerTypes !== "any") {
      return missed(at, "the inner schema does not say what type it is");
    }
    if (outerTypes !== "any" && innerTypes !== "any") {
      for (const type of innerTypes) {
        const allowed =
          outerTypes.has(type) || (type === "integer" && outerTypes.has("number"));
        if (!allowed) return missed(at, `it may be ${a(type)}, which was not allowed`);
      }
    }

    // A list of values on the inside is checked value by value, against
    // everything the outside says about a value.
    const innerValues = valuesOf(i);
    if (innerValues) {
      for (const value of innerValues) {
        const refused = refuses(o, value);
        if (refused) return missed(at, `${JSON.stringify(value)} ${refused}`);
      }
      return COVERED;
    }
    if (valuesOf(o))
      return missed(at, "the outer schema lists its values and the inner does not");

    const types = innerTypes === "any" ? new Set(TYPES) : innerTypes;
    if (types.has("string")) {
      const answer = stringsCovered(o, i, at);
      if (!answer.covered) return answer;
    }
    if (types.has("number") || types.has("integer")) {
      const answer = numbersCovered(o, i, at);
      if (!answer.covered) return answer;
    }
    if (types.has("array")) {
      const answer = this.#arraysCovered(o, i, at, depth);
      if (!answer.covered) return answer;
    }
    if (types.has("object")) {
      const answer = this.#objectsCovered(o, i, at, depth);
      if (!answer.covered) return answer;
    }
    return COVERED;
  }

  #arraysCovered(o: JsonObject, i: JsonObject, at: string, depth: number): Coverage {
    if (o["items"] !== undefined) {
      if (i["items"] === undefined) {
        const open = resolved(this.outerDocument, o["items"]);
        if (!(open === true || (isJsonObject(open) && isOpen(open)))) {
          return missed(`${at}/*`, "the inner list does not say what it holds");
        }
      } else {
        const answer = this.covers(o["items"], i["items"], `${at}/*`, depth + 1);
        if (!answer.covered) return answer;
      }
    }
    const bounded = atLeast(o, i, "minItems", at) ?? atMost(o, i, "maxItems", at);
    if (bounded) return bounded;
    if (o["uniqueItems"] === true && i["uniqueItems"] !== true) {
      return missed(at, "the outer list holds no value twice, and the inner may");
    }
    return COVERED;
  }

  #objectsCovered(o: JsonObject, i: JsonObject, at: string, depth: number): Coverage {
    const outerRequired = stringsIn(o["required"]);
    const innerRequired = new Set(stringsIn(i["required"]));
    const dropped = outerRequired.find((name) => !innerRequired.has(name));
    if (dropped !== undefined) {
      return missed(
        `${at}/${dropped}`,
        "the outer schema always has it, and the inner may leave it out",
      );
    }
    const outerProperties = isJsonObject(o["properties"]) ? o["properties"] : {};
    const innerProperties = isJsonObject(i["properties"]) ? i["properties"] : {};
    const outerExtra = o["additionalProperties"];
    for (const [name, schema] of Object.entries(innerProperties)) {
      const place = `${at}/${escapeSegment(name)}`;
      const declared = outerProperties[name];
      if (declared !== undefined) {
        const answer = this.covers(declared, schema, place, depth + 1);
        if (!answer.covered) return answer;
      } else if (outerExtra === false) {
        return missed(place, "the outer schema allows no property it does not declare");
      } else if (isJsonObject(outerExtra)) {
        const answer = this.covers(outerExtra, schema, place, depth + 1);
        if (!answer.covered) return answer;
      }
    }
    // Properties under any key, as a map holds them.
    const innerExtra = i["additionalProperties"];
    if (innerExtra === true || isJsonObject(innerExtra)) {
      const values = innerExtra === true ? {} : innerExtra;
      if (outerExtra === false) {
        return missed(
          `${at}/{}`,
          "the inner schema allows properties under any name, and the outer allows none it does not declare",
        );
      }
      if (isJsonObject(outerExtra)) {
        const answer = this.covers(outerExtra, values, `${at}/{}`, depth + 1);
        if (!answer.covered) return answer;
      }
      for (const [name, schema] of Object.entries(outerProperties)) {
        if (innerProperties[name] !== undefined) continue;
        const answer = this.covers(
          schema,
          values,
          `${at}/${escapeSegment(name)}`,
          depth + 1,
        );
        if (!answer.covered) return answer;
      }
    }
    if (typeof o["minProperties"] === "number") {
      const least = Math.max(
        typeof i["minProperties"] === "number" ? i["minProperties"] : 0,
        innerRequired.size,
      );
      if (least < o["minProperties"]) {
        return missed(
          at,
          `the outer schema has at least ${o["minProperties"]} properties, and the inner may have ${least}`,
        );
      }
    }
    return COVERED;
  }

  /** Whether one branch of a choice allows all of `inner`, and only one where it must. */
  #oneBranch(
    branches: readonly JsonValue[],
    exclusive: boolean,
    inner: JsonValue,
    i: JsonObject,
    at: string,
    depth: number,
  ): Coverage {
    const holding = branches.findIndex(
      (branch) => this.covers(branch, inner, at, depth + 1).covered,
    );
    if (holding === -1)
      return missed(at, "no branch of the outer choice allows all of it");
    if (exclusive) {
      for (const [index, branch] of branches.entries()) {
        if (index === holding) continue;
        if (!this.#disjoint(branch, i)) {
          return missed(
            at,
            `the outer \`oneOf\` could match it twice, as branch ${holding + 1} and ${index + 1}`,
          );
        }
      }
    }
    return COVERED;
  }

  /**
   * The properties an object could be taken apart on, one piece per value:
   * the outer choice's discriminator first, then any the inner object always
   * has whose values it lists.
   */
  #splitsOn(o: JsonObject, i: JsonObject): string[] {
    const discriminator = isJsonObject(o["discriminator"])
      ? o["discriminator"]["propertyName"]
      : undefined;
    const properties = isJsonObject(i["properties"]) ? i["properties"] : {};
    const listed = stringsIn(i["required"]).filter(
      (name) =>
        valuesOf(resolvedObject(this.innerDocument, properties[name])) !== undefined,
    );
    return typeof discriminator === "string" && listed.includes(discriminator)
      ? [discriminator, ...listed.filter((name) => name !== discriminator)]
      : listed;
  }

  /**
   * Whether no value is allowed by both, shown by a property both require
   * whose listed values have nothing in common, as a discriminator is.
   */
  #disjoint(left: JsonValue, right: JsonValue): boolean {
    const l = resolved(this.outerDocument, left);
    const r = resolved(this.innerDocument, right);
    if (!isJsonObject(l) || !isJsonObject(r)) return false;
    const lt = typesOf(l);
    const rt = typesOf(r);
    if (lt !== "any" && rt !== "any") {
      const shared = [...rt].some(
        (type) =>
          lt.has(type) ||
          (type === "integer" && lt.has("number")) ||
          (type === "number" && lt.has("integer")),
      );
      if (!shared) return true;
    }
    const lp = isJsonObject(l["properties"]) ? l["properties"] : {};
    const rp = isJsonObject(r["properties"]) ? r["properties"] : {};
    const both = stringsIn(l["required"]).filter((name) =>
      stringsIn(r["required"]).includes(name),
    );
    return both.some((name) => {
      const lv = valuesOf(resolvedObject(this.outerDocument, lp[name]));
      const rv = valuesOf(resolvedObject(this.innerDocument, rp[name]));
      if (!lv || !rv) return false;
      const seen = new Set(lv.map((value) => JSON.stringify(value)));
      return rv.every((value) => !seen.has(JSON.stringify(value)));
    });
  }
}

/** How many values a property may list and still be taken apart value by value. */
const MOST_PIECES = 64;

/**
 * An object taken apart on one property it always has, one piece for each
 * value that property lists. Each piece allows at least what the object does
 * with that value, so every piece allowed means the object is.
 */
function piecesOf(
  document: OpenApiDocument,
  i: JsonObject,
  name: string,
): JsonObject[] | undefined {
  const properties = isJsonObject(i["properties"]) ? i["properties"] : {};
  const values = valuesOf(resolvedObject(document, properties[name]));
  if (!values || values.length < 2 || values.length > MOST_PIECES) return undefined;
  return values.map((value) => ({
    ...i,
    properties: { ...properties, [name]: { enum: [value] } },
  }));
}

function stringsCovered(o: JsonObject, i: JsonObject, at: string): Coverage {
  const bounded = atLeast(o, i, "minLength", at) ?? atMost(o, i, "maxLength", at);
  if (bounded) return bounded;
  if (o["pattern"] !== undefined && o["pattern"] !== i["pattern"]) {
    return missed(at, "the outer schema matches a pattern the inner does not state");
  }
  if (o["format"] !== undefined && o["format"] !== i["format"]) {
    return missed(
      at,
      `the outer schema is a ${String(o["format"])}, and the inner is not said to be`,
    );
  }
  return COVERED;
}

function numbersCovered(o: JsonObject, i: JsonObject, at: string): Coverage {
  const outerLow = lowerBound(o);
  const innerLow = lowerBound(i);
  if (outerLow && !(innerLow && tighterLow(innerLow, outerLow))) {
    return missed(
      at,
      `the outer schema is at least ${outerLow.value}, and the inner may be lower`,
    );
  }
  const outerHigh = upperBound(o);
  const innerHigh = upperBound(i);
  if (outerHigh && !(innerHigh && tighterHigh(innerHigh, outerHigh))) {
    return missed(
      at,
      `the outer schema is at most ${outerHigh.value}, and the inner may be higher`,
    );
  }
  const step = o["multipleOf"];
  if (typeof step === "number") {
    const inner = i["multipleOf"];
    const ratio = typeof inner === "number" ? inner / step : Number.NaN;
    if (!(Math.abs(ratio - Math.round(ratio)) < 1e-9 && ratio >= 1)) {
      return missed(
        at,
        `the outer schema is a multiple of ${step}, and the inner is not said to be`,
      );
    }
  }
  return COVERED;
}

interface Bound {
  value: number;
  exclusive: boolean;
}

/** The lowest value allowed, in either way OpenAPI writes it. */
function lowerBound(schema: JsonObject): Bound | undefined {
  const minimum = schema["minimum"];
  const exclusive = schema["exclusiveMinimum"];
  if (typeof exclusive === "number") {
    return typeof minimum === "number" && minimum > exclusive
      ? { value: minimum, exclusive: false }
      : { value: exclusive, exclusive: true };
  }
  if (typeof minimum === "number")
    return { value: minimum, exclusive: exclusive === true };
  return undefined;
}

function upperBound(schema: JsonObject): Bound | undefined {
  const maximum = schema["maximum"];
  const exclusive = schema["exclusiveMaximum"];
  if (typeof exclusive === "number") {
    return typeof maximum === "number" && maximum < exclusive
      ? { value: maximum, exclusive: false }
      : { value: exclusive, exclusive: true };
  }
  if (typeof maximum === "number")
    return { value: maximum, exclusive: exclusive === true };
  return undefined;
}

const tighterLow = (inner: Bound, outer: Bound) =>
  inner.value > outer.value ||
  (inner.value === outer.value && (inner.exclusive || !outer.exclusive));
const tighterHigh = (inner: Bound, outer: Bound) =>
  inner.value < outer.value ||
  (inner.value === outer.value && (inner.exclusive || !outer.exclusive));

/** Why the outer schema refuses one listed value, or nothing when it allows it. */
function refuses(o: JsonObject, value: JsonValue): string | undefined {
  const listed = valuesOf(o);
  if (
    listed &&
    !listed.some((allowed) => JSON.stringify(allowed) === JSON.stringify(value))
  ) {
    return "is not one of the values allowed";
  }
  const types = typesOf(o);
  const type = typeOfValue(value);
  if (
    types !== "any" &&
    !types.has(type) &&
    !(type === "integer" && types.has("number"))
  ) {
    return `is ${a(type)}, which was not allowed`;
  }
  if (typeof value === "string") {
    if (typeof o["maxLength"] === "number" && [...value].length > o["maxLength"])
      return "is too long";
    if (typeof o["minLength"] === "number" && [...value].length < o["minLength"])
      return "is too short";
    if (typeof o["pattern"] === "string") {
      try {
        if (!new RegExp(o["pattern"], "u").test(value))
          return "does not match the pattern";
      } catch {
        return "is checked against a pattern this cannot read";
      }
    }
    // A format is a claim about the value that a listed value either makes
    // good or does not; nothing here can check every format, so only an
    // outer format the inner states too is taken as kept.
    if (o["format"] !== undefined) return `is not shown to be a ${String(o["format"])}`;
  }
  if (typeof value === "number") {
    const low = lowerBound(o);
    const high = upperBound(o);
    if (low && (value < low.value || (low.exclusive && value === low.value)))
      return "is too low";
    if (high && (value > high.value || (high.exclusive && value === high.value)))
      return "is too high";
    const step = o["multipleOf"];
    if (
      typeof step === "number" &&
      Math.abs(value / step - Math.round(value / step)) > 1e-9
    ) {
      return `is not a multiple of ${step}`;
    }
  }
  if (value !== null && typeof value === "object") {
    return "is an object or a list, which this compares by schema and not by value";
  }
  return undefined;
}

/** A lower bound the inner schema has to meet, or why it does not. */
function atLeast(
  o: JsonObject,
  i: JsonObject,
  keyword: string,
  at: string,
): Coverage | undefined {
  const outer = o[keyword];
  if (typeof outer !== "number") return undefined;
  const inner = i[keyword];
  return typeof inner === "number" && inner >= outer
    ? undefined
    : missed(at, `the outer schema has a ${keyword} of ${outer}, and the inner does not`);
}

function atMost(
  o: JsonObject,
  i: JsonObject,
  keyword: string,
  at: string,
): Coverage | undefined {
  const outer = o[keyword];
  if (typeof outer !== "number") return undefined;
  const inner = i[keyword];
  return typeof inner === "number" && inner <= outer
    ? undefined
    : missed(at, `the outer schema has a ${keyword} of ${outer}, and the inner does not`);
}

/** The types a schema allows: declared, or read from the values it lists. */
function typesOf(schema: JsonObject): Set<string> | "any" {
  const declared = schema["type"];
  const listed = Array.isArray(declared)
    ? declared.filter((type): type is string => typeof type === "string")
    : typeof declared === "string"
      ? [declared]
      : undefined;
  let types: Set<string>;
  if (listed) types = new Set(listed);
  else {
    const values = valuesOf(schema);
    if (!values) return "any";
    types = new Set(values.map(typeOfValue));
  }
  if (schema["nullable"] === true) types.add("null");
  return types;
}

/** The values a schema lists, with null where it is nullable. */
function valuesOf(schema: JsonObject | undefined): JsonValue[] | undefined {
  if (!schema) return undefined;
  const listed = Array.isArray(schema["enum"])
    ? (schema["enum"] as JsonValue[])
    : schema["const"] !== undefined
      ? [schema["const"] as JsonValue]
      : undefined;
  if (!listed) return undefined;
  return schema["nullable"] === true && !listed.includes(null)
    ? [...listed, null]
    : listed;
}

function typeOfValue(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/** The branches of a choice, where the schema is one. */
function branchesOf(schema: JsonObject): JsonValue[] | undefined {
  for (const keyword of ["oneOf", "anyOf"] as const) {
    const branches = schema[keyword];
    if (Array.isArray(branches) && branches.length > 0) return branches as JsonValue[];
  }
  return undefined;
}

/**
 * A branch of a choice with what the choice says of every branch: the
 * keywords written beside it, and the property its discriminator reads.
 * OpenAPI requires that property in every value, since the discriminator
 * cannot pick a branch without it, so a branch that forgets to list it as
 * required is still read as requiring it. Figma's inner shadow does forget.
 */
function withSiblings(
  document: OpenApiDocument,
  union: JsonObject,
  branch: JsonValue,
): JsonValue {
  const { oneOf: _one, anyOf: _any, discriminator, ...siblings } = union;
  const parts: JsonValue[] = [];
  if (Object.keys(siblings).some((key) => !ANNOTATIONS.has(key))) parts.push(siblings);
  const property = isJsonObject(discriminator)
    ? discriminator["propertyName"]
    : undefined;
  if (typeof property === "string") parts.push({ required: [property] });
  if (parts.length === 0) return branch;
  return resolveSchema(document, { allOf: [...parts, branch] });
}

/** Whether a schema constrains nothing at all. */
function isOpen(schema: JsonObject): boolean {
  return Object.keys(schema).every(
    (keyword) => ANNOTATIONS.has(keyword) || keyword.startsWith("x-"),
  );
}

function resolved(document: OpenApiDocument, schema: JsonValue): JsonValue {
  if (schema === true || schema === false) return schema;
  return resolveSchema(document, schema);
}

function resolvedObject(
  document: OpenApiDocument,
  schema: JsonValue | undefined,
): JsonObject | undefined {
  if (schema === undefined) return undefined;
  const value = resolved(document, schema);
  return isJsonObject(value) ? value : undefined;
}

function refPair(outer: JsonValue, inner: JsonValue): string | undefined {
  const ref = (schema: JsonValue) =>
    isJsonObject(schema) && typeof schema["$ref"] === "string"
      ? schema["$ref"]
      : undefined;
  const left = ref(outer);
  const right = ref(inner);
  return left !== undefined && right !== undefined ? `${left}\u0000${right}` : undefined;
}

function stringsIn(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function missed(at: string, reason: string): Coverage {
  return { covered: false, at, reason };
}

const escapeSegment = (segment: string) =>
  segment.replaceAll("~", "~0").replaceAll("/", "~1");

const a = (type: string) => (/^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`);
