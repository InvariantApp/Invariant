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
import { classIn, type ValueFlow } from "./flows.ts";
import {
  type Declaration,
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
  unsupported: string | undefined;
}

const segmentsOf = (pointer: string) =>
  pointer.split("/").filter((segment) => segment !== "");

export function compose(targets: readonly TargetSymbol[]): Composed {
  const first = targets[0] as TargetSymbol;
  const composed: Composed = {
    path: [first.property],
    changeIds: [],
    reasons: [],
    values: new Map(),
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

/** The string literals a read of the field is compared with: `sub.status == "active"`. */
function comparedLiterals(read: Node): Node[] {
  // `sub.status` is the attribute; the comparison holds it.
  const attribute = read.parent;
  const comparison = attribute?.parent;
  if (!attribute || comparison?.type !== "comparison_operator") return [];
  const others = comparison.namedChildren.filter(
    (child): child is Node => child !== null && child.id !== attribute.id,
  );
  return others.flatMap((other) =>
    other.type === "string"
      ? [other]
      : ["tuple", "list", "set"].includes(other.type)
        ? other.namedChildren.filter((item): item is Node => item?.type === "string")
        : [],
  );
}

function renameValues(site: Site, composed: Composed, result: EngineResult): void {
  const literals =
    site.role === "attribute-read"
      ? comparedLiterals(site.node)
      : site.role === "keyword" || site.role === "dict-key"
        ? [site.node.parent?.childForFieldName("value")].filter(
            (value): value is Node => value?.type === "string",
          )
        : [];
  for (const literal of literals) {
    const value = stringValue(literal);
    const mapped = value === undefined ? undefined : composed.values.get(value);
    if (mapped === undefined) continue;
    result.edits.push({
      file: site.file,
      start: literal.startIndex,
      end: literal.endIndex,
      replacement: withStringValue(literal, mapped),
      changeId: composed.changeIds[0] ?? "",
      author: "codemod",
      reason: "updated a value to the vocabulary the contract now uses",
    });
  }
}

/** Rewrites one typed reference, or reports why it cannot. */
function applyComposed(
  site: Site,
  composed: Composed,
  first: TargetSymbol,
  result: EngineResult,
): void {
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
  const renamed = composed.path.length !== 1 || composed.path[0] !== first.property;
  if (!renamed) return;
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
      if (composed.path.length > 1) {
        flag(`the value is now nested at ${composed.path.join(".")}`);
        return;
      }
      edit(site.node, composed.path[0] as string);
      return;
    case "dict-key": {
      if (composed.path.length > 1) {
        flag(`the value is now nested at ${composed.path.join(".")}`);
        return;
      }
      const literal = site.node.type === "string" ? site.node : site.node.parent;
      if (!literal || stringValue(literal) === undefined) {
        flag("this key is not a plain string to rename");
        return;
      }
      edit(literal, withStringValue(literal, composed.path[0] as string));
      return;
    }
    default:
      flag(
        `this ${site.role === "subscript" ? "subscript" : "use"} of the field needs rewriting by hand: ${reason}`,
      );
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
  for (const targets of groupTargets(plan)) {
    const first = targets[0] as TargetSymbol;
    if (!words.has(first.property)) continue;
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
      const composed = compose(targets);
      if (
        (first.within ?? []).length === 0 &&
        (composed.unsupported || composed.path.join(".") !== first.property)
      ) {
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
    const composed = compose(targets);
    const typed = new Set<string>();
    for (const span of await references.referencesTo(declaration)) {
      const site = await siteAt(sources, span);
      if (!site) continue;
      typed.add(`${span.file}:${span.start}`);
      applyComposed(site, composed, first, result);
    }
    // What the checker could not type is found by name, and only reported.
    if (composed.unsupported || composed.path.join(".") !== first.property) {
      await flagByName(references, sources, first, declaration, composed, typed, result, {
        ...options,
        proven: options.untyped === true,
      });
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
  return { resolved, unresolved };
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
  const reason = composed.unsupported ?? composed.reasons.join("; ");
  // A field renamed in place is rewritten where the value is certainly the
  // SDK's; anything nested or gone is shown.
  const renamedTo =
    !composed.unsupported && composed.path.length === 1 && composed.path[0] !== name
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
