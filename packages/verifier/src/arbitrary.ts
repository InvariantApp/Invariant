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
import { deref, type OpenApiDocument } from "@invariant/contract";
import { isJsonObject, type JsonValue } from "@invariant/ir";
import fc from "fast-check";

export class ArbitraryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArbitraryError";
  }
}

/** How deep to follow nested objects before giving up on a recursive schema. */
const MAX_DEPTH = 6;

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

  const minLength = typeof schema["minLength"] === "number" ? schema["minLength"] : 0;
  const maxLength =
    typeof schema["maxLength"] === "number"
      ? schema["maxLength"]
      : Math.max(minLength, 24);
  const pattern = schema["pattern"];
  if (typeof pattern === "string") {
    try {
      // Generated to match the declared pattern, and then held to the declared
      // length too, since a real API enforces both.
      return fc
        .stringMatching(new RegExp(pattern, "u"))
        .filter((text) => text.length >= minLength && text.length <= maxLength);
    } catch {
      // A pattern JavaScript cannot compile. Fall through to plain text, which
      // the oracle will then refuse, so the gap is counted rather than hidden.
    }
  }
  // Printable ASCII only. A transform never inspects text, and unprintable
  // characters make a counterexample far harder to read than it needs to be.
  return fc.string({ minLength, maxLength, unit: "grapheme-ascii" });
}

function integerFor(schema: Record<string, JsonValue>): fc.Arbitrary<JsonValue> {
  const step = schema["multipleOf"];
  const { min, max } = bounds(schema, true);
  if (typeof step === "number") return numberWithStep(step, true, { min, max });
  return fc.integer({ min: Math.ceil(min), max: Math.floor(max) });
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
    return fc.constantFrom(...(enumValues as JsonValue[]));
  }

  // One branch, chosen. Whether the value also happens to satisfy another
  // branch of a oneOf is something the oracle judges, not something assumed.
  for (const key of ["oneOf", "anyOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.length > 0) {
      const chosen = fc.oneof(
        ...branches.map((branch) => arbitraryFor(document, branch as JsonValue, depth)),
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
    // Every branch has to hold at once, so generate each and merge. Only
    // object branches compose this way, which matches what the compiler
    // accepts as a site in the first place.
    return fc
      .tuple(...allOf.map((branch) => arbitraryFor(document, branch as JsonValue, depth)))
      .map((parts) => {
        const merged: Record<string, JsonValue> = {};
        for (const part of parts) {
          if (isJsonObject(part)) Object.assign(merged, part);
        }
        return merged;
      });
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
        if (depth >= MAX_DEPTH) return fc.constant([]);
        const items = schema["items"];
        if (items === undefined) return fc.constant([]);
        const minItems = typeof schema["minItems"] === "number" ? schema["minItems"] : 0;
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
          // A map: keys the provider chooses, values of one declared shape.
          if (isJsonObject(additional) && depth < MAX_DEPTH) {
            return fc.dictionary(
              fc.string({ minLength: 1, maxLength: 8, unit: "grapheme-ascii" }),
              arbitraryFor(document, additional, depth + 1),
              { maxKeys: 3 },
            );
          }
          return fc.constant({});
        }
        if (depth >= MAX_DEPTH) return fc.constant({});

        const required = new Set(
          Array.isArray(schema["required"])
            ? (schema["required"] as JsonValue[]).filter(
                (entry): entry is string => typeof entry === "string",
              )
            : [],
        );

        const entries = Object.entries(properties).map(([name, child]) => {
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
