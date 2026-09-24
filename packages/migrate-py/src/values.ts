/**
 * Values a parameter no longer takes, written as literals.
 *
 * An SDK declares a parameter's vocabulary: openai-python's `model` is
 * `Union[str, ChatModel]`, and `ChatModel` lists the models the API offers.
 * When a release drops a model from that list, the API has retired it, and a
 * consumer still sending `model="gpt-4-32k"` is sending a value that is gone.
 * The checker never says so: the parameter takes any text as well, so the
 * literal type-checks against both releases.
 *
 * So the vocabulary is read from both releases' declarations, the aliases a
 * parameter names and the literals written into its annotation, and a string
 * literal the consumer sends as that parameter, directly or through a name
 * bound to it, is a site wherever the old release lists it and the new one
 * does not. Only a keyword the checker resolves to the SDK's own parameter
 * counts. Where a Change maps the value to another (`enumMap`), the literal
 * is rewritten; otherwise it is shown, since which value to send instead is
 * the consumer's choice.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { RetiredValue } from "@invariant-app/migrate-core";
import { type EngineResult, manualAt, type Sources } from "./engine.ts";
import { type Declaration, isSpan, type ReferenceProvider } from "./references.ts";
import {
  descendantsOfType,
  type Node,
  nodeAt,
  parsePython,
  stringValue,
  type Tree,
  withStringValue,
} from "./syntax.ts";

const UPGRADE = "sdk-upgrade";
/** How many names a value is followed through to the literal it was bound to. */
const MOST_HOPS = 4;
/** The most files of one release read for its aliases. */
const MOST_FILES = 20_000;

/** `Name: TypeAlias = Literal[` or `Name = Literal[`, at the start of a line. */
const ALIAS =
  /^([A-Za-z_]\w*)\s*(?::\s*(?:typing(?:_extensions)?\.)?TypeAlias\s*)?=\s*(?:typing(?:_extensions)?\.)?Literal\[/gm;
const QUOTED = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g;

/** The string literals written in a stretch of Python. */
function quoted(text: string): string[] {
  return [...text.matchAll(QUOTED)].map((match) => (match[1] ?? match[2]) as string);
}

/** From `[` at `open`, the text up to its matching `]`. */
function bracketed(text: string, open: number): string {
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    const char = text[at];
    if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(open, at + 1);
    }
  }
  return text.slice(open);
}

/**
 * The vocabularies one release declares: its literal aliases, by name, each
 * with every value any declaration of that name lists, and every value any
 * `Literal[...]` in it lists. `site` holds the SDK alone.
 */
export function vocabularies(site: string): {
  aliases: Map<string, Set<string>>;
  listed: Set<string>;
} {
  const aliases = new Map<string, Set<string>>();
  const listed = new Set<string>();
  let read = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || read > MOST_FILES) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const path = join(dir, name);
      let isDirectory: boolean;
      try {
        isDirectory = statSync(path).isDirectory();
      } catch {
        continue;
      }
      if (isDirectory) {
        if (name !== "__pycache__" && !name.endsWith(".dist-info")) walk(path, depth + 1);
        continue;
      }
      if (!/\.pyi?$/.test(name)) continue;
      read += 1;
      const text = readFileSync(path, "utf8");
      if (!text.includes("Literal[")) continue;
      for (const match of text.matchAll(/\bLiteral\[/g)) {
        const open = (match.index ?? 0) + match[0].length - 1;
        for (const value of quoted(bracketed(text, open))) listed.add(value);
      }
      for (const match of text.matchAll(ALIAS)) {
        const open = (match.index ?? 0) + match[0].length - 1;
        const values = aliases.get(match[1] as string) ?? new Set<string>();
        for (const value of quoted(bracketed(text, open))) values.add(value);
        aliases.set(match[1] as string, values);
      }
    }
  };
  walk(site, 0);
  return { aliases, listed };
}

/** What a parameter's annotation lets through: the literals written in it, and the aliases it names. */
function vocabulary(annotation: string, aliases: Map<string, Set<string>>): Set<string> {
  const values = new Set<string>();
  for (const value of quoted(annotation)) values.add(value);
  for (const name of annotation.match(/[A-Za-z_]\w*/g) ?? []) {
    for (const value of aliases.get(name) ?? []) values.add(value);
  }
  return values;
}

/**
 * The parameter declared at a place in an SDK file: its annotation, and the
 * names of the classes and functions it is inside, which find the same
 * parameter in the other release.
 */
function parameterAt(
  tree: Tree,
  text: string,
  line: number,
  character: number,
): { annotation: string; path: string[]; name: string } | undefined {
  const lines = text.split("\n");
  let offset = 0;
  for (let at = 0; at < line; at += 1) offset += (lines[at]?.length ?? 0) + 1;
  offset += character;
  const node = nodeAt(tree, offset, offset + 1);
  if (node?.type !== "identifier") return undefined;
  const holder = node.parent;
  // `model: Union[str, ChatModel]` as a parameter, or as a TypedDict's key.
  const annotation =
    holder && ["typed_parameter", "typed_default_parameter"].includes(holder.type)
      ? holder.childForFieldName("type")
      : holder?.type === "assignment" && holder.childForFieldName("left")?.id === node.id
        ? holder.childForFieldName("type")
        : null;
  if (!annotation) return undefined;
  const path: string[] = [];
  for (let up = holder?.parent; up; up = up.parent) {
    if (up.type === "function_definition" || up.type === "class_definition") {
      path.unshift(up.childForFieldName("name")?.text ?? "");
    }
  }
  return { annotation: annotation.text, path, name: node.text };
}

/** The same parameter's annotation in another copy of the file. */
function sameParameter(
  tree: Tree,
  path: readonly string[],
  name: string,
): string | undefined {
  let scopes: Node[] = [tree.rootNode];
  for (const step of path) {
    scopes = scopes.flatMap((scope) =>
      descendantsOfType(scope, ["function_definition", "class_definition"]).filter(
        (each) => each.childForFieldName("name")?.text === step,
      ),
    );
  }
  for (const scope of scopes) {
    for (const node of descendantsOfType(scope, [
      "typed_parameter",
      "typed_default_parameter",
      "assignment",
    ])) {
      const named =
        node.type === "assignment"
          ? node.childForFieldName("left")
          : node.type === "typed_parameter"
            ? node.namedChildren.find((child) => child?.type === "identifier")
            : node.childForFieldName("name");
      if (named?.text !== name) continue;
      const annotation = node.childForFieldName("type");
      if (annotation) return annotation.text;
    }
  }
  return undefined;
}

export interface Releases {
  /** The directory each release of the SDK alone is unpacked into. */
  old: string;
  next: string;
}

/**
 * Every string literal the consumer sends as an SDK parameter whose
 * vocabulary lost it across the upgrade: rewritten where a Change maps it,
 * shown otherwise.
 */
export async function retiredLiterals(
  references: ReferenceProvider,
  sources: Sources,
  releases: Releases,
  retired: readonly RetiredValue[],
  result: EngineResult,
): Promise<void> {
  const before = vocabularies(releases.old);
  const after = vocabularies(releases.next);
  const oldAliases = before.aliases;
  const nextAliases = after.aliases;
  // Every value some vocabulary lost: one an alias no longer lists, or one no
  // literal type lists any more. A literal that is none of them is not asked
  // about, which keeps the checker's questions to a handful.
  const lost = new Set([...before.listed].filter((value) => !after.listed.has(value)));
  for (const [name, values] of oldAliases) {
    const now = nextAliases.get(name);
    if (!now) continue;
    for (const value of values) if (!now.has(value)) lost.add(value);
  }
  const parsed = new Map<string, { tree: Tree; text: string } | undefined>();
  const sdkFile = async (file: string) => {
    if (!parsed.has(file)) {
      try {
        const text = readFileSync(file, "utf8");
        parsed.set(file, { tree: await parsePython(text), text });
      } catch {
        parsed.set(file, undefined);
      }
    }
    return parsed.get(file);
  };
  /** What a parameter lost, by where it is declared; one question per parameter. */
  const losses = new Map<string, Set<string> | undefined>();
  const lostAt = async (declaration: Declaration): Promise<Set<string> | undefined> => {
    const key = `${declaration.file}:${declaration.line}:${declaration.character}`;
    if (losses.has(key)) return losses.get(key);
    losses.set(key, undefined);
    const inside = relative(releases.old, declaration.file);
    if (inside.startsWith("..")) return undefined;
    const oldFile = await sdkFile(declaration.file);
    const newFile = await sdkFile(join(releases.next, inside));
    if (!oldFile || !newFile) return undefined;
    const parameter = parameterAt(
      oldFile.tree,
      oldFile.text,
      declaration.line,
      declaration.character,
    );
    if (!parameter) return undefined;
    const now = sameParameter(newFile.tree, parameter.path, parameter.name);
    if (now === undefined) return undefined;
    const was = vocabulary(parameter.annotation, oldAliases);
    const is = vocabulary(now, nextAliases);
    // A parameter whose vocabulary went altogether is a break of another
    // kind, which the checker reports.
    if (is.size === 0) return undefined;
    const gone = new Set([...was].filter((value) => !is.has(value)));
    losses.set(key, gone);
    return gone;
  };

  for (const [file, text] of sources.texts) {
    if (![...lost].some((value) => text.includes(value))) continue;
    const tree = await sources.tree(file);
    if (!tree) continue;
    for (const argument of descendantsOfType(tree.rootNode, ["keyword_argument"])) {
      const name = argument.childForFieldName("name");
      const value = argument.childForFieldName("value");
      if (!name || !value) continue;
      const literals = await literalsOf(references, sources, file, value, 0);
      const candidates = literals.filter((literal) => lost.has(literal.value));
      if (candidates.length === 0) continue;
      // Only the SDK's own parameter: a function of the consumer's may take
      // the same name.
      const declarations = (await references.definitionAt(file, name.startIndex)).filter(
        (point): point is Declaration => !isSpan(point),
      );
      if (declarations.length === 0) continue;
      // An overloaded method declares the parameter once per signature; a
      // value counts as gone only where every one of them lost it.
      const each = await Promise.all(declarations.map(lostAt));
      for (const literal of candidates) {
        if (!each.every((gone) => gone?.has(literal.value))) continue;
        const mapped = retired.find(
          (entry) =>
            entry.field === name.text && entry.value === literal.value && entry.to,
        );
        const where = sources.texts.get(literal.file) ?? "";
        if (mapped?.to !== undefined) {
          result.edits.push({
            file: literal.file,
            start: literal.node.startIndex,
            end: literal.node.endIndex,
            replacement: withStringValue(literal.node, mapped.to),
            changeId: mapped.changeId,
            author: "codemod",
            reason: "updated a value to the vocabulary the contract now uses",
          });
          continue;
        }
        const named = retired.find(
          (entry) => entry.field === name.text && entry.value === literal.value,
        );
        result.manual.push(
          manualAt(
            literal.file,
            where,
            literal.node.startIndex,
            literal.node.endIndex,
            named?.changeId ?? UPGRADE,
            `\`${literal.value}\` is sent as \`${name.text}\` (line ${argument.startPosition.row + 1}${literal.file === file ? "" : ` of ${file.split("/").at(-1)}`}), and the upgraded SDK no longer lists it among the values \`${name.text}\` takes: the API retired it. Choose one it takes now`,
          ),
        );
      }
    }
  }
  for (const entry of parsed.values()) entry?.tree.delete();
}

/** A string literal a value comes down to, where it is written. */
interface Literal {
  file: string;
  node: Node;
  value: string;
}

/**
 * The string literals a value is: itself, the items of a list, tuple or set
 * written in place, or what a name was bound to, followed through the
 * checker's definitions.
 */
async function literalsOf(
  references: ReferenceProvider,
  sources: Sources,
  file: string,
  value: Node,
  hops: number,
): Promise<Literal[]> {
  const text = stringValue(value);
  if (text !== undefined) return [{ file, node: value, value: text }];
  if (["list", "tuple", "set"].includes(value.type)) {
    return value.namedChildren.flatMap((item) => {
      const each = item ? stringValue(item) : undefined;
      return item && each !== undefined ? [{ file, node: item, value: each }] : [];
    });
  }
  if (value.type !== "identifier" || hops >= MOST_HOPS) return [];
  const points = await references.definitionAt(file, value.startIndex);
  const spans = points.filter(isSpan);
  // A name bound in more than one place may hold either; it is left alone.
  if (spans.length !== 1 || points.length !== 1) return [];
  const span = spans[0] as (typeof spans)[number];
  const tree = await sources.tree(span.file);
  const target = tree && nodeAt(tree, span.start, span.end);
  const assignment = target?.parent;
  if (
    assignment?.type !== "assignment" ||
    assignment.childForFieldName("left")?.id !== target?.id
  ) {
    return [];
  }
  const assigned = assignment.childForFieldName("right");
  return assigned ? literalsOf(references, sources, span.file, assigned, hops + 1) : [];
}
