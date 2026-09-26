/**
 * Arguments built before the call they are passed to.
 *
 * Python code often assembles a call's keyword arguments as a dictionary and
 * unpacks it: `raw_request = {"engine": ..., "prompt": ...}` and then
 * `openai.Completion.create(**raw_request)`. The type checker reads the
 * dictionary as `Dict[str, Any]` and checks none of its keys against the
 * function, so an upgrade that renames or drops a parameter breaks the call
 * with nothing to show for it, and one that removes the function shows only
 * the call, not the dictionary a person has to rewrite.
 *
 * What the dictionary holds is read from the syntax tree, never guessed: the
 * name must be bound in its scope to dictionary literals and nothing else,
 * and every key must be a plain string. Such a dictionary is exactly the
 * call's keywords, and the checker is asked about them as keywords: the
 * file is checked again with `**raw_request` written out as
 * `engine=raw_request["engine"], prompt=raw_request["prompt"]`, against the
 * old release and the new one. A key the new release rejects and the old
 * one took is shown where it is written. Nothing is edited: which parameter
 * replaces a dropped one is the SDK's to say.
 */
import type { ManualSite } from "@invariant-app/migrate-core";
import { manualAt, shownExtent } from "./engine.ts";
import type { Diagnostic } from "./pyright.ts";
import {
  descendantsOfType,
  enclosing,
  type Node,
  stringValue,
  type Tree,
} from "./syntax.ts";

const UPGRADE = "sdk-upgrade";

/** A key of a dictionary a call unpacks, and where it is written. */
export interface UnpackedKey {
  key: string;
  /** The `"key": value` pair, or the statement that adds the key. */
  node: Node;
}

/** A call that unpacks a dictionary built from literals as its keyword arguments. */
export interface Unpacking {
  call: Node;
  /** The `**name` argument. */
  splat: Node;
  /** The name unpacked, or nothing for a literal written in the call. */
  name: string | undefined;
  /** The literals the name is bound to, or the one written in the call. */
  literals: Node[];
  keys: UnpackedKey[];
}

const SCOPES = new Set(["function_definition", "lambda", "module"]);

/** The function, lambda or module whose scope a node is in. */
function scopeOf(node: Node): Node {
  let current = node.parent;
  while (current && !SCOPES.has(current.type)) current = current.parent;
  return current ?? node.tree.rootNode;
}

/** Nodes of `types` in `scope`, not inside a function nested in it. */
function ownNodes(scope: Node, types: readonly string[]): Node[] {
  return descendantsOfType(scope, types).filter((node) => scopeOf(node).id === scope.id);
}

/** The assignments in `scope` that bind `name` as a whole. */
function assignmentsOf(scope: Node, name: string): Node[] {
  return ownNodes(scope, ["assignment", "augmented_assignment"]).filter((node) => {
    const left = node.childForFieldName("left");
    return left?.type === "identifier" && left.text === name;
  });
}

/** Whether `scope` binds `name` other than by assignment, as a parameter or a loop variable does. */
function bindsOtherwise(scope: Node, name: string): boolean {
  if (scope.type !== "module") {
    const parameters = scope.childForFieldName("parameters");
    for (const parameter of parameters?.namedChildren ?? []) {
      const named =
        parameter?.type === "identifier"
          ? parameter
          : (parameter?.childForFieldName("name") ??
            parameter?.namedChildren.find((child) => child?.type === "identifier"));
      if (named?.text === name) return true;
    }
  }
  const targets = ownNodes(scope, [
    "for_statement",
    "with_item",
    "as_pattern",
    "global_statement",
    "nonlocal_statement",
    "import_statement",
    "import_from_statement",
  ]);
  return targets.some((node) =>
    descendantsOfType(
      (node.type === "for_statement" ? node.childForFieldName("left") : node) ?? node,
      ["identifier"],
    ).some((identifier) => identifier.text === name),
  );
}

/**
 * The scope a name used at `use` is bound in, by Python's rule: the nearest
 * enclosing function that assigns it, else the module. A name a scope binds
 * some other way (a parameter, a loop) is not one this can follow.
 */
function bindingScope(use: Node, name: string): Node | undefined {
  let scope: Node | undefined = scopeOf(use);
  while (scope) {
    if (bindsOtherwise(scope, name)) return undefined;
    if (assignmentsOf(scope, name).length > 0) return scope;
    if (scope.type === "module") return undefined;
    scope = scopeOf(scope);
  }
  return undefined;
}

/** The string keys of a dictionary literal, or nothing where one is not a plain string. */
function literalKeys(literal: Node): UnpackedKey[] | undefined {
  const keys: UnpackedKey[] = [];
  if (literal.type === "dictionary") {
    for (const child of literal.namedChildren) {
      if (!child || child.type === "comment") continue;
      if (child.type !== "pair") return undefined;
      const key = stringValue(child.childForFieldName("key"));
      if (key === undefined) return undefined;
      keys.push({ key, node: child });
    }
    return keys;
  }
  // `dict(engine=..., prompt=...)`
  const callee = literal.childForFieldName("function");
  if (literal.type !== "call" || callee?.type !== "identifier" || callee.text !== "dict")
    return undefined;
  for (const argument of literal.childForFieldName("arguments")?.namedChildren ?? []) {
    if (!argument || argument.type === "comment") continue;
    if (argument.type !== "keyword_argument") return undefined;
    const name = argument.childForFieldName("name");
    if (!name) return undefined;
    keys.push({ key: name.text, node: argument });
  }
  return keys;
}

/** Keys a scope adds to `name` after building it: `name["k"] = v` and `name.update(k=v)`. */
function addedKeys(scope: Node, name: string): UnpackedKey[] | undefined {
  const keys: UnpackedKey[] = [];
  for (const assignment of ownNodes(scope, ["assignment"])) {
    const left = assignment.childForFieldName("left");
    if (left?.type !== "subscript" || left.childForFieldName("value")?.text !== name)
      continue;
    const key = stringValue(left.childForFieldName("subscript"));
    if (key === undefined) return undefined;
    keys.push({ key, node: assignment.parent ?? assignment });
  }
  // A key taken out again could be one the call never sees.
  for (const statement of ownNodes(scope, ["delete_statement"])) {
    if (
      descendantsOfType(statement, ["subscript"]).some(
        (subscript) => subscript.childForFieldName("value")?.text === name,
      )
    )
      return undefined;
  }
  for (const call of ownNodes(scope, ["call"])) {
    const callee = call.childForFieldName("function");
    if (callee?.type !== "attribute" || callee.childForFieldName("object")?.text !== name)
      continue;
    const method = callee.childForFieldName("attribute")?.text ?? "";
    if (["pop", "popitem", "clear"].includes(method)) return undefined;
    if (!["update", "setdefault"].includes(method)) continue;
    const args = call.childForFieldName("arguments")?.namedChildren ?? [];
    if (method === "setdefault") {
      const key = stringValue(args[0]);
      if (key === undefined) return undefined;
      keys.push({ key, node: call.parent ?? call });
      continue;
    }
    for (const argument of args) {
      if (!argument || argument.type === "comment") continue;
      const found =
        argument.type === "keyword_argument"
          ? [
              {
                key: argument.childForFieldName("name")?.text ?? "",
                node: argument,
              },
            ]
          : literalKeys(argument);
      if (!found) return undefined;
      keys.push(...found);
    }
  }
  return keys;
}

/**
 * The dictionary an expression is, where every key of it is known: a literal
 * written in place, or a name its scope binds to literals and nothing else,
 * with the keys it adds after.
 */
export function dictionaryAt(
  value: Node,
): { name: string | undefined; literals: Node[]; keys: UnpackedKey[] } | undefined {
  if (value.type !== "identifier") {
    // `{"engine": ...}` or `dict(engine=...)`, written in place.
    const keys = literalKeys(value);
    return keys ? { name: undefined, literals: [value], keys } : undefined;
  }
  const scope = bindingScope(value, value.text);
  if (!scope) return undefined;
  const literals: Node[] = [];
  for (const assignment of assignmentsOf(scope, value.text)) {
    // `raw_request: Dict[str, Any]` declares and binds nothing.
    const right = assignment.childForFieldName("right");
    if (!right) continue;
    if (assignment.type === "augmented_assignment" || !literalKeys(right))
      return undefined;
    literals.push(right);
  }
  const added = addedKeys(scope, value.text);
  if (literals.length === 0 || !added) return undefined;
  return {
    name: value.text,
    literals,
    keys: [...literals.flatMap((literal) => literalKeys(literal) ?? []), ...added],
  };
}

/** Every call in a file that unpacks a dictionary whose keys are all known. */
export function unpackingsIn(tree: Tree): Unpacking[] {
  const found: Unpacking[] = [];
  for (const splat of descendantsOfType(tree.rootNode, ["dictionary_splat"])) {
    const args = splat.parent;
    const call = args?.parent;
    if (args?.type !== "argument_list" || call?.type !== "call") continue;
    const value = splat.namedChildren[0];
    const dictionary = value && dictionaryAt(value);
    if (dictionary) found.push({ call, splat, ...dictionary });
  }
  return found;
}

/**
 * Whether the name a dictionary is unpacked from is used for nothing but
 * building it and unpacking it: bound, given keys, updated and passed on
 * with `**`. A dictionary read, returned or handed anywhere else holds its
 * keys for more than the one call, and renaming one is not the call's to do.
 */
export function onlyUnpacked(unpacking: Unpacking): boolean {
  const name = unpacking.name;
  if (name === undefined) return true;
  const value = unpacking.splat.namedChildren[0];
  const scope = value && bindingScope(value, name);
  if (!scope) return false;
  return descendantsOfType(scope, ["identifier"]).every((identifier) => {
    if (identifier.text !== name) return true;
    const parent = identifier.parent;
    if (!parent) return false;
    if (parent.id === unpacking.splat.id) return true;
    if (
      (parent.type === "assignment" || parent.type === "augmented_assignment") &&
      parent.childForFieldName("left")?.id === identifier.id
    )
      return parent.type === "assignment";
    // `params["key"] = value`
    if (
      parent.type === "subscript" &&
      parent.childForFieldName("value")?.id === identifier.id &&
      parent.parent?.type === "assignment" &&
      parent.parent.childForFieldName("left")?.id === parent.id
    )
      return true;
    // `params.update(...)` and `params.setdefault(...)`
    return (
      parent.type === "attribute" &&
      parent.childForFieldName("object")?.id === identifier.id &&
      ["update", "setdefault"].includes(
        parent.childForFieldName("attribute")?.text ?? "",
      ) &&
      parent.parent?.type === "call" &&
      parent.parent.childForFieldName("function")?.id === parent.id
    );
  });
}

/** The key's own token in the statement that gives a dictionary a key. */
export function keyToken(key: UnpackedKey): Node | undefined {
  const node = key.node;
  if (node.type === "pair") return node.childForFieldName("key") ?? undefined;
  if (node.type === "keyword_argument")
    return node.childForFieldName("name") ?? undefined;
  // `params["key"] = value`, and `params.setdefault("key", value)`, as statements.
  const inner = node.type === "expression_statement" ? node.namedChildren[0] : node;
  if (inner?.type === "assignment") {
    return inner.childForFieldName("left")?.childForFieldName("subscript") ?? undefined;
  }
  if (inner?.type === "call") {
    return inner.childForFieldName("arguments")?.namedChildren[0] ?? undefined;
  }
  return undefined;
}

/** A keyword written out in the checked copy, and the key it stands for. */
export interface Written {
  start: number;
  end: number;
  key: UnpackedKey;
  unpacking: Unpacking;
}

/**
 * The text with each unpacking's `**name` written out as keywords, and where
 * each keyword is. A key the call also passes by name is left out, since
 * written twice it would be an error of its own.
 */
export function writtenOut(
  text: string,
  unpackings: readonly Unpacking[],
): { text: string; written: Written[] } {
  const written: Written[] = [];
  let out = "";
  let at = 0;
  const ordered = [...unpackings].sort((a, b) => a.splat.startIndex - b.splat.startIndex);
  for (const unpacking of ordered) {
    const named = new Set(
      (unpacking.call.childForFieldName("arguments")?.namedChildren ?? []).flatMap(
        (argument) =>
          argument?.type === "keyword_argument"
            ? [argument.childForFieldName("name")?.text ?? ""]
            : [],
      ),
    );
    const seen = new Set<string>();
    const parts: string[] = [];
    out += text.slice(at, unpacking.splat.startIndex);
    let offset = out.length;
    for (const key of unpacking.keys) {
      if (named.has(key.key) || seen.has(key.key) || !/^[A-Za-z_]\w*$/.test(key.key))
        continue;
      seen.add(key.key);
      const value = unpacking.name
        ? `${unpacking.name}[${JSON.stringify(key.key)}]`
        : "None";
      const part = `${key.key}=${value}`;
      if (parts.length > 0) offset += 2;
      written.push({ start: offset, end: offset + key.key.length, key, unpacking });
      offset += part.length;
      parts.push(part);
    }
    // A dictionary with no keys left to write still unpacks as nothing.
    out += parts.length > 0 ? parts.join(", ") : unpacking.splat.text;
    at = unpacking.splat.endIndex;
  }
  out += text.slice(at);
  return { text: out, written };
}

/** The keywords among `written` the checker says the call takes no parameter for. */
export function rejected(
  text: string,
  written: readonly Written[],
  diagnostics: readonly Diagnostic[],
): Set<Written> {
  const lines: number[] = [0];
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) {
    lines.push(at + 1);
  }
  const offsetOf = (line: number, character: number) => (lines[line] ?? 0) + character;
  const found = new Set<Written>();
  for (const diagnostic of diagnostics) {
    if ((diagnostic.code ?? diagnostic.rule) !== "reportCallIssue") continue;
    const parameter = /No parameter named "(\w+)"/.exec(diagnostic.message)?.[1];
    if (!parameter) continue;
    const start = offsetOf(diagnostic.range.start.line, diagnostic.range.start.character);
    const end = offsetOf(diagnostic.range.end.line, diagnostic.range.end.character);
    for (const keyword of written) {
      if (
        keyword.key.key === parameter &&
        keyword.start < Math.max(end, start + 1) &&
        start < keyword.end
      ) {
        found.add(keyword);
      }
    }
  }
  return found;
}

/** A readable name for a call's callee: `openai.Completion.create`. */
function calleeName(call: Node): string {
  return (call.childForFieldName("function")?.text ?? "the call").replace(/\s+/g, "");
}

/** The line a node starts on, 1-based. */
const lineOf = (node: Node) => node.startPosition.row + 1;

/** A dictionary behind a key the new release rejects, shown where the key is written. */
export function rejectedKeySite(
  file: string,
  original: string,
  keyword: Written,
  back: (offset: number) => number,
): ManualSite {
  const { key, unpacking } = keyword;
  const through = unpacking.name ? ` through \`${unpacking.name}\`` : "";
  return manualAt(
    file,
    original,
    back(key.node.startIndex),
    back(key.node.endIndex),
    UPGRADE,
    `\`${key.key}\` reaches \`${calleeName(unpacking.call)}\` as a keyword argument${through} (line ${lineOf(unpacking.call)}), and the upgraded SDK takes no parameter named \`${key.key}\` there`,
  );
}

/**
 * The dictionaries a call that no longer type-checks unpacks, shown whole:
 * where the callee itself broke (`openai.Completion` gone in openai 1.0), the
 * dictionary is the part of the call a person rewrites, and the checker
 * points only at the name.
 */
export function unpackedIntoBroken(
  file: string,
  original: string,
  tree: Tree,
  /** The error, as an offset range in `tree`'s text. */
  start: number,
  end: number,
  said: string,
  back: (offset: number) => number,
): ManualSite[] {
  const call = enclosing(tree, start, "call");
  const callee = call?.childForFieldName("function");
  if (!call || !callee || start < callee.startIndex || end > callee.endIndex) return [];
  return unpackingsIn(tree)
    .filter((unpacking) => unpacking.call.id === call.id)
    .flatMap((unpacking) =>
      unpacking.literals.map((literal) =>
        manualAt(
          file,
          original,
          back(literal.startIndex),
          back(literal.endIndex),
          UPGRADE,
          `these are the keyword arguments of \`${calleeName(call)}\` (line ${lineOf(call)}), which no longer type-checks against the upgraded SDK: ${said}`,
          back(start),
        ),
      ),
    );
}

/** What checks a stand-in for a source (`PyrightReferences.errorsAs`). */
export interface Checks {
  errorsAs(file: string, text: string): Promise<Diagnostic[]>;
}

/** Which calls reach the SDK, asked of the checker holding the old release. */
export interface Resolves {
  definitionAt(
    file: string,
    offset: number,
  ): Promise<({ start: number } | { file: string; line: number })[]>;
}

/** The unpackings in each file whose callee the checker resolves into `sdk`. */
export async function sdkUnpackings(
  resolves: Resolves,
  trees: ReadonlyMap<string, Tree>,
  sdk: string,
): Promise<Map<string, Unpacking[]>> {
  const found = new Map<string, Unpacking[]>();
  for (const [file, tree] of trees) {
    const mine: Unpacking[] = [];
    for (const unpacking of unpackingsIn(tree)) {
      const callee = unpacking.call.childForFieldName("function");
      const name =
        callee?.type === "attribute" ? callee.childForFieldName("attribute") : callee;
      if (!name) continue;
      const points = await resolves.definitionAt(file, name.startIndex);
      if (points.some((point) => "line" in point && point.file.startsWith(sdk))) {
        mine.push(unpacking);
      }
    }
    if (mine.length > 0) found.set(file, mine);
  }
  return found;
}

/** Each written-out key the checker rejects, as `call:key` offsets in the file as read. */
export async function rejectedKeys(
  checks: Checks,
  file: string,
  text: string,
  unpackings: readonly Unpacking[],
): Promise<Map<string, Written>> {
  const out = writtenOut(text, unpackings);
  const found = new Map<string, Written>();
  if (out.written.length === 0) return found;
  const diagnostics = await checks.errorsAs(file, out.text);
  for (const keyword of rejected(out.text, out.written, diagnostics)) {
    found.set(
      `${keyword.unpacking.call.startIndex}:${keyword.key.node.startIndex}`,
      keyword,
    );
  }
  return found;
}

/**
 * Every use of a module-level name in a file, read from the tree: the checker
 * gives an import it cannot resolve no references. A name bound anywhere
 * else in the file as well, which could make some use another thing, gives
 * none.
 */
export function usesOfImported(tree: Tree, name: string, statement: Node): Node[] {
  const uses: Node[] = [];
  for (const identifier of descendantsOfType(tree.rootNode, ["identifier"])) {
    if (identifier.text !== name) continue;
    if (
      identifier.startIndex >= statement.startIndex &&
      identifier.endIndex <= statement.endIndex
    )
      continue;
    const parent = identifier.parent;
    if (!parent) continue;
    // `x.Widget` and `f(Widget=1)` name something else.
    if (
      parent.type === "attribute" &&
      parent.childForFieldName("attribute")?.id === identifier.id
    )
      continue;
    if (
      parent.type === "keyword_argument" &&
      parent.childForFieldName("name")?.id === identifier.id
    )
      continue;
    const binds =
      (["assignment", "augmented_assignment", "for_statement", "for_in_clause"].includes(
        parent.type,
      ) &&
        parent.childForFieldName("left")?.id === identifier.id) ||
      (["function_definition", "class_definition"].includes(parent.type) &&
        parent.childForFieldName("name")?.id === identifier.id) ||
      [
        "parameters",
        "default_parameter",
        "typed_parameter",
        "typed_default_parameter",
        "lambda_parameters",
        "as_pattern_target",
        "global_statement",
        "nonlocal_statement",
        "dotted_name",
        "aliased_import",
        "pattern_list",
        "tuple_pattern",
        "list_pattern",
      ].includes(parent.type);
    if (binds) return [];
    uses.push(identifier);
  }
  return uses;
}

/**
 * The uses of a name whose import the upgraded SDK no longer satisfies.
 *
 * The checker reports the import (`"V1beta1CustomResourceDefinition" is
 * unknown import symbol`) and then types every use of the name as unknown,
 * so the uses report nothing. They are what a person rewrites: Yelp's paasta
 * built its CustomResourceDefinitions from kubernetes' v1beta1 class, and
 * kubernetes 24 dropped it with the API group. A use that constructs or
 * calls it is shown as the whole call, which is the thing to rewrite however
 * many lines it spans.
 */
export function usesOfRemoved(
  file: string,
  original: string,
  /** The file as checked, and its tree. */
  text: string,
  tree: Tree,
  diagnostic: Diagnostic,
  /** Where the error starts in `text`. */
  start: number,
  back: (offset: number) => number,
): ManualSite[] {
  const removed = /"(\w+)" is unknown import symbol/.exec(diagnostic.message)?.[1];
  if (!removed) return [];
  const statement = enclosing(tree, start, "import_from_statement");
  if (!statement) return [];
  // `from kubernetes.client import V1beta1X as X` is used as `X`.
  const aliased = enclosing(tree, start, "aliased_import");
  const local =
    aliased && aliased.startIndex >= statement.startIndex
      ? (aliased.childForFieldName("alias")?.text ?? removed)
      : removed;
  const importLine = text.slice(0, statement.startIndex).split("\n").length;
  return usesOfImported(tree, local, statement).map((node) => {
    const call =
      node.parent?.type === "call" &&
      node.parent.childForFieldName("function")?.id === node.id
        ? node.parent
        : undefined;
    const extent = call
      ? { start: call.startIndex, end: call.endIndex }
      : shownExtent(tree, text, node.startIndex, node.endIndex);
    return manualAt(
      file,
      original,
      back(extent.start),
      back(extent.end),
      UPGRADE,
      `\`${removed}\` is no longer in the upgraded SDK (its import on line ${importLine} fails), and this ${call ? "calls" : "uses"} it`,
      back(node.startIndex),
    );
  });
}
