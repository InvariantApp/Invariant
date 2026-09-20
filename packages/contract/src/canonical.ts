import { createHash } from "node:crypto";
import { isJsonObject, type JsonValue } from "@invariant/ir";

/**
 * RFC 8785 JSON Canonicalization Scheme.
 *
 * Object keys sort by UTF-16 code unit, which is exactly what the default
 * string sort does, and numbers serialize the ECMAScript way, which is what
 * `JSON.stringify` already emits for every finite double. Canonicalization is
 * for artifacts only: it must never touch an API payload, because the number
 * rules here would undo any precision a payload had preserved.
 */
export function canonicalize(value: JsonValue): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Cannot canonicalize a non-finite number: ${value}`);
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;

  const keys = Object.keys(value).sort();
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key] as JsonValue)}`)
    .join(",");
  return `{${body}}`;
}

export function digestOf(value: JsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalize(value), "utf8").digest("hex")}`;
}

/**
 * Fields that describe an API but do not constrain the wire. They are excluded
 * from the digest so that editing a description does not mint a new contract.
 */
const NON_WIRE_KEYS = new Set(["description", "summary", "example", "examples", "title"]);

export function stripNonWire(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(stripNonWire);
  if (!isJsonObject(value)) return value;

  const out: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    if (NON_WIRE_KEYS.has(key)) continue;
    out[key] = stripNonWire(child);
  }
  return out;
}
