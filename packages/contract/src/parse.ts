/**
 * Specification text to a document, JSON or YAML, with one guard YAML needs.
 *
 * YAML anchors let one node be used in many places, and the parser returns
 * the same object for each use, so a document is a graph rather than a tree
 * until something writes it out. Written out, a few lines of nested aliases
 * can expand past any memory there is. The `yaml` library's own guard counts
 * how often an anchor is used times how deeply it nests, which refuses
 * Langfuse's specification (one anchor reused a few hundred times, harmless)
 * and allows the classic expansion attack (ten uses at each of eight levels).
 * So that guard is off, and the expanded size is measured exactly instead:
 * each shared node is counted once and its size reused, which is linear in
 * the size of the text however large the expansion would be.
 */
import { extname } from "node:path";
import { isJsonObject, type JsonValue } from "@invariant/ir";
import { parse as parseYaml } from "yaml";

/**
 * The most values a document may hold once every alias is written out.
 * Stripe's specification, among the largest published, is about two million.
 */
export const MAX_EXPANDED_VALUES = 50_000_000;

export class DocumentTooLargeError extends Error {
  constructor(values: number) {
    super(
      `The document expands to more than ${MAX_EXPANDED_VALUES.toLocaleString("en")} values ` +
        `through YAML aliases (at least ${values.toLocaleString("en")}), which no real ` +
        "specification does and an expansion attack does.",
    );
    this.name = "DocumentTooLargeError";
  }
}

/** How many values `value` holds written out as a tree, stopping once past `limit`. */
export function expandedSize(value: JsonValue, limit = MAX_EXPANDED_VALUES): number {
  const sizes = new Map<object, number>();
  const measure = (node: JsonValue): number => {
    if (node === null || typeof node !== "object") return 1;
    const known = sizes.get(node);
    if (known !== undefined) return known;
    // Marked before the children are read, so a cycle counts once rather
    // than forever; a cycle cannot be written out at all, and JSON.stringify
    // refuses it on its own.
    sizes.set(node, 1);
    let total = 1;
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      total += measure(child);
      if (total > limit) break;
    }
    sizes.set(node, total);
    return total;
  };
  return measure(value);
}

/** A document from its text, by the file's extension: `.json` is JSON, anything else YAML. */
export function parseDocumentText(path: string, text: string): JsonValue {
  if (extname(path).toLowerCase() === ".json") return JSON.parse(text) as JsonValue;
  const value = parseYaml(text, { maxAliasCount: -1 }) as JsonValue;
  if (isJsonObject(value) || Array.isArray(value)) {
    const size = expandedSize(value);
    if (size > MAX_EXPANDED_VALUES) throw new DocumentTooLargeError(size);
  }
  return value;
}
