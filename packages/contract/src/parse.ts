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
 *
 * Providers publish YAML that strict YAML 1.2 refuses and every tool they use
 * reads, and a document nobody can load gates nothing. Two such departures are
 * read, each only where it loses nothing:
 *
 * - a key defined twice in one mapping, when both definitions are the same
 *   text, as Okta's specification defines three path parameters twice. Two
 *   different definitions are refused, since keeping either would be a guess.
 * - text the `yaml` library refuses, read again with js-yaml, which Swagger UI
 *   and most OpenAPI tooling use: Mistral's specification closes a multi-line
 *   quoted example at the first column. Both read YAML 1.2's core schema, and a
 *   document the first reads is never read by the second, so no document can
 *   read one way in one version and another way in the next.
 */
import { extname } from "node:path";
import { isJsonObject, type JsonValue } from "@invariant-app/ir";
import { CORE_SCHEMA, load as loadYaml } from "js-yaml";
import { isMap, isScalar, isSeq, type Node, parseDocument } from "yaml";

export class DuplicateKeyError extends Error {
  constructor(key: string, line: number) {
    super(
      `\`${key}\` is defined twice in the same mapping, differently (the second at line ${line}). ` +
        "YAML allows a key once; keeping either definition would be a guess about which is meant.",
    );
    this.name = "DuplicateKeyError";
  }
}

/** Every key defined twice in one mapping, refused unless its definitions are the same text. */
function checkDuplicates(node: unknown, lineOf: (offset: number) => number): void {
  if (isMap(node)) {
    const seen = new Map<string, string>();
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      const text = String(pair.value ?? "");
      const earlier = seen.get(key);
      if (earlier !== undefined && earlier !== text) {
        const offset = (pair.key as Node | null)?.range?.[0] ?? 0;
        throw new DuplicateKeyError(key, lineOf(offset));
      }
      seen.set(key, text);
      checkDuplicates(pair.value, lineOf);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) checkDuplicates(item, lineOf);
  }
}

function readYaml(text: string): JsonValue {
  const document = parseDocument(text, { uniqueKeys: false });
  const [error] = document.errors;
  if (error) {
    try {
      return loadYaml(text, { schema: CORE_SCHEMA }) as JsonValue;
    } catch {
      // Neither reads it: the first reader's message is the more precise.
      throw error;
    }
  }
  checkDuplicates(
    document.contents,
    (offset) => text.slice(0, offset).split("\n").length,
  );
  return document.toJS({ maxAliasCount: -1 }) as JsonValue;
}

/**
 * The most values a document may hold once every alias is written out, which
 * it then is. Stripe's specification, among the largest published, is about
 * two million.
 */
export const MAX_EXPANDED_VALUES = 10_000_000;

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
  const value = readYaml(text);
  if (!isJsonObject(value) && !Array.isArray(value)) return value;
  const size = expandedSize(value);
  if (size > MAX_EXPANDED_VALUES) throw new DocumentTooLargeError(size);
  // Written out once, now that it is known to be small enough, so no two
  // places in the document are the same object. Everything downstream edits
  // documents in place, and an anchor shared by two operations would carry
  // an edit to one into the other.
  // Only a document with an alias can share anything, and one is written
  // `*name`; a star in a pattern or a description costs one copy, no more.
  return text.includes("*") ? (JSON.parse(JSON.stringify(value)) as JsonValue) : value;
}
