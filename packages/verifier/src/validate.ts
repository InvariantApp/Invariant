/**
 * Checking a value against a contract's schema.
 *
 * Used twice, for two questions that turn out to be the same one. Does a
 * transform produce a body the target contract actually allows, and does the
 * provider's running code produce a body its own specification allows? The
 * second is what catches a stale specification, which is the quiet failure that
 * would otherwise make every other check meaningless.
 *
 * The subset understood here is exactly the subset the compiler will accept as
 * a site. A construct outside it is reported rather than skipped, because
 * silently passing something nobody validated is the failure this whole layer
 * exists to prevent.
 */
import { deref, type OpenApiDocument } from "@invariant-app/contract";
import { formatPointer, isJsonObject, type JsonValue } from "@invariant-app/ir";

export interface Violation {
  /** Where in the value, as a JSON Pointer. */
  pointer: string;
  message: string;
  /**
   * The same thing said without the value that broke it, so a report made
   * from real traffic carries nobody's data: the schema's own words, and the
   * kind of the value at most. `invariant observe` prints this one.
   */
  safe: string;
}

function typesOf(schema: Record<string, JsonValue>): string[] {
  const declared = schema["type"];
  if (Array.isArray(declared)) {
    return declared.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof declared === "string") return [declared];
  return [];
}

function typeOf(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function typeSatisfies(actual: string, declared: string): boolean {
  if (actual === declared) return true;
  // Every integer is a valid number; the reverse is not true.
  return actual === "integer" && declared === "number";
}

function stepsCleanly(value: number, step: number): boolean {
  if (step === 0) return true;
  // Comparing in integer space avoids the binary-fraction noise that makes
  // `4.35 % 0.01` non-zero and would report a violation that is not there.
  const places = Math.max(decimalPlaces(value), decimalPlaces(step));
  const factor = 10 ** places;
  return Math.round(value * factor) % Math.round(step * factor) === 0;
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

function walk(
  document: OpenApiDocument,
  raw: JsonValue,
  value: JsonValue,
  segments: string[],
  out: Violation[],
): void {
  const resolved = deref(document, raw);
  if (!isJsonObject(resolved)) return;
  const schema = resolved;
  const pointer = formatPointer(segments) || "/";

  // OpenAPI 3.1 lists null among the types; 3.0 says `nullable: true` beside
  // them, and allows null whatever else the schema says. The generator reads
  // both, so a check that read only one refused values it had just produced.
  if (value === null && schema["nullable"] === true) return;

  const allOf = schema["allOf"];
  if (Array.isArray(allOf)) {
    for (const branch of allOf) walk(document, branch as JsonValue, value, segments, out);
  }

  const enumValues = schema["enum"];
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    const allowed = enumValues as JsonValue[];
    if (!allowed.some((entry) => entry === value)) {
      out.push({
        pointer,
        message: `${JSON.stringify(value)} is not one of ${allowed
          .map((entry) => JSON.stringify(entry))
          .join(", ")}`,
        safe: `not one of the ${allowed.length} values this field allows`,
      });
      return;
    }
  }

  const declared = typesOf(schema);
  if (declared.length > 0) {
    const actual = typeOf(value);
    if (!declared.some((entry) => typeSatisfies(actual, entry))) {
      out.push({
        pointer,
        message: `expected ${declared.join(" or ")}, found ${actual}`,
        safe: `expected ${declared.join(" or ")}, found ${actual}`,
      });
      return;
    }
  }

  if (typeof value === "number") {
    const step = schema["multipleOf"];
    if (typeof step === "number" && !stepsCleanly(value, step)) {
      out.push({
        pointer,
        message: `${value} is not a multiple of ${step}`,
        safe: `not a multiple of ${step}`,
      });
    }
    const minimum = schema["minimum"];
    if (typeof minimum === "number" && value < minimum) {
      out.push({
        pointer,
        message: `${value} is below the minimum of ${minimum}`,
        safe: `below the minimum of ${minimum}`,
      });
    }
    const maximum = schema["maximum"];
    if (typeof maximum === "number" && value > maximum) {
      out.push({
        pointer,
        message: `${value} is above the maximum of ${maximum}`,
        safe: `above the maximum of ${maximum}`,
      });
    }
  }

  if (Array.isArray(value)) {
    const items = schema["items"];
    if (items !== undefined) {
      value.forEach((entry, index) => {
        walk(document, items, entry as JsonValue, [...segments, String(index)], out);
      });
    }
    return;
  }

  if (isJsonObject(value)) {
    const required = schema["required"];
    if (Array.isArray(required)) {
      for (const name of required) {
        if (typeof name === "string" && value[name] === undefined) {
          // At the field that is missing, not at the object around it: what a
          // report points at is what a provider goes and looks for.
          out.push({
            pointer: formatPointer([...segments, name]),
            message: `required field ${name} is missing`,
            safe: `required field ${name} is missing`,
          });
        }
      }
    }

    const properties = schema["properties"];
    if (isJsonObject(properties)) {
      for (const [name, child] of Object.entries(properties)) {
        const entry = value[name];
        if (entry === undefined) continue;
        walk(document, child, entry, [...segments, name], out);
      }

      if (schema["additionalProperties"] === false) {
        for (const name of Object.keys(value)) {
          if (properties[name] === undefined) {
            out.push({
              pointer,
              message: `${name} is not a field of this schema`,
              // The name is a key of the value, and a map's keys can be
              // anyone's identifiers, so it is not repeated here.
              safe: "a field this schema does not describe",
            });
          }
        }
      }
    }
  }
}

/** Every way `value` fails to satisfy the schema at `ref`. Empty means it holds. */
export function validateAgainst(
  document: OpenApiDocument,
  ref: string,
  value: JsonValue,
): Violation[] {
  const out: Violation[] = [];
  walk(document, { $ref: ref }, value, [], out);
  return out;
}

/** The same check against an inline schema rather than a named one. */
export function validateSchema(
  document: OpenApiDocument,
  schema: JsonValue,
  value: JsonValue,
): Violation[] {
  const out: Violation[] = [];
  walk(document, schema, value, [], out);
  return out;
}
