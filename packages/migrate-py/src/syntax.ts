/**
 * Python's syntax, read with tree-sitter.
 *
 * pyright says what a name refers to; it does not say what the code around
 * the name is doing with it. Whether `current_period_end` is being read, set,
 * passed as a keyword or used as a dictionary key decides what a rename does
 * to it, and that is a question about the tree. tree-sitter answers it for any
 * Python version the consumer writes, and keeps going past a syntax error
 * rather than refusing the file, which a migration of someone else's code
 * cannot afford to do.
 *
 * The grammar is tree-sitter-python's own prebuilt WebAssembly, pinned to an
 * exact release and loaded by web-tree-sitter; its native binding is never
 * built or loaded. Offsets are UTF-16 code units, the same as the text's.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Language, type Node, Parser, type Tree } from "web-tree-sitter";

export type { Node, Tree };

const require = createRequire(import.meta.url);

/**
 * The grammar this package was tested against, by digest, so a different
 * build of the same version number is refused rather than trusted.
 */
export const GRAMMAR_SHA256 =
  "16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47";

let loading: Promise<Parser> | undefined;

/** The one parser, loaded once per process. */
export function pythonParser(): Promise<Parser> {
  loading ??= (async () => {
    await Parser.init();
    const bytes = readFileSync(
      require.resolve("tree-sitter-python/tree-sitter-python.wasm"),
    );
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== GRAMMAR_SHA256) {
      throw new Error(
        `tree-sitter-python.wasm is not the grammar this package was built for (${digest})`,
      );
    }
    const parser = new Parser();
    parser.setLanguage(await Language.load(new Uint8Array(bytes)));
    return parser;
  })();
  return loading;
}

export async function parsePython(text: string): Promise<Tree> {
  const tree = (await pythonParser()).parse(text);
  if (!tree) throw new Error("tree-sitter returned no tree");
  return tree;
}

/** The smallest named node spanning `start` to `end`. */
export function nodeAt(tree: Tree, start: number, end = start): Node | undefined {
  return tree.rootNode.namedDescendantForIndex(start, end) ?? undefined;
}

/**
 * The value of a plain string literal: one piece, no interpolation. An
 * f-string, a byte string or implicit concatenation is not a literal a
 * migration can rewrite in place, and returns nothing.
 */
export function stringValue(node: Node | null | undefined): string | undefined {
  if (node?.type !== "string") return undefined;
  if (node.parent?.type === "concatenated_string") return undefined;
  const start = node.children[0];
  if (start?.type !== "string_start") return undefined;
  const prefix = start.text.replace(/["']+$/, "").toLowerCase();
  if (prefix.includes("f") || prefix.includes("b")) return undefined;
  const parts = node.children.slice(1, -1);
  if (parts.some((part) => part?.type !== "string_content")) return undefined;
  const raw = parts.map((part) => part?.text ?? "").join("");
  if (prefix.includes("r") || !raw.includes("\\")) return raw;
  // Only the escapes a field name or a version could contain are read; any
  // other makes the value something this is not the place to decode.
  if (/\\[^\\'"]/.test(raw)) return undefined;
  return raw.replace(/\\(.)/g, "$1");
}

/** The same string literal with a new value, in the quotes it was written with. */
export function withStringValue(node: Node, value: string): string {
  const start = node.children[0]?.text ?? '"';
  const quote = start.replace(/^[a-zA-Z]*/, "");
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replaceAll(quote[0] as string, `\\${quote[0]}`);
  return `${start}${escaped}${quote}`;
}

/**
 * What the code does with a name at a reference: every role a field of an
 * SDK's model can play in Python source.
 */
export type PyRole =
  /** `sub.status`, anywhere it is read. */
  | "attribute-read"
  /** `sub.status = value`, `del sub.status`, `sub.status += 1`. */
  | "attribute-write"
  /** `create(status=value)` */
  | "keyword"
  /** `{"status": value}` */
  | "dict-key"
  /** `sub["status"]`, by a string that names the field. */
  | "subscript"
  /** Anything else: a string compared somewhere, a name in an import. */
  | "unknown";

/**
 * The role of the identifier or string at `node`: the node pyright reported
 * a reference at, or one found by name.
 */
export function roleOf(node: Node): PyRole {
  const parent = node.parent;
  if (!parent) return "unknown";
  if (node.type === "identifier" && parent.type === "attribute") {
    if (parent.childForFieldName("attribute")?.id !== node.id) return "unknown";
    const holder = parent.parent;
    const written =
      (holder?.type === "assignment" || holder?.type === "augmented_assignment") &&
      holder.childForFieldName("left")?.id === parent.id;
    const deleted = holder?.type === "delete_statement";
    return written || deleted ? "attribute-write" : "attribute-read";
  }
  if (node.type === "identifier" && parent.type === "keyword_argument") {
    return parent.childForFieldName("name")?.id === node.id ? "keyword" : "unknown";
  }
  const literal =
    node.type === "string" ? node : parent.type === "string" ? parent : undefined;
  if (literal) {
    const holder = literal.parent;
    if (holder?.type === "pair" && holder.childForFieldName("key")?.id === literal.id) {
      return "dict-key";
    }
    if (
      holder?.type === "subscript" &&
      holder.childForFieldName("subscript")?.id === literal.id
    ) {
      return "subscript";
    }
  }
  return "unknown";
}

/** Statements that are one thing to fix, whatever lines they span. */
const SIMPLE_STATEMENTS = new Set([
  "expression_statement",
  "return_statement",
  "assert_statement",
  "raise_statement",
  "delete_statement",
  "import_statement",
  "import_from_statement",
  "future_import_statement",
  "global_statement",
  "nonlocal_statement",
  "type_alias_statement",
]);

/** Statements that hold others: showing one whole would be showing a function. */
const COMPOUND_STATEMENTS = new Set([
  "if_statement",
  "for_statement",
  "while_statement",
  "try_statement",
  "with_statement",
  "match_statement",
  "function_definition",
  "class_definition",
  "decorated_definition",
  "block",
  "module",
]);

/**
 * The simple statement around `start` to `end`, or the span itself where it
 * is in a compound statement's header, such as an `if`'s condition.
 */
export function statementAround(
  tree: Tree,
  start: number,
  end: number,
): { start: number; end: number } {
  let node: Node | null = tree.rootNode.descendantForIndex(start, Math.max(start, end));
  while (node) {
    if (SIMPLE_STATEMENTS.has(node.type)) {
      return { start: node.startIndex, end: node.endIndex };
    }
    if (COMPOUND_STATEMENTS.has(node.type)) break;
    node = node.parent;
  }
  return { start, end };
}

/** Every node below `root` of one of `types`, in source order. */
export function descendantsOfType(root: Node, types: readonly string[]): Node[] {
  return root.descendantsOfType([...types]).filter((node): node is Node => node !== null);
}

/**
 * The module names a source file imports: `stripe` for `import stripe`,
 * `from stripe import X` and `import stripe.error as e`.
 */
export function importedModules(tree: Tree): Set<string> {
  const found = new Set<string>();
  for (const node of descendantsOfType(tree.rootNode, [
    "import_statement",
    "import_from_statement",
  ])) {
    if (node.type === "import_from_statement") {
      const module = node.childForFieldName("module_name");
      if (module) found.add(module.text.split(".")[0] as string);
      continue;
    }
    for (const name of node.childrenForFieldName("name")) {
      if (!name) continue;
      const dotted =
        name.type === "aliased_import" ? name.childForFieldName("name") : name;
      if (dotted) found.add(dotted.text.split(".")[0] as string);
    }
  }
  return found;
}
