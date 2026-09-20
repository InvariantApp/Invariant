export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A JSON Pointer (RFC 6901) extended with a single wildcard segment `*` that
 * matches every element of an array. Nothing else is allowed: the path
 * language stays small enough to resolve against a schema at compile time and
 * to execute without a parser at request time.
 */
export type Pointer = string;

const ESCAPES: Record<string, string> = { "~0": "~", "~1": "/" };

export class PointerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PointerError";
  }
}

export function parsePointer(pointer: Pointer): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new PointerError(`JSON Pointer must start with "/": ${pointer}`);
  }
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~[01]/g, (match) => ESCAPES[match] as string));
}

export function formatPointer(segments: readonly string[]): Pointer {
  if (segments.length === 0) return "";
  return `/${segments
    .map((segment) => segment.replace(/~/g, "~0").replace(/\//g, "~1"))
    .join("/")}`;
}

export function pointerHasWildcard(pointer: Pointer): boolean {
  return parsePointer(pointer).includes("*");
}

/** Number of leading segments shared by two pointers. */
export function commonPrefixLength(a: readonly string[], b: readonly string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}
