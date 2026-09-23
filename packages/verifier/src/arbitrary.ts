/**
 * Turning a contract's schemas into generators.
 *
 * The values a property test runs on have to be values the contract actually
 * allows, or the test proves nothing about the API. Generating them from the
 * declared schema is what makes the lens laws meaningful: a counterexample is
 * by construction a body a real caller could have sent.
 *
 * Two declarations matter more than the rest. `multipleOf` fixes how many
 * decimal places a number really has, so a generator that ignores it would
 * invent precision the contract never promised and fail a scale conversion for
 * the wrong reason. `enum` fixes the vocabulary, so a value map can be tested
 * against exactly the values it claims to cover.
 */
import { deref, type OpenApiDocument, resolveSchema } from "@invariant-app/contract";
import { isJsonObject, type JsonValue } from "@invariant-app/ir";
import fc from "fast-check";
import { validateSchema } from "./validate.ts";

export class ArbitraryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArbitraryError";
  }
}

/** How deep to follow nested objects before giving up on a recursive schema. */
const MAX_DEPTH = 6;
/**
 * Beyond MAX_DEPTH only what the schema requires is generated. Real contracts
 * nest deeper than six levels, Adyen's terminal API well past it, and an
 * object cut to `{}` there is missing its required fields, which makes the
 * value invalid under its own contract. A required cycle has no finite value
 * at all, so generation stops for good here.
 */
const HARD_DEPTH = 32;

function typesOf(schema: Record<string, JsonValue>): string[] {
  const declared = schema["type"];
  if (Array.isArray(declared)) {
    return declared.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof declared === "string") return [declared];
  return [];
}

/**
 * Numbers that land exactly on the declared step.
 *
 * A step of 0.01 means two decimal places and nothing finer, so the generator
 * produces a whole number of steps and scales it back. Doing the scaling in
 * integer space keeps the generated value free of the binary-fraction noise
 * that multiplying by 0.01 would introduce.
 */
function numberWithStep(
  step: number,
  integral: boolean,
  range: { min: number; max: number } = { min: -1_000_000, max: 1_000_000 },
): fc.Arbitrary<JsonValue> {
  const places = decimalPlaces(step);
  const factor = 10 ** places;
  const unit = Math.round(step * factor);
  if (unit === 0) return fc.integer({ min: -1_000_000, max: 1_000_000 });

  // The whole numbers of steps that land inside the declared range, so an
  // amount the contract says is positive is never generated negative.
  const lowest = Math.ceil((range.min * factor) / unit);
  const highest = Math.floor((range.max * factor) / unit);
  return fc
    .integer({
      min: Math.max(lowest, -1_000_000),
      max: Math.max(Math.min(highest, 1_000_000), Math.max(lowest, -1_000_000)),
    })
    .map((count) => (count * unit) / factor)
    .filter((value) => !integral || Number.isInteger(value));
}

function decimalPlaces(value: number): number {
  const text = String(value);
  const exponent = text.indexOf("e");
  if (exponent !== -1) {
    const power = Number(text.slice(exponent + 1));
    return power < 0 ? -power : 0;
  }
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

const DATES = fc.date({
  min: new Date("2020-01-01T00:00:00Z"),
  max: new Date("2030-01-01T00:00:00Z"),
  noInvalidDate: true,
});

function stringFor(schema: Record<string, JsonValue>): fc.Arbitrary<JsonValue> {
  const format = schema["format"];
  if (format === "date-time") return DATES.map((date) => date.toISOString());
  if (format === "date") return DATES.map((date) => date.toISOString().slice(0, 10));
  if (format === "uuid") return fc.uuid();
  if (format === "email") return fc.emailAddress();
  if (format === "uri" || format === "url") return fc.webUrl();
  if (format === "ipv4") return fc.ipV4();
  if (format === "byte") return fc.base64String({ maxLength: 24 });
  if (format === "uri-reference") return fc.webUrl();
  // RFC 6570 leaves the apostrophe out of the literals a template may hold.
  if (format === "uri-template") return fc.webUrl().map((url) => url.replaceAll("'", ""));
  if (format === "ipv6") return fc.ipV6();
  if (format === "hostname") return fc.domain();
  if (format === "time") {
    return DATES.map((date) => `${date.toISOString().slice(11, 19)}Z`);
  }
  if (format === "duration") {
    // ISO 8601, which is what the format means to a JSON Schema validator.
    return fc
      .tuple(fc.nat(30), fc.nat(23), fc.nat(59), fc.nat(59))
      .map(([days, hours, minutes, seconds]) =>
        days === 0 && hours === 0 && minutes === 0 && seconds === 0
          ? "PT0S"
          : `P${days ? `${days}D` : ""}${hours || minutes || seconds ? `T${hours ? `${hours}H` : ""}${minutes ? `${minutes}M` : ""}${seconds ? `${seconds}S` : ""}` : ""}`,
      );
  }

  const minLength = typeof schema["minLength"] === "number" ? schema["minLength"] : 0;
  const declaredMax =
    typeof schema["maxLength"] === "number" ? schema["maxLength"] : undefined;
  const pattern = schema["pattern"];
  if (typeof pattern === "string") {
    let regex: RegExp | undefined;
    try {
      regex = new RegExp(pattern, "u");
    } catch {
      // A pattern JavaScript cannot compile. Fall through to plain text, which
      // the oracle will then refuse, so the gap is counted rather than hidden.
    }
    if (regex) {
      const matching = fc.stringMatching(regex);
      // Held to the lengths the schema declares, and only those: a pattern
      // decides its own length, and a default cap once filtered out every
      // candidate for a 44-character Twilio id, so generation never returned.
      const fits = (text: string) =>
        text.length >= minLength &&
        (declaredMax === undefined || text.length <= declaredMax);
      if (minLength === 0 && declaredMax === undefined) return matching;
      // One repeated atom, `^[0-9a-f]+$` or `^\d*$`, is by far the commonest
      // patterned string with lengths declared, as for a 40-character commit
      // sha. Its quantifier is rewritten to the declared lengths, so every
      // value fits rather than only the rare one a filter would keep.
      const single = /^\^((?:\[(?:\\.|[^\]\\])+\]|\\[dDwWsS]|\.))([+*])\$$/.exec(pattern);
      if (single) {
        return fc.stringMatching(
          new RegExp(
            `^${single[1]}{${single[2] === "+" ? Math.max(minLength, 1) : minLength},${declaredMax ?? ""}}$`,
            "u",
          ),
          declaredMax === undefined ? {} : { size: "max" },
        );
      }
      // A filter that nothing passes never returns either, so a fixed sample
      // is probed first, at growing sizes: a 40-character commit sha is past
      // what the default size repeats a character class to. If no size
      // yields a fit, the declared lengths contradict the pattern; matches
      // are returned as they are and the oracle counts it.
      for (const size of ["small", "medium", "large"] as const) {
        const sized = fc.stringMatching(regex, { size });
        if (fc.sample(sized, { numRuns: 64, seed: 0 }).some(fits)) {
          return sized.filter(fits);
        }
      }
      return matching;
    }
  }
  const maxLength = declaredMax ?? Math.max(minLength, 24);
  // Printable ASCII only. A transform never inspects text, and unprintable
  // characters make a counterexample far harder to read than it needs to be.
  return fc.string({ minLength, maxLength, unit: "grapheme-ascii" });
}

/** Whether a value is of a type the schema declares, as a validator reads `type` and `nullable`. */
function fitsType(schema: Record<string, JsonValue>, value: JsonValue): boolean {
  const types = typesOf(schema);
  if (types.length === 0) return true;
  if (value === null) return types.includes("null") || schema["nullable"] === true;
  return types.some((type) => {
    switch (type) {
      case "integer":
        return typeof value === "number" && Number.isInteger(value);
      case "number":
        return typeof value === "number";
      case "string":
        return typeof value === "string";
      case "boolean":
        return typeof value === "boolean";
      case "array":
        return Array.isArray(value);
      case "object":
        return isJsonObject(value);
      default:
        return false;
    }
  });
}

function integerFor(schema: Record<string, JsonValue>): fc.Arbitrary<JsonValue> {
  const step = schema["multipleOf"];
  const { min, max } = bounds(schema, true);
  if (typeof step === "number") return numberWithStep(step, true, { min, max });
  // Within what a double holds exactly. A 64-bit bound, which Django and Java
  // APIs declare on every such column, is past it, and fast-check draws such
  // a range forever. A value outside it is one JSON cannot carry exactly
  // either, so nothing a caller can send is left out.
  const low = Math.min(
    Math.max(Math.ceil(min), -Number.MAX_SAFE_INTEGER),
    Number.MAX_SAFE_INTEGER,
  );
  const high = Math.max(Math.min(Math.floor(max), Number.MAX_SAFE_INTEGER), low);
  return fc.integer({ min: low, max: high });
}

/**
 * The declared range, as inclusive bounds. Both OpenAPI spellings of an
 * exclusive bound are read: 3.1's number and 3.0's flag beside the bound.
 */
function bounds(
  schema: Record<string, JsonValue>,
  integral: boolean,
): { min: number; max: number } {
  const unit = integral ? 1 : 0.01;
  let min = -1_000_000;
  let max = 1_000_000;
  if (typeof schema["minimum"] === "number") {
    min =
      schema["exclusiveMinimum"] === true ? schema["minimum"] + unit : schema["minimum"];
  }
  if (typeof schema["exclusiveMinimum"] === "number")
    min = schema["exclusiveMinimum"] + unit;
  if (typeof schema["maximum"] === "number") {
    max =
      schema["exclusiveMaximum"] === true ? schema["maximum"] - unit : schema["maximum"];
  }
  if (typeof schema["exclusiveMaximum"] === "number")
    max = schema["exclusiveMaximum"] - unit;
  return { min, max: Math.max(min, max) };
}

function arbitraryFor(
  document: OpenApiDocument,
  raw: JsonValue,
  depth: number,
): fc.Arbitrary<JsonValue> {
  const resolved = deref(document, raw);
  if (!isJsonObject(resolved)) return fc.constant(null);
  const schema = resolved;

  const constant = schema["const"];
  if (constant !== undefined) return fc.constant(constant);

  const enumValues = schema["enum"];
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    // A value the declared type rules out is not one the schema allows, even
    // listed: drf-spectacular lists null beside `type: string` on every
    // choice field, nullable or not. If the list holds nothing else, it is
    // drawn from as it is and the oracle counts the contradiction.
    const allowed = (enumValues as JsonValue[]).filter((value) =>
      fitsType(schema, value),
    );
    return fc.constantFrom(
      ...(allowed.length > 0 ? allowed : (enumValues as JsonValue[])),
    );
  }

  // One branch, chosen. Whether the value also happens to satisfy another
  // branch of a oneOf is something the oracle judges, not something assumed.
  for (const key of ["oneOf", "anyOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.length > 0) {
      // Keywords beside the union hold whichever branch is taken, as GitHub's
      // `anyOf: [{required: [reviewers]}, {required: [team_reviewers]}]` beside
      // the properties it constrains. Each branch is merged with them first;
      // generating a bare branch lost every property the parent declared.
      const { [key]: _, nullable: __, ...parent } = schema;
      const shared = Object.keys(parent).some((name) => name !== "description");
      const alternatives = branches.map((branch) =>
        shared ? { allOf: [parent, branch as JsonValue] } : (branch as JsonValue),
      );
      const chosen = fc.oneof(
        ...alternatives.map((branch, index) => {
          const value = arbitraryFor(document, branch, depth);
          if (key === "anyOf") return value;
          // oneOf means exactly one. Branches overlap in real contracts, as
          // GitHub's labels body where `{}` is both of its object forms, so a
          // value another branch also accepts is dropped. The probe keeps a
          // branch no value can have to itself from filtering forever.
          const alone = (candidate: JsonValue) =>
            alternatives.every(
              (other, at) =>
                at === index || validateSchema(document, other, candidate).length > 0,
            );
          return fc.sample(value, { numRuns: 32, seed: 0 }).some(alone)
            ? value.filter(alone)
            : value;
        }),
      );
      return schema["nullable"] === true
        ? fc.oneof(
            { weight: 4, arbitrary: chosen },
            { weight: 1, arbitrary: fc.constant(null) },
          )
        : chosen;
    }
  }

  const allOf = schema["allOf"];
  if (Array.isArray(allOf) && allOf.length > 0) {
    // Every branch has to hold at once, so the value is generated from the
    // merged schema, by the same merge the rest of the product reads schemas
    // with. Merging only the object branches lost every other kind: AWS's
    // specifications write nearly each field as allOf of a string and a
    // description, and those came out as `{}`.
    let merged: JsonValue;
    try {
      merged = resolveSchema(document, schema);
    } catch {
      return fc.constant({});
    }
    if (isJsonObject(merged) && merged["allOf"] === undefined) {
      return arbitraryFor(document, merged, depth);
    }
  }

  const types = typesOf(schema);
  // OpenAPI 3.1 says null in the type list; 3.0 says `nullable: true`.
  const nullable = types.includes("null") || schema["nullable"] === true;
  const primary = types.find((type) => type !== "null");

  const base = ((): fc.Arbitrary<JsonValue> => {
    switch (primary) {
      case "string":
        return stringFor(schema);
      case "boolean":
        return fc.boolean();
      case "integer":
        return integerFor(schema);
      case "number": {
        const step = schema["multipleOf"];
        if (typeof step === "number") {
          return numberWithStep(step, false, bounds(schema, false));
        }
        // Without a declared step the contract has not said how precise the
        // value is. Two decimal places is the honest reading of a bare
        // `number` in a payments API, and the property test says so rather
        // than generating a precision nobody promised.
        const { min, max } = bounds(schema, false);
        return numberWithStep(0.01, false).map((value) =>
          Math.min(max, Math.max(min, value as number)),
        );
      }
      case "array": {
        const items = schema["items"];
        const minItems = typeof schema["minItems"] === "number" ? schema["minItems"] : 0;
        if (items === undefined || depth >= HARD_DEPTH) return fc.constant([]);
        if (depth >= MAX_DEPTH) {
          if (minItems === 0) return fc.constant([]);
          return fc.array(arbitraryFor(document, items, depth + 1), {
            minLength: minItems,
            maxLength: minItems,
          });
        }
        const maxItems =
          typeof schema["maxItems"] === "number"
            ? schema["maxItems"]
            : Math.max(minItems, 3);
        return fc.array(arbitraryFor(document, items, depth + 1), {
          minLength: minItems,
          maxLength: Math.min(maxItems, minItems + 3),
        });
      }
      // Also the fallback: a schema with properties but no declared `type` is
      // an object in everything but the declaration, and generating nothing
      // for it would quietly skip whatever it contains.
      default: {
        const properties = schema["properties"];
        const additional = schema["additionalProperties"];
        if (!isJsonObject(properties)) {
          const named = Array.isArray(schema["required"])
            ? (schema["required"] as JsonValue[]).filter(
                (entry): entry is string => typeof entry === "string",
              )
            : [];
          const keys = schema["propertyNames"];
          if (
            (!isJsonObject(additional) && !isJsonObject(keys) && named.length === 0) ||
            depth >= MAX_DEPTH
          ) {
            return fc.constant({});
          }
          const value = isJsonObject(additional)
            ? arbitraryFor(document, additional, depth + 1)
            : fc.string({ maxLength: 8, unit: "grapheme-ascii" });
          // A map: keys the provider chooses, written as `propertyNames` says
          // when it says, and values of one declared shape.
          const key = isJsonObject(keys)
            ? arbitraryFor(document, keys, depth + 1).filter(
                (name): name is string => typeof name === "string",
              )
            : fc.string({ minLength: 1, maxLength: 8, unit: "grapheme-ascii" });
          // A required name with no declared property still has to be there,
          // holding a value the map allows.
          const present = fc.record(
            Object.fromEntries(named.map((name) => [name, value] as const)),
          );
          return fc
            .tuple(fc.dictionary(key, value, { maxKeys: 3 }), present)
            .map(([map, fixed]) => ({ ...map, ...fixed }) as JsonValue);
        }
        if (depth >= HARD_DEPTH) return fc.constant({});
        const minimal = depth >= MAX_DEPTH;

        const required = new Set(
          Array.isArray(schema["required"])
            ? (schema["required"] as JsonValue[]).filter(
                (entry): entry is string => typeof entry === "string",
              )
            : [],
        );

        const entries = Object.entries(properties)
          .filter(([name]) => !minimal || required.has(name))
          .map(([name, child]) => {
            const value = arbitraryFor(document, child, depth + 1);
            return [
              name,
              required.has(name)
                ? value
                : // An optional field that is sometimes absent is the case that
                  // finds missing-slot bugs, so generate both.
                  fc.option(value, { nil: undefined, freq: 4 }),
            ] as const;
          });

        // A required name the schema never describes, as in GitHub's docker
        // metadata requiring `tags` while declaring `tag`, may hold any value
        // under JSON Schema, and still has to be present.
        for (const name of required) {
          if (!(name in properties)) {
            entries.push([name, fc.string({ maxLength: 8, unit: "grapheme-ascii" })]);
          }
        }

        return fc.record(Object.fromEntries(entries)).map((value) => {
          const out: Record<string, JsonValue> = {};
          for (const [name, child] of Object.entries(value)) {
            if (child !== undefined) out[name] = child as JsonValue;
          }
          return out;
        });
      }
    }
  })();

  return nullable
    ? fc.oneof(
        { weight: 4, arbitrary: base },
        { weight: 1, arbitrary: fc.constant(null) },
      )
    : base;
}

/** A generator for values of any schema in a contract, named or written inline. */
export function valueArbitrary(
  document: OpenApiDocument,
  schema: JsonValue,
): fc.Arbitrary<JsonValue> {
  return arbitraryFor(document, schema, 0);
}

/** A generator for values of one named schema in a contract. */
export function schemaArbitrary(
  document: OpenApiDocument,
  ref: string,
): fc.Arbitrary<JsonValue> {
  const resolved = deref(document, { $ref: ref });
  if (!isJsonObject(resolved)) {
    throw new ArbitraryError(`${ref} is not a schema in this contract`);
  }
  return arbitraryFor(document, resolved, 0);
}
