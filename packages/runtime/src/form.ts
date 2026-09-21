/**
 * Form-encoded bodies, as a tree and back.
 *
 * Stripe, Twilio, Slack and every OAuth token endpoint take
 * `application/x-www-form-urlencoded` requests. A program describes fields,
 * not encodings, so the same instructions run whether a body arrived as JSON
 * or as a form: the form is decoded into a tree, the instructions run, and the
 * tree is written back.
 *
 * Only the top-level fields a program names are decoded and rewritten, in the
 * style each is declared with: bracketed keys for a `deepObject`, as Stripe
 * writes `metadata[order_id]=6735` and `items[0][price]=p_1`, and plain keys
 * otherwise, repeated for a list as Twilio writes them. Every other pair keeps
 * its exact bytes and its place.
 */

import { BodyTooDeepError } from "./errors.ts";
import { type CompiledInstr, TransformError, touchedPaths } from "./interpreter.ts";
import { type Json, type NumberFidelity, numberTextOf, parseJson } from "./json.ts";
import { isUnsafeKey } from "./pointer.ts";

export interface FormField {
  style: "form" | "deepObject";
  explode: boolean;
}

export interface DecodedForm {
  /** How each top-level field is written; one not listed is written as a plain form field. */
  fields: Map<string, FormField>;
  /**
   * What each place an instruction reads holds, by pointer with `*` for list
   * items, so a value written as text reaches the instruction typed.
   */
  types: Map<string, FormType>;
}

export type FormType = "string" | "integer" | "number" | "boolean" | "array" | "object";

interface Pair {
  raw: string;
  key: string;
  value: string;
}

const PLAIN: FormField = { style: "form", explode: true };
const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

function decodeComponent(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
}

function pairsOf(text: string): Pair[] {
  if (text === "") return [];
  return text.split("&").flatMap((raw) => {
    if (raw === "") return [];
    const equals = raw.indexOf("=");
    return [
      equals === -1
        ? { raw, key: decodeComponent(raw), value: "" }
        : {
            raw,
            key: decodeComponent(raw.slice(0, equals)),
            value: decodeComponent(raw.slice(equals + 1)),
          },
    ];
  });
}

/** How deeply a form key may nest, far beyond Stripe's deepest. */
const MAX_FORM_DEPTH = 32;

/** `a[b][0]` as its root and the segments under it; `a[]` ends in an append. */
function keyPath(key: string): { root: string; segments: string[] } | undefined {
  const open = key.indexOf("[");
  if (open === -1) return { root: key, segments: [] };
  const root = key.slice(0, open);
  const segments: string[] = [];
  let rest = key.slice(open);
  while (rest.length > 0) {
    const match = /^\[([^[\]]*)\]/.exec(rest);
    if (!match) return undefined;
    segments.push(match[1] as string);
    if (segments.length > MAX_FORM_DEPTH) throw new BodyTooDeepError(MAX_FORM_DEPTH);
    rest = rest.slice(match[0].length);
  }
  return { root, segments };
}

/** The root a pair belongs to, so a named field can take all of its pairs. */
function rootOf(key: string): string {
  const open = key.indexOf("[");
  return open === -1 ? key : key.slice(0, open);
}

type Node = Record<string, unknown>;

/** Objects whose keys run 0, 1, 2 ... are the lists they were written from. */
function listsFromIndexes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(listsFromIndexes);
  if (typeof value !== "object" || value === null) return value;
  const node = value as Node;
  const keys = Object.keys(node);
  for (const key of keys) node[key] = listsFromIndexes(node[key]);
  if (keys.length > 0 && keys.every((key, index) => key === String(index))) {
    return keys.map((key) => node[key]);
  }
  return node;
}

function bracketed(pairs: readonly Pair[], root: string): unknown {
  let tree: Node | undefined;
  for (const pair of pairs) {
    const path = keyPath(pair.key);
    if (!path || path.root !== root) continue;
    if (path.segments.length === 0) return pair.value;
    tree ??= {};
    let node: Node = tree;
    for (const [index, segment] of path.segments.entries()) {
      const last = index === path.segments.length - 1;
      // `a[]=x` appends, which is a list written without indexes.
      const key = segment === "" ? String(Object.keys(node).length) : segment;
      if (isUnsafeKey(key)) break;
      if (last) {
        node[key] = pair.value;
      } else {
        const next = node[key];
        if (typeof next !== "object" || next === null) node[key] = {};
        node = node[key] as Node;
      }
    }
  }
  return tree === undefined ? undefined : listsFromIndexes(tree);
}

function typeAt(
  value: unknown,
  type: FormType | undefined,
  fidelity: NumberFidelity,
): unknown {
  if (typeof value !== "string" || type === undefined) return value;
  if ((type === "integer" || type === "number") && JSON_NUMBER.test(value)) {
    return parseJson(value, fidelity);
  }
  if (type === "boolean" && (value === "true" || value === "false"))
    return value === "true";
  return value;
}

/** Types every leaf the program reads, walking `*` over list items. */
function applyTypes(
  tree: Record<string, Json>,
  types: ReadonlyMap<string, FormType>,
  fidelity: NumberFidelity,
): void {
  for (const [pointer, type] of types) {
    if (type === "array" || type === "object") continue;
    const segments = pointer
      .split("/")
      .slice(1)
      .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
    const visit = (holder: Node | unknown[], at: number): void => {
      const segment = segments[at] as string;
      const keys =
        segment === "*"
          ? Array.isArray(holder)
            ? holder.map((_, index) => String(index))
            : []
          : [segment];
      for (const key of keys) {
        const container = holder as Record<string, unknown>;
        if (!Object.hasOwn(container, key)) continue;
        if (at === segments.length - 1) {
          container[key] = typeAt(container[key], type, fidelity);
        } else {
          const next = container[key];
          if (typeof next === "object" && next !== null) visit(next as Node, at + 1);
        }
      }
    };
    if (segments.length > 0) visit(tree as Node, 0);
  }
}

/**
 * The fields a program names, decoded from the form into a tree. Only
 * `roots` are read; a field of the form no instruction names never is.
 */
export function openForm(
  form: DecodedForm,
  roots: ReadonlySet<string>,
  text: string,
  fidelity: NumberFidelity,
): Record<string, Json> {
  const pairs = pairsOf(text);
  const tree: Record<string, Json> = {};
  for (const root of roots) {
    if (isUnsafeKey(root)) continue;
    const field = form.fields.get(root) ?? PLAIN;
    const declared = form.types.get(`/${root}`);
    const mine = pairs.filter((pair) => rootOf(pair.key) === root);
    if (mine.length === 0) continue;
    if (field.style === "deepObject" || mine.some((pair) => pair.key !== root)) {
      const value = bracketed(mine, root);
      if (value !== undefined) tree[root] = value as Json;
      continue;
    }
    const values = mine.map((pair) => pair.value);
    if (declared === "array") {
      tree[root] = field.explode ? values : (values[0] ?? "").split(",");
    } else if (declared === "object" && !field.explode) {
      const flat = (values[0] ?? "").split(",");
      const object: Node = {};
      for (let index = 0; index + 1 < flat.length; index += 2) {
        const key = flat[index] as string;
        if (!isUnsafeKey(key)) object[key] = flat[index + 1];
      }
      tree[root] = object as Json;
    } else {
      tree[root] = values.length === 1 ? (values[0] as string) : values;
    }
  }
  applyTypes(tree, form.types, fidelity);
  return tree;
}

function text(value: Json, changeId: string, where: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  // Stripe reads an empty value as "unset", the closest a form comes to null.
  if (value === null) return "";
  try {
    return numberTextOf(value);
  } catch {
    throw new TransformError(changeId, `${where} holds a value a form cannot write`);
  }
}

const isNode = (value: unknown): value is Node =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !JSON.isRawJSON(value);

function encodeKey(root: string, segments: readonly string[]): string {
  return `${encodeURIComponent(root)}${segments.map((segment) => `[${encodeURIComponent(segment)}]`).join("")}`;
}

/** One field of the tree as the pairs a form carries it in. */
function encodeField(
  root: string,
  value: Json,
  field: FormField,
  changeId: string,
): string[] {
  const out: string[] = [];
  const nested = (segments: string[], node: unknown): void => {
    if (Array.isArray(node)) {
      for (const [index, item] of node.entries())
        nested([...segments, String(index)], item);
      return;
    }
    if (isNode(node)) {
      for (const [key, child] of Object.entries(node)) nested([...segments, key], child);
      return;
    }
    out.push(
      `${encodeKey(root, segments)}=${encodeURIComponent(text(node as Json, changeId, root))}`,
    );
  };

  if (
    field.style === "deepObject" ||
    isNode(value) ||
    (Array.isArray(value) && value.some((item) => isNode(item) || Array.isArray(item)))
  ) {
    if (field.style !== "deepObject" && isNode(value) && !field.explode) {
      const flat = Object.entries(value).flatMap(([key, child]) => [
        key,
        text(child as Json, changeId, root),
      ]);
      out.push(`${encodeURIComponent(root)}=${flat.map(encodeURIComponent).join(",")}`);
      return out;
    }
    nested([], value);
    return out;
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => text(item as Json, changeId, root));
    if (field.explode) {
      for (const item of items)
        out.push(`${encodeURIComponent(root)}=${encodeURIComponent(item)}`);
    } else {
      out.push(`${encodeURIComponent(root)}=${items.map(encodeURIComponent).join(",")}`);
    }
    return out;
  }
  out.push(
    `${encodeURIComponent(root)}=${encodeURIComponent(text(value, changeId, root))}`,
  );
  return out;
}

/** The change that last wrote under a root, for naming a refusal. */
function writerOf(instrs: readonly CompiledInstr[], root: string, depth: number): string {
  for (let index = instrs.length - 1; index >= 0; index -= 1) {
    const instr = instrs[index] as CompiledInstr;
    if (touchedPaths(instr).some((path) => path[depth] === root)) return instr.c;
  }
  return instrs[0]?.c ?? "";
}

/**
 * Writes the named fields back. A field the program took away is gone; one it
 * moved in is written in the style its declaration gives it.
 */
export function closeForm(
  form: DecodedForm,
  roots: ReadonlySet<string>,
  original: string,
  tree: Record<string, Json>,
  instrs: readonly CompiledInstr[],
  depth: number,
): string {
  const kept = pairsOf(original)
    .filter((pair) => !roots.has(rootOf(pair.key)))
    .map((pair) => pair.raw);
  const written: string[] = [];
  for (const [root, value] of Object.entries(tree)) {
    if (value === undefined || !roots.has(root)) continue;
    written.push(
      ...encodeField(
        root,
        value,
        form.fields.get(root) ?? PLAIN,
        writerOf(instrs, root, depth),
      ),
    );
  }
  return [...kept, ...written].join("&");
}

/** The top-level fields a list of instructions names, under `depth` leading segments. */
export function formRoots(instrs: readonly CompiledInstr[], depth: number): Set<string> {
  const roots = new Set<string>();
  for (const instr of instrs) {
    for (const path of touchedPaths(instr)) {
      if (depth === 1 && path[0] !== "@body") continue;
      const root = path[depth];
      if (root !== undefined && root !== "*") roots.add(root);
    }
  }
  return roots;
}

export function isFormMediaType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const media = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return media === "application/x-www-form-urlencoded";
}
