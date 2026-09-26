/**
 * The Python migration engine.
 *
 * The same rules as the TypeScript engine, read through Python's tools: the
 * type checker finds every reference to a field an SDK declares, the syntax
 * tree says what each reference does, and an edit is written only where both
 * say exactly what to write. Everything else is shown to a person with the
 * reason, because a migration that quietly gets one site wrong is worse than
 * one that says which site it could not do.
 *
 * Python gives a type checker less to go on than TypeScript does. A value
 * read out of a webhook's JSON, a dictionary built by hand and a response
 * subscripted by string are all invisible to it, and are the ordinary way a
 * lot of Python calls an API. So the engine never edits a site it has no type
 * evidence for: a subscript by the field's name, a dictionary key, or a read
 * whose object the checker cannot type are reported, never rewritten.
 */
import type { DataOp } from "@invariant-app/ir";
import {
  type Edit,
  type ManualSite,
  type MigrationPlan,
  recoding,
  type TargetSymbol,
} from "@invariant-app/migrate-core";
import { exactLiteral, Helpers } from "./amounts.ts";
import { classIn, hoverType, type ValueFlow } from "./flows.ts";
import {
  classDeclaration,
  type Declaration,
  importedFor,
  isSpan,
  type ReferenceProvider,
  type Span,
  sameDeclaration,
} from "./references.ts";
import {
  descendantsOfType,
  type Node,
  nodeAt,
  type PyRole,
  parsePython,
  roleOf,
  statementAround,
  stringValue,
  type Tree,
  withStringValue,
} from "./syntax.ts";
import {
  dictionaryAt,
  keyToken,
  onlyUnpacked,
  unpackingsIn,
  writtenOut,
} from "./unpacked.ts";

export interface EngineResult {
  edits: Edit[];
  manual: ManualSite[];
}

/** The sources a migration reads, each parsed once. */
export class Sources {
  readonly texts: Map<string, string>;
  private readonly trees = new Map<string, Tree>();

  constructor(texts: Map<string, string>) {
    this.texts = texts;
  }

  async tree(file: string): Promise<Tree | undefined> {
    const text = this.texts.get(file);
    if (text === undefined) return undefined;
    let tree = this.trees.get(file);
    if (!tree) {
      tree = await parsePython(text);
      this.trees.set(file, tree);
    }
    return tree;
  }

  /** Frees the parsed trees, which live in WebAssembly memory the collector cannot see. */
  dispose(): void {
    for (const tree of this.trees.values()) tree.delete();
    this.trees.clear();
  }
}

/** The most lines a flagged statement may span before only the flagged part is shown. */
const MOST_LINES_SHOWN = 12;

/**
 * What a person is shown for a flagged span: the statement around it, since
 * the fix is to the statement (`record = SubscriptionRecord(...)` spanning
 * ten lines, around the one argument that reads a moved field), unless the
 * statement is so long that pointing at the span says more.
 */
export function shownExtent(
  tree: Tree,
  text: string,
  start: number,
  end: number,
): { start: number; end: number } {
  const statement = statementAround(tree, start, end);
  const lines = text.slice(statement.start, statement.end).split("\n").length;
  return lines <= MOST_LINES_SHOWN ? statement : { start, end };
}

/** A site shown to a person: `start` to `end` in `file` as it was read. */
export function manualAt(
  file: string,
  text: string,
  start: number,
  end: number,
  changeId: string,
  reason: string,
  /** Where the changed element is written, where the extent shown starts before it. */
  at?: number,
): ManualSite {
  const before = text.slice(0, start);
  const line = before.split("\n").length;
  const lineStart = before.lastIndexOf("\n") + 1;
  const lineEnd = text.indexOf("\n", start);
  return {
    file,
    line,
    column: start - lineStart + 1,
    changeId,
    reason,
    snippet: text
      .slice(lineStart, lineEnd === -1 ? text.length : lineEnd)
      .trim()
      .slice(0, 120),
    offset: start,
    end,
    ...(at !== undefined && at !== start ? { at } : {}),
  };
}

/**
 * What every op on one field does to it, in the order the provider declared
 * them: where the value now lives, a renamed vocabulary, or the reason no
 * edit can be written.
 */
export interface Composed {
  path: string[];
  changeIds: string[];
  reasons: string[];
  /** Old value to new, for a field whose values were renamed. */
  values: Map<string, string>;
  /**
   * For an amount now written times 10^exponent: the exponent, converted
   * at each site with the SDK's exact helpers.
   */
  scale: number | undefined;
  unsupported: string | undefined;
}

const segmentsOf = (pointer: string) =>
  pointer.split("/").filter((segment) => segment !== "");

export function compose(
  targets: readonly TargetSymbol[],
  /** Whether the SDK exports exact conversion helpers for an amount. */
  helpers = false,
): Composed {
  const first = targets[0] as TargetSymbol;
  const composed: Composed = {
    path: [first.property],
    changeIds: [],
    reasons: [],
    values: new Map(),
    scale: undefined,
    unsupported: undefined,
  };
  for (const target of targets) {
    const op: DataOp = target.op;
    if (!composed.changeIds.includes(target.changeId))
      composed.changeIds.push(target.changeId);
    switch (op.op) {
      case "move": {
        const to = segmentsOf(op.to);
        // A field that moves into a list's items has no one place to read it
        // from: which item is a decision, not a rewrite.
        if (to.includes("*")) {
          composed.unsupported = `\`${segmentsOf(op.from).join(".")}\` is now inside a list, at \`${to.join(".")}\`; which item to read is a decision`;
        } else {
          composed.path = to;
          composed.reasons.push(`renamed ${op.from} to ${op.to}`);
        }
        break;
      }
      case "convert":
        if (op.codec.kind === "enumMap") {
          for (const [from, to] of op.codec.pairs)
            composed.values.set(String(from), String(to));
          composed.reasons.push(
            "updated a value to the vocabulary the contract now uses",
          );
        } else if (op.codec.kind === "scale10" && helpers) {
          composed.scale = (composed.scale ?? 0) + op.codec.exponent;
          composed.reasons.push("converted the amount to the unit the contract now uses");
        } else {
          composed.unsupported = `\`${segmentsOf(op.path).join(".")}\` is now written as ${recoding(op.codec)}, which this engine does not rewrite`;
        }
        break;
      case "remove":
        composed.unsupported = `\`${segmentsOf(op.path).join(".")}\` is no longer in the contract, and nothing was declared in its place`;
        break;
      default:
        // Adding a field, a default, dropping null, widening and relaxing
        // leave every existing reference as it is.
        break;
    }
  }
  return composed;
}

/** One group of targets per field, so every op on it composes into one edit per site. */
function groupTargets(plan: MigrationPlan): TargetSymbol[][] {
  const groups = new Map<string, TargetSymbol[]>();
  for (const target of plan.targets) {
    if (["add", "default", "dropNull", "widen", "relax"].includes(target.op.op)) continue;
    const key = [target.typeName, ...(target.within ?? []), target.property].join(".");
    groups.set(key, [...(groups.get(key) ?? []), target]);
  }
  return [...groups.values()];
}

interface Site {
  file: string;
  text: string;
  node: Node;
  role: PyRole;
}

/**
 * The string literals a value is compared with: `sub.status == "active"`,
 * or `status in ("active", "past_due")`.
 */
function comparedLiterals(operand: Node): Node[] {
  const comparison = operand.parent;
  if (comparison?.type !== "comparison_operator") return [];
  const others = comparison.namedChildren.filter(
    (child): child is Node => child !== null && child.id !== operand.id,
  );
  return others.flatMap((other) =>
    other.type === "string"
      ? [other]
      : ["tuple", "list", "set"].includes(other.type)
        ? other.namedChildren.filter((item): item is Node => item?.type === "string")
        : [],
  );
}

/**
 * The string literals a `match` over the field compares it with: each case
 * whose pattern is a literal, or literals joined by `|`, bound by `as` or
 * not. A literal inside a class, mapping or sequence pattern is compared
 * with something else, and is left alone.
 */
function casedLiterals(subject: Node): Node[] {
  const match = subject.parent;
  if (
    match?.type !== "match_statement" ||
    match.childrenForFieldName("subject").length !== 1 ||
    match.childForFieldName("subject")?.id !== subject.id
  )
    return [];
  const found: Node[] = [];
  const walk = (pattern: Node | null | undefined): void => {
    if (!pattern) return;
    if (pattern.type === "string") found.push(pattern);
    else if (pattern.type === "case_pattern" || pattern.type === "union_pattern") {
      for (const child of pattern.namedChildren) walk(child);
    } else if (pattern.type === "as_pattern") walk(pattern.namedChildren[0]);
    // `("active" | "past_due")` groups one pattern; with a comma it is a tuple.
    else if (
      pattern.type === "tuple_pattern" &&
      pattern.namedChildren.length === 1 &&
      !pattern.children.some((child) => child?.type === ",")
    ) {
      walk(pattern.namedChildren[0]);
    }
  };
  for (const clause of match.childForFieldName("body")?.namedChildren ?? []) {
    if (clause?.type !== "case_clause") continue;
    const patterns = clause.namedChildren.filter(
      (child): child is Node => child?.type === "case_pattern",
    );
    // `case "active", x:` matches a sequence, not the one subject.
    if (patterns.length === 1) walk(patterns[0]);
  }
  return found;
}

/** The keyword argument or dictionary pair a keyword or key reference is the name of. */
function holderOf(site: Site): Node | undefined {
  if (site.role === "keyword") return site.node.parent ?? undefined;
  if (site.role !== "dict-key") return undefined;
  const literal = site.node.type === "string" ? site.node : site.node.parent;
  return literal?.parent?.type === "pair" ? literal.parent : undefined;
}

function renameValues(site: Site, composed: Composed, result: EngineResult): void {
  const literals =
    site.role === "attribute-read" && site.node.parent
      ? [...comparedLiterals(site.node.parent), ...casedLiterals(site.node.parent)]
      : site.role === "keyword" || site.role === "dict-key"
        ? [holderOf(site)?.childForFieldName("value")].filter(
            (value): value is Node => value?.type === "string",
          )
        : [];
  for (const literal of literals) renameValue(site.file, literal, composed, result);
}

function renameValue(
  file: string,
  literal: Node,
  composed: Composed,
  result: EngineResult,
): void {
  const value = stringValue(literal);
  const mapped = value === undefined ? undefined : composed.values.get(value);
  if (mapped === undefined) return;
  result.edits.push({
    file,
    start: literal.startIndex,
    end: literal.endIndex,
    replacement: withStringValue(literal, mapped),
    changeId: composed.changeIds[0] ?? "",
    author: "codemod",
    reason: "updated a value to the vocabulary the contract now uses",
  });
}

/**
 * What a run shares across fields: the checker, the SDK's conversion
 * helpers, and the nested objects writes are moving values into.
 */
interface RunContext {
  references: ReferenceProvider;
  /** The SDK's exact conversion helpers, where it exports them. */
  helpers: Helpers | undefined;
  nesting: Nesting;
}

/**
 * Writes that move a value into a nested object, `phone=mobile` becoming
 * `contact={"phone": mobile}`, held until every field is read: two fields
 * moving into the same object of one call would each write that object,
 * and the call would then pass it twice. Where that happens, each is shown
 * to a person instead, who writes the one object.
 */
class Nesting {
  private readonly claims = new Map<string, { edit: Edit; flag: () => void }[]>();

  claim(key: string, edit: Edit, flag: () => void): void {
    this.claims.set(key, [...(this.claims.get(key) ?? []), { edit, flag }]);
  }

  settle(result: EngineResult): void {
    for (const claims of this.claims.values()) {
      if (claims.length === 1) result.edits.push((claims[0] as { edit: Edit }).edit);
      else for (const claim of claims) claim.flag();
    }
    this.claims.clear();
  }
}

/** `{"phone": value}`: the rest of the path a value moved down, as dictionaries. */
function nestedDict(path: readonly string[], value: string, quote: string): string {
  const [head, ...rest] = path;
  return head === undefined
    ? value
    : `{${quote}${head}${quote}: ${nestedDict(rest, value, quote)}}`;
}

/** The name a keyword argument or a pair's plain string key gives. */
function nameOf(node: Node): string | undefined {
  if (node.type === "keyword_argument") return node.childForFieldName("name")?.text;
  if (node.type === "pair") return stringValue(node.childForFieldName("key"));
  return undefined;
}

/**
 * Whether the value a field is read from is declared as possibly None and
 * only read here because a check narrowed it, as in `customer.balance if
 * customer is not None else None`. Converting such a read means deciding
 * what the absent case becomes, and that is not the migration's to decide.
 */
async function mayBeNone(
  references: ReferenceProvider,
  file: string,
  receiver: Node,
): Promise<boolean> {
  const name =
    receiver.type === "attribute"
      ? receiver.childForFieldName("attribute")
      : receiver.type === "identifier"
        ? receiver
        : null;
  if (!name) return false;
  for (const point of await references.definitionAt(file, name.startIndex)) {
    if (!isSpan(point)) continue;
    const declared = hoverType(await references.typeAt(point.file, point.start));
    if (declared && /\bNone\b|\bOptional\[/.test(declared)) return true;
  }
  return false;
}

/**
 * Converts one typed reference to an amount whose unit changed. A read is
 * wrapped in the helper that gives back the unit the code means, and the
 * edit is written here; a value written into a request is converted into
 * the unit sent now, by the conversion returned, which the edit of the
 * whole keyword or key applies. Anything else is shown, and gives nothing.
 */
async function convertAmount(
  site: Site,
  composed: Composed,
  exponent: number,
  context: RunContext,
  result: EngineResult,
  flag: (reason: string) => void,
): Promise<{ read: true } | { write: (value: string) => string } | undefined> {
  const { helpers, references } = context;
  const scaled = `\`${composed.path.join(".")}\` is now written as the value times 10^${exponent}`;
  if (!helpers) {
    flag(`${scaled}, and the SDK exports no exact conversion helpers`);
    return undefined;
  }
  const named = async (helper: string) => {
    const name = await helpers.nameIn(site.file, helper);
    if (!name) {
      flag(
        `${scaled}; convert it with the SDK's \`${helper}\`, which this file cannot import under its own name`,
      );
    }
    return name;
  };
  if (site.role === "attribute-read") {
    const attribute = site.node.parent;
    const receiver = attribute?.childForFieldName("object");
    if (!attribute || !receiver) return undefined;
    if (await mayBeNone(references, site.file, receiver)) {
      flag(
        `${scaled}, and this reads it from a value that may be None; decide what the result should be when there is nothing there, then convert it with the SDK's \`${helpers.reading(exponent)}\``,
      );
      return undefined;
    }
    const helper = await named(helpers.reading(exponent));
    if (!helper) return undefined;
    result.edits.push({
      file: site.file,
      start: attribute.startIndex,
      end: attribute.endIndex,
      replacement: (inner) => `${helper}(${inner})`,
      changeId: composed.changeIds[0] ?? "",
      author: "codemod",
      reason: composed.reasons.join("; "),
    });
    return { read: true };
  }
  const value = holderOf(site)?.childForFieldName("value");
  if (!value) {
    flag(`${scaled}; convert this use of it by hand with the SDK's exact helpers`);
    return undefined;
  }
  const exact = await exactLiteral(references, site.file, value, exponent);
  if (exact !== undefined) return { write: () => exact };
  const helper = await named(helpers.writing(exponent));
  if (!helper) return undefined;
  const reading = helpers.reading(exponent);
  return {
    write: (written) => {
      // A value that is itself a read of an amount now in the same unit was
      // just wrapped to give back the old one; sent on as it is, it needs
      // neither conversion.
      const unwrapped =
        written !== value.text ? /^([\w.]+)\(([\s\S]*)\)$/.exec(written) : null;
      if (unwrapped && unwrapped[1]?.split(".").at(-1) === reading) {
        return unwrapped[2] as string;
      }
      return `${helper}(${written})`;
    },
  };
}

/** Rewrites one typed reference, or reports why it cannot. */
async function applyComposed(
  site: Site,
  composed: Composed,
  first: TargetSymbol,
  context: RunContext,
  result: EngineResult,
): Promise<void> {
  const changeId = composed.changeIds[0] ?? "";
  const flag = (reason: string, node: Node = site.node.parent ?? site.node) => {
    const extent = shownExtent(site.node.tree, site.text, node.startIndex, node.endIndex);
    result.manual.push(
      manualAt(
        site.file,
        site.text,
        extent.start,
        extent.end,
        changeId,
        reason,
        site.node.startIndex,
      ),
    );
  };

  if (composed.values.size > 0) renameValues(site, composed, result);
  if (composed.unsupported) {
    flag(composed.unsupported);
    return;
  }
  let convert: ((value: string) => string) | undefined;
  if (composed.scale !== undefined && composed.scale !== 0) {
    const converted = await convertAmount(
      site,
      composed,
      composed.scale,
      context,
      result,
      (reason) => flag(reason),
    );
    if (!converted) return;
    if ("write" in converted) convert = converted.write;
  }
  const renamed = composed.path.length !== 1 || composed.path[0] !== first.property;
  if (!renamed && !convert) return;
  const reason = composed.reasons.join("; ");
  const edit = (node: Node, replacement: string) =>
    result.edits.push({
      file: site.file,
      start: node.startIndex,
      end: node.endIndex,
      replacement,
      changeId,
      author: "codemod",
      reason,
    });

  switch (site.role) {
    case "attribute-read":
    case "attribute-write":
      // `sub.old` becomes `sub.new`, or `sub.parent.new` for a field that
      // moved into an object; the object expression is left as written.
      edit(site.node, composed.path.join("."));
      return;
    case "keyword":
    case "dict-key": {
      const literal =
        site.role === "keyword"
          ? undefined
          : site.node.type === "string"
            ? site.node
            : site.node.parent;
      if (site.role === "dict-key" && (!literal || stringValue(literal) === undefined)) {
        flag("this key is not a plain string to rename");
        return;
      }
      const head = composed.path[0] as string;
      if (composed.path.length === 1 && !convert) {
        if (literal) edit(literal, withStringValue(literal, head));
        else edit(site.node, head);
        return;
      }
      // Otherwise the whole keyword or pair is written again: its name, and
      // its value converted, or moved into an object that holds it where the
      // field now is. The edit is wider than the value, so a read inside the
      // value is rewritten first and handed to it.
      const holder = holderOf(site);
      const container = holder?.parent;
      const value = holder?.childForFieldName("value");
      const nested = `the value is now nested at ${composed.path.join(".")}`;
      if (!holder || !container || !value) {
        flag(
          composed.path.length > 1
            ? nested
            : `this ${site.role} needs rewriting by hand: ${reason}`,
        );
        return;
      }
      const quote = literal
        ? (literal.children[0]?.text.replace(/^[a-zA-Z]*/, "") ?? '"')
        : '"';
      const name = literal ? withStringValue(literal, head) : head;
      // The name is left to this edit alone, so everything before the value
      // is as it was read, and the value starts where it did.
      const prefix = value.startIndex - holder.startIndex;
      const separator = site.text.slice(
        (literal ?? site.node).endIndex,
        value.startIndex,
      );
      const replacement = (inner: string) => {
        const written = inner.slice(prefix);
        const sent = convert ? convert(written) : written;
        return `${name}${separator}${nestedDict(composed.path.slice(1), sent, quote)}`;
      };
      const rewrite: Edit = {
        file: site.file,
        start: holder.startIndex,
        end: holder.endIndex,
        replacement,
        changeId,
        author: "codemod",
        reason,
      };
      if (composed.path.length === 1) {
        result.edits.push(rewrite);
        return;
      }
      // Moved into an object: not where the call or dictionary already has
      // that object, or unpacks something that might.
      const taken = container.namedChildren.some(
        (child) =>
          child !== null &&
          child.id !== holder.id &&
          (child.type === "dictionary_splat" ||
            child.type === "list_splat" ||
            nameOf(child) === head),
      );
      if (taken) {
        flag(
          `${nested}, and \`${head}\` is already written here or may be unpacked into it`,
        );
        return;
      }
      context.nesting.claim(`${site.file}:${container.startIndex}:${head}`, rewrite, () =>
        flag(
          `${nested}, and more than one field moves into \`${head}\` here; write the one object by hand`,
        ),
      );
      return;
    }
    default:
      flag(
        `this ${site.role === "subscript" ? "subscript" : "use"} of the field needs rewriting by hand: ${reason}`,
      );
  }
}

/**
 * Values compared with a name the consumer declared as the SDK's own type
 * for the field's values: `def is_live(status: acme.CustomerStatus)` and
 * `status == "active"` inside it. The field is annotated with that type, so
 * a value of it is one of the field's values wherever the consumer carries
 * it; the annotation is resolved by the checker to the SDK's declaration of
 * the type, never matched by its name.
 */
async function vocabularyComparisons(
  references: ReferenceProvider,
  sources: Sources,
  target: TargetSymbol,
  composed: Composed,
  result: EngineResult,
): Promise<void> {
  const members = references as ReferenceProvider & {
    memberType?(typeName: string, path: readonly string[]): Promise<string | undefined>;
  };
  if (!members.memberType) return;
  const shown = hoverType(
    await members.memberType(target.typeName, [
      ...(target.within ?? []),
      target.property,
    ]),
  );
  if (!shown || !/^[A-Za-z_]\w*$/.test(shown)) return;
  const vocabulary = await references.moduleAttribute(
    importedFor(target.typeName),
    shown,
  );
  if (!vocabulary) return;
  const olds = [...composed.values.keys()];
  for (const [file, text] of sources.texts) {
    if (!olds.some((value) => text.includes(value))) continue;
    const tree = await sources.tree(file);
    if (!tree) continue;
    const operands = [
      ...descendantsOfType(tree.rootNode, ["comparison_operator"]).flatMap((comparison) =>
        comparison.namedChildren.filter(
          (child): child is Node => child?.type === "identifier",
        ),
      ),
      ...descendantsOfType(tree.rootNode, ["match_statement"]).flatMap((match) =>
        match
          .childrenForFieldName("subject")
          .filter((subject): subject is Node => subject?.type === "identifier"),
      ),
    ];
    for (const operand of operands) {
      const literals = [...comparedLiterals(operand), ...casedLiterals(operand)];
      if (
        !literals.some((literal) => composed.values.has(stringValue(literal) ?? "")) ||
        !(await declaredAs(references, sources, file, operand, vocabulary))
      )
        continue;
      for (const literal of literals) renameValue(file, literal, composed, result);
    }
  }
}

/**
 * Whether the name at `operand` is declared with an annotation the checker
 * resolves to `type`: a parameter `status: acme.CustomerStatus`, or a
 * variable annotated so.
 */
async function declaredAs(
  references: ReferenceProvider,
  sources: Sources,
  file: string,
  operand: Node,
  type: Declaration,
): Promise<boolean> {
  const annotated = ["typed_parameter", "typed_default_parameter", "assignment"];
  for (const point of await references.definitionAt(file, operand.startIndex)) {
    if (!isSpan(point)) continue;
    const tree = await sources.tree(point.file);
    const declared = tree && nodeAt(tree, point.start, point.end);
    const holder = declared
      ? annotated.includes(declared.type)
        ? declared
        : declared.parent && annotated.includes(declared.parent.type)
          ? declared.parent
          : undefined
      : undefined;
    const annotation = holder?.childForFieldName("type");
    const written =
      annotation?.type === "type" ? annotation.namedChildren[0] : annotation;
    // The annotation's last name: `CustomerStatus` of `acme.CustomerStatus`.
    const last =
      written?.type === "attribute"
        ? written.childForFieldName("attribute")
        : written?.type === "identifier"
          ? written
          : null;
    if (!last) continue;
    const resolved = await references.definitionAt(point.file, last.startIndex);
    if (resolved.some((each) => !isSpan(each) && sameDeclaration(each, type)))
      return true;
  }
  return false;
}

/**
 * Keywords of class patterns that match the field's own class: `case
 * acme.Address(postal_code=zip_code)`. A keyword there is an attribute of
 * the matched object, but the checker reports no reference to the field at
 * it, so the class the pattern names is resolved instead: where it is the
 * class that declares the field, the keyword is the field.
 */
async function patternKeywords(
  references: ReferenceProvider,
  sources: Sources,
  target: TargetSymbol,
  composed: Composed,
  result: EngineResult,
): Promise<void> {
  // A field inside an object the type holds is matched through that object's
  // own class, which the plan does not name.
  if ((target.within ?? []).length > 0) return;
  const changeId = composed.changeIds[0] ?? "";
  let holder: Promise<Declaration | undefined> | undefined;
  for (const [file, text] of sources.texts) {
    if (!text.includes("case") || !text.includes(target.property)) continue;
    const tree = await sources.tree(file);
    if (!tree) continue;
    for (const keyword of descendantsOfType(tree.rootNode, ["keyword_pattern"])) {
      const [name, value] = keyword.namedChildren;
      if (name?.type !== "identifier" || name.text !== target.property) continue;
      const pattern =
        keyword.parent?.type === "case_pattern" ? keyword.parent.parent : keyword.parent;
      if (pattern?.type !== "class_pattern") continue;
      const className = pattern.namedChildren.find(
        (child) => child?.type === "dotted_name",
      );
      const last = className?.namedChildren.at(-1);
      if (!last) continue;
      holder ??= classDeclaration(references, target.typeName);
      const declared = await holder;
      if (!declared) return;
      const points = await references.definitionAt(file, last.startIndex);
      if (!points.some((point) => !isSpan(point) && sameDeclaration(point, declared)))
        continue;
      if (value?.type === "string") renameValue(file, value, composed, result);
      const flag = (reason: string) => {
        const extent = shownExtent(tree, text, keyword.startIndex, keyword.endIndex);
        result.manual.push(
          manualAt(
            file,
            text,
            extent.start,
            extent.end,
            changeId,
            reason,
            name.startIndex,
          ),
        );
      };
      if (composed.unsupported) {
        flag(composed.unsupported);
        continue;
      }
      if (composed.scale !== undefined && composed.scale !== 0) {
        flag(
          `\`${target.property}\` is now written as the value times 10^${composed.scale}, and this pattern binds it as it arrives; convert it where it is used`,
        );
        continue;
      }
      const renamed = composed.path.length !== 1 || composed.path[0] !== target.property;
      if (!renamed) continue;
      if (composed.path.length > 1) {
        flag(`the value is now nested at ${composed.path.join(".")}`);
        continue;
      }
      result.edits.push({
        file,
        start: name.startIndex,
        end: name.endIndex,
        replacement: composed.path[0] as string,
        changeId,
        author: "codemod",
        reason: composed.reasons.join("; "),
      });
    }
  }
}

/**
 * Runs every target in the plan: finds the field's declaration in the SDK,
 * every typed reference to it, and edits or reports each.
 */
export async function runTargets(
  references: ReferenceProvider,
  sources: Sources,
  plan: MigrationPlan,
  result: EngineResult,
  options: {
    /** Follows values the checker cannot type back to where they came from. */
    flow?: ValueFlow;
    /**
     * The old release ships no types of its own. Nearly every value read
     * from it is one the checker cannot type, so a read by name from such a
     * value says nothing there: only a value proven to be the field's class
     * is read by name.
     */
    untyped?: boolean;
  } = {},
): Promise<{ resolved: number; unresolved: number }> {
  let resolved = 0;
  let unresolved = 0;
  /** Read once, the first time a field that moved or went needs them. */
  let expansions: Expansion[] | undefined;
  // A field is referenced only where its name is written, as an attribute or
  // a key, so one no file spells needs no probe of the checker: on an SDK with
  // hundreds of Changes those probes were nearly all of a run.
  const words = new Set(
    [...sources.texts.values()].flatMap((text) => text.match(/\w+/g) ?? []),
  );
  const module = plan.targets[0]?.typeName.split(".")[0];
  const helpers =
    plan.symbols.helpers && module
      ? new Helpers(references, sources, plan.symbols.helpers, module)
      : undefined;
  const context: RunContext = {
    references,
    helpers: undefined,
    nesting: new Nesting(),
  };
  for (const targets of groupTargets(plan)) {
    const first = targets[0] as TargetSymbol;
    if (!words.has(first.property)) continue;
    // The helpers are asked about only once an amount needs them.
    const rescaled = targets.some(
      (target) => target.op.op === "convert" && target.op.codec.kind === "scale10",
    );
    if (rescaled && helpers && (await helpers.available())) context.helpers = helpers;
    const composed = compose(targets, context.helpers !== undefined);
    const declaration = await references.declarationOf(first.typeName, [
      ...(first.within ?? []),
      first.property,
    ]);
    if (!declaration) {
      unresolved += 1;
      // A field the old release does not declare, as none is in one that
      // ships no types, is still read by name, but only from a value the
      // checker or value flow proves to be its class: with nothing declared
      // to compare with, a value it cannot type says nothing.
      if ((first.within ?? []).length === 0 && changesReads(composed, first)) {
        await flagByName(
          references,
          sources,
          first,
          undefined,
          composed,
          new Set(),
          result,
          {
            ...options,
            proven: true,
          },
        );
      }
      continue;
    }
    resolved += 1;
    const typed = new Set<string>();
    for (const span of await references.referencesTo(declaration)) {
      const site = await siteAt(sources, span);
      if (!site) continue;
      typed.add(`${span.file}:${span.start}`);
      await applyComposed(site, composed, first, context, result);
    }
    if (changesReads(composed, first) || composed.values.size > 0) {
      await patternKeywords(references, sources, first, composed, result);
    }
    if (composed.values.size > 0) {
      await vocabularyComparisons(references, sources, first, composed, result);
    }
    // Keys of a dictionary unpacked into the SDK's call.
    if (
      !composed.unsupported &&
      composed.scale === undefined &&
      composed.path.length === 1 &&
      composed.path[0] !== first.property
    ) {
      await unpackedKeys(references, sources, first, declaration, composed, result);
    }
    // What the checker could not type is found by name, and only reported.
    if (changesReads(composed, first)) {
      await flagByName(references, sources, first, declaration, composed, typed, result, {
        ...options,
        proven: options.untyped === true,
      });
    }
    if (composed.unsupported || composed.path.join(".") !== first.property) {
      expansions ??= await expansionsIn(references, sources, first.typeName);
      for (const expansion of expansions) {
        for (const [at, reached] of expansion.reaches.entries()) {
          if (!reached || !sameDeclaration(reached, declaration)) continue;
          const extent = shownExtent(
            expansion.node.tree,
            expansion.text,
            expansion.node.startIndex,
            expansion.node.endIndex,
          );
          result.manual.push(
            manualAt(
              expansion.file,
              expansion.text,
              extent.start,
              extent.end,
              composed.changeIds[0] ?? "",
              `this expands \`${expansion.path.slice(0, at + 1).join(".")}\`; ${composed.unsupported ?? composed.reasons.join("; ")}`,
              expansion.node.startIndex,
            ),
          );
          break;
        }
      }
    }
  }
  context.nesting.settle(result);
  if (helpers) {
    const rescaled = plan.targets.find(
      (target) => target.op.op === "convert" && target.op.codec.kind === "scale10",
    );
    result.edits.push(...helpers.importEdits(rescaled?.changeId ?? ""));
  }
  return { resolved, unresolved };
}

/**
 * Keys of a dictionary built from literals and unpacked into a call, `params
 * = {"nickname": name}` and `create(**params)`, renamed where the checker
 * says the key is the field. The checker types the dictionary as a
 * `dict[str, str]` and reads none of its keys against the call, so the
 * file is checked again with the unpacking written out as keywords, and the
 * keyword the key becomes is asked where it is declared: where it is the
 * field the Change renamed, the key is that field. Only a dictionary used
 * for nothing but that one call is renamed; any other is left to the check
 * against the upgraded release, which shows the key it rejects.
 */
async function unpackedKeys(
  references: ReferenceProvider,
  sources: Sources,
  target: TargetSymbol,
  declaration: Declaration,
  composed: Composed,
  result: EngineResult,
): Promise<void> {
  if (!references.definitionAs) return;
  const renamed = composed.path[0] as string;
  for (const [file, text] of sources.texts) {
    if (!text.includes("**") || !text.includes(target.property)) continue;
    const tree = await sources.tree(file);
    if (!tree) continue;
    for (const unpacking of unpackingsIn(tree)) {
      const keys = unpacking.keys.filter((key) => key.key === target.property);
      if (keys.length === 0 || !onlyUnpacked(unpacking)) continue;
      const out = writtenOut(text, [unpacking]);
      const written = out.written.find((each) => each.key.key === target.property);
      if (!written) continue;
      const points = await references.definitionAs(file, out.text, written.start);
      if (!points.some((point) => !isSpan(point) && sameDeclaration(point, declaration)))
        continue;
      for (const key of keys) {
        const token = keyToken(key);
        if (!token) continue;
        const replacement =
          token.type === "identifier"
            ? renamed
            : stringValue(token) === undefined
              ? undefined
              : withStringValue(token, renamed);
        if (replacement === undefined) continue;
        result.edits.push({
          file,
          start: token.startIndex,
          end: token.endIndex,
          replacement,
          changeId: composed.changeIds[0] ?? "",
          author: "codemod",
          reason: `${composed.reasons.join("; ")}; the dictionary is unpacked into the SDK's call`,
        });
      }
    }
  }
}

/** Whether what the Changes do to a field leaves a read of it wrong as written. */
function changesReads(composed: Composed, first: TargetSymbol): boolean {
  return (
    composed.unsupported !== undefined ||
    composed.path.join(".") !== first.property ||
    (composed.scale !== undefined && composed.scale !== 0)
  );
}

/**
 * A path the consumer asks the API to expand, as stripe-python takes them:
 * `expand=["latest_invoice.payment_intent"]` on a call returning a
 * `Subscription`, and where each step of it is declared. A field the API
 * removed is as gone from an expansion as from a read, and the string is
 * no reference a type checker follows, so each step is resolved from the
 * type the call returns.
 */
interface Expansion {
  file: string;
  text: string;
  node: Node;
  path: string[];
  /** The declaration each step of the path reaches, where it resolves. */
  reaches: (Declaration | undefined)[];
}

async function expansionsIn(
  references: ReferenceProvider,
  sources: Sources,
  typeName: string,
): Promise<Expansion[]> {
  const module = typeName.split(".")[0] as string;
  const found: Expansion[] = [];
  for (const [file, text] of sources.texts) {
    if (!text.includes("expand")) continue;
    const tree = await sources.tree(file);
    if (!tree) continue;
    for (const call of descendantsOfType(tree.rootNode, ["call"])) {
      const lists = (call.childForFieldName("arguments")?.namedChildren ?? []).flatMap(
        (argument) => {
          if (argument?.type === "keyword_argument") {
            return argument.childForFieldName("name")?.text === "expand"
              ? [argument.childForFieldName("value")]
              : argument.childForFieldName("name")?.text === "params"
                ? expandIn(argument.childForFieldName("value"))
                : [];
          }
          return expandIn(argument);
        },
      );
      const strings = lists.flatMap((list) =>
        list && ["list", "tuple"].includes(list.type)
          ? list.namedChildren.filter((item): item is Node => item?.type === "string")
          : [],
      );
      if (strings.length === 0) continue;
      const resource = await returnedType(references, file, call, module);
      if (!resource) continue;
      for (const node of strings) {
        const value = stringValue(node);
        if (!value) continue;
        // `data.` expands a list's items, which are what the call returns.
        const path = value
          .split(".")
          .filter((segment, at) => !(at === 0 && segment === "data"));
        const reaches: (Declaration | undefined)[] = [];
        for (let at = 0; at < path.length; at += 1) {
          reaches.push(await references.declarationOf(resource, path.slice(0, at + 1)));
        }
        found.push({ file, text, node, path, reaches });
      }
    }
  }
  return found;
}

/** The `"expand"` entry of a params dictionary written in the call. */
function expandIn(node: Node | null | undefined): (Node | null)[] {
  if (node?.type !== "dictionary") return [];
  return node.namedChildren
    .filter((pair): pair is Node => pair?.type === "pair")
    .filter((pair) => stringValue(pair.childForFieldName("key")) === "expand")
    .map((pair) => pair.childForFieldName("value"));
}

/**
 * What a call to the SDK returns, as a name the SDK's module exports:
 * `Subscription` for `stripe.Subscription.create(...)` and for a client's
 * `subscriptions.create(...)`, read from the signature the checker shows.
 */
async function returnedType(
  references: ReferenceProvider,
  file: string,
  call: Node,
  module: string,
): Promise<string | undefined> {
  const callee = call.childForFieldName("function");
  const name =
    callee?.type === "attribute" ? callee.childForFieldName("attribute") : callee;
  if (!name) return undefined;
  const hover = await references.typeAt(file, name.startIndex);
  const signature = hover?.split("\n\n")[0] ?? "";
  const returned = /->\s*(.+?)\s*$/s.exec(signature)?.[1];
  if (!returned) return undefined;
  const inner =
    /^(?:ListObject|SearchResultObject)\[(.+)\]$/.exec(returned)?.[1] ?? returned;
  const bare = inner.replace(/["']/g, "").trim();
  return /^[A-Za-z_]\w*$/.test(bare) ? `${module}.${bare}` : undefined;
}

async function siteAt(sources: Sources, span: Span): Promise<Site | undefined> {
  const tree = await sources.tree(span.file);
  const text = sources.texts.get(span.file);
  if (!tree || text === undefined) return undefined;
  const node = nodeAt(tree, span.start, span.end);
  if (!node) return undefined;
  return { file: span.file, text, node, role: roleOf(node) };
}

/**
 * Reads and keys by the field's name that the checker could not connect to
 * the SDK: `event["data"]["object"]["current_period_end"]`, or `.current_period_end`
 * on a value it cannot type. Each is reported when what it is read from is
 * either untyped or typed as an SDK class that declares the field; a value the
 * checker knows to be something else, a Django model with its own `status`,
 * is left alone.
 */
async function flagByName(
  references: ReferenceProvider,
  sources: Sources,
  target: TargetSymbol,
  /** Where the old release declares the field, where it does. */
  declaration: Declaration | undefined,
  composed: Composed,
  typed: Set<string>,
  result: EngineResult,
  options: {
    flow?: ValueFlow;
    /** Report a read only where the value is provably the field's class. */
    proven: boolean;
  },
): Promise<void> {
  const name = target.property;
  const changeId = composed.changeIds[0] ?? "";
  const rescaled = composed.scale !== undefined && composed.scale !== 0;
  const reason =
    composed.unsupported ??
    (rescaled
      ? `\`${composed.path.join(".")}\` is now written as the value times 10^${composed.scale}; convert it with the SDK's exact helpers`
      : composed.reasons.join("; "));
  // A field renamed in place is rewritten where the value is certainly the
  // SDK's; anything nested, gone or converted is shown.
  const renamedTo =
    !composed.unsupported &&
    !rescaled &&
    composed.path.length === 1 &&
    composed.path[0] !== name
      ? composed.path[0]
      : undefined;
  for (const [file, text] of sources.texts) {
    if (!text.includes(name)) continue;
    const tree = await sources.tree(file);
    if (!tree) continue;
    const candidates: { node: Node; receiver: Node | null; role: PyRole }[] = [];
    for (const attribute of descendantsOfType(tree.rootNode, ["attribute"])) {
      const field = attribute.childForFieldName("attribute");
      if (field?.text !== name) continue;
      candidates.push({
        node: field,
        receiver: attribute.childForFieldName("object"),
        role: roleOf(field),
      });
    }
    for (const subscript of descendantsOfType(tree.rootNode, ["subscript"])) {
      const key = subscript.childForFieldName("subscript");
      if (stringValue(key) !== name || !key) continue;
      candidates.push({
        node: key,
        receiver: subscript.childForFieldName("value"),
        role: "subscript",
      });
    }
    // `data_object.get("current_period_end")` and `getattr(sub, "...")`:
    // the same read by name, the way webhook handlers usually write it.
    for (const call of descendantsOfType(tree.rootNode, ["call"])) {
      const callee = call.childForFieldName("function");
      const args = call.childForFieldName("arguments")?.namedChildren ?? [];
      if (
        callee?.type === "attribute" &&
        callee.childForFieldName("attribute")?.text === "get"
      ) {
        const key = args[0];
        if (key && stringValue(key) === name) {
          candidates.push({
            node: key,
            receiver: callee.childForFieldName("object"),
            role: "subscript",
          });
        }
      } else if (callee?.type === "identifier" && callee.text === "getattr") {
        const key = args[1];
        if (key && stringValue(key) === name) {
          candidates.push({ node: key, receiver: args[0] ?? null, role: "subscript" });
        }
      }
    }
    for (const candidate of candidates) {
      if (typed.has(`${file}:${candidate.node.startIndex}`)) continue;
      if (candidate.role === "attribute-read" || candidate.role === "attribute-write") {
        // A read the checker resolves somewhere else is some other `name`.
        const points = await references.definitionAt(file, candidate.node.startIndex);
        if (
          points.some(
            (point) => isSpan(point) || !declaration || point.file !== declaration.file,
          )
        )
          continue;
      }
      const evidence = await receiverEvidence(
        references,
        file,
        candidate.receiver,
        target,
        options.flow,
      );
      if (evidence === "other") continue;
      if (options.proven && evidence !== "sdk") continue;
      if (evidence === "sdk" && renamedTo) {
        // The value is the SDK's class, by the checker or by following it,
        // so the name read from it is the field, and renaming it is exact.
        const literal = candidate.role === "subscript" ? candidate.node : undefined;
        if (literal ? stringValue(literal) !== undefined : candidate.role !== "unknown") {
          result.edits.push({
            file,
            start: candidate.node.startIndex,
            end: candidate.node.endIndex,
            replacement: literal ? withStringValue(literal, renamedTo) : renamedTo,
            changeId,
            author: "codemod",
            reason: `${reason}; read by name from a ${target.typeName.split(".").at(-1)}`,
          });
          continue;
        }
      }
      const holder = candidate.node.parent ?? candidate.node;
      const extent = shownExtent(tree, text, holder.startIndex, holder.endIndex);
      result.manual.push(
        manualAt(
          file,
          text,
          extent.start,
          extent.end,
          changeId,
          evidence === "sdk" || evidence === "near"
            ? `${reason}; read here by name from a ${target.typeName.split(".").at(-1)}`
            : `${reason}; read here by name from a value the type checker cannot type, so check it is the API's`,
          candidate.node.startIndex,
        ),
      );
    }
  }
}

/**
 * What the value a field is read from is: the SDK's class that declares it
 * (`sdk`), a type that has that class in it (`near`), a value neither the
 * checker nor value flow can type, or something else entirely.
 */
async function receiverEvidence(
  references: ReferenceProvider,
  file: string,
  receiver: Node | null,
  target: TargetSymbol,
  flow?: ValueFlow,
): Promise<"sdk" | "near" | "untyped" | "other"> {
  if (!receiver) return "untyped";
  // A name bound to nothing but dictionaries written out in the code, and
  // given no key it does not write out, is the consumer's own data, as
  // `LABELS = {"nickname": "Nickname"}` is: whatever the API renames, the
  // key read from it is the one the code wrote.
  if (receiver.type === "identifier" && dictionaryAt(receiver)) return "other";
  // Where the checker cannot type the value, it is followed to where it
  // came from: provably the field's class, or provably some other.
  const followed = async (): Promise<"sdk" | "untyped" | "other"> => {
    const found = flow && (await flow.classOf(file, receiver));
    if (!found) return "untyped";
    return found === target.typeName ? "sdk" : "other";
  };
  // The last name in the receiver is the one whose type is the receiver's:
  // `event.data.object` is typed by `object`, `items[0]` by `items`.
  let probe: Node = receiver;
  while (true) {
    if (probe.type === "attribute") {
      const field = probe.childForFieldName("attribute");
      if (field) {
        probe = field;
        break;
      }
    }
    if (probe.type === "call" || probe.type === "subscript") {
      // A call's result or an item has no name to hover; read by name, it
      // counts as untyped unless it can be followed.
      return followed();
    }
    break;
  }
  const hover = await references.typeAt(file, probe.startIndex);
  if (!hover) return followed();
  const type = hover.split(":").slice(1).join(":").split("\n")[0]?.trim() ?? "";
  if (type === "" || /\b(Unknown|Any)\b/.test(type) || /^dict\[str, /i.test(type))
    return followed();
  const className = target.typeName.split(".").at(-1) ?? "";
  if (classIn(type) === className) return "sdk";
  // `list[Subscription]`, `Subscription | Invoice`: the class is in it, but
  // what is read from it is not certainly the field.
  if (new RegExp(`\\b${className}\\b`).test(type)) return "near";
  return "other";
}
