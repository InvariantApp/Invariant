/**
 * Where a value came from, followed through the consumer's own code.
 *
 * pyright types what the SDK's annotations and the consumer's own reach, and
 * stops at what they do not: a helper with no annotations, a response turned
 * into a dictionary, a value read by key from another. Those are the ordinary
 * way Python passes an API's objects around, so a read of a field there is
 * one the checker cannot tie to the SDK, and the engine could only report it
 * as a read of a value it cannot type.
 *
 * This follows such a value back, one step at a time and only through what
 * the code says outright: an assignment, the argument every call in the
 * project passes to an unannotated parameter, what a function of the
 * consumer's returns, a key or attribute read from a value already followed,
 * and `to_dict()` or `dict(...)`. At each step the checker is asked first; a
 * step it cannot type is followed, and one that could have come from more
 * than one place counts only where every place agrees. Where the trail ends
 * at a call into the SDK that says what it returns, the value is that class,
 * as certainly as if the consumer had annotated it. Anything else is not
 * known, and is treated as before.
 */

import type { Sources } from "./engine.ts";
import { isSpan, type ReferenceProvider, type Span } from "./references.ts";
import {
  descendantsOfType,
  enclosing,
  type Node,
  nodeAt,
  stringValue,
} from "./syntax.ts";

/** The checker, and the two questions value flow adds to what the engine asks it. */
export interface FlowProvider extends ReferenceProvider {
  /** Every reference in the open files to the name at `offset` in a source file. */
  referencesAt?(file: string, offset: number): Promise<Span[]>;
  /** What the checker says a member reached from `typeName` by `path` is, as hover text. */
  memberType?(typeName: string, path: readonly string[]): Promise<string | undefined>;
}

/** How far a value is followed before it counts as not known. */
const MAX_DEPTH = 6;
/** The most call sites read for one parameter. */
const MAX_CALLS = 12;

/** The type in a hover: `(variable) sub: Subscription` shows `Subscription`. */
export function hoverType(hover: string | undefined): string | undefined {
  if (!hover) return undefined;
  const first = hover.split("\n\n")[0] ?? "";
  // A function's hover is its signature; the type is what it returns.
  if (/^\((?:function|method)\)/.test(first)) return undefined;
  const at = first.indexOf(": ");
  return at === -1 ? undefined : first.slice(at + 2).trim();
}

/**
 * The one class a type names, `None` aside: `Subscription | None` and
 * `Optional[Subscription]` are `Subscription`; a union of two classes, a
 * generic container and anything the checker could not type name none.
 */
export function classIn(type: string | undefined): string | undefined {
  if (!type) return undefined;
  const bare = type
    .replace(/^Optional\[(.*)\]$/s, "$1")
    .split("|")
    .map((part) => part.trim())
    .filter((part) => part !== "None");
  if (bare.length !== 1) return undefined;
  const name = (bare[0] as string).replace(/^type\[(.*)\]$/, "$1");
  if (!/^[A-Za-z_][\w.]*$/.test(name)) return undefined;
  if (
    /^(Unknown|Any|object|dict|Dict|list|List|str|int|float|bool|bytes|None)$/.test(name)
  )
    return undefined;
  return name;
}

/** What a function's hover says it returns: `-> Subscription`. */
export function returnedClass(hover: string | undefined): string | undefined {
  const signature = hover?.split("\n\n")[0] ?? "";
  if (!/^\((?:function|method)\)/.test(signature)) return undefined;
  const returned = /->\s*(.+?)\s*$/s.exec(signature)?.[1];
  return classIn(returned?.replace(/["']/g, ""));
}

export class ValueFlow {
  private readonly references: FlowProvider;
  private readonly sources: Sources;
  /** The SDK's top module, which every class it exports is qualified by. */
  private readonly module: string;
  private readonly qualified = new Map<string, Promise<string | undefined>>();
  private readonly followed = new Map<string, Promise<string | undefined>>();
  /** Values being followed now, down the one chain of calls that is running. */
  private readonly following = new Set<string>();

  constructor(references: FlowProvider, sources: Sources, module: string) {
    this.references = references;
    this.sources = sources;
    this.module = module;
  }

  /**
   * The SDK class a value provably is, qualified as the SDK exports it
   * (`stripe.Subscription`), or nothing where that is not certain.
   */
  classOf(file: string, node: Node, depth = 0): Promise<string | undefined> {
    const key = `${file}:${node.startIndex}:${node.endIndex}`;
    // A value that leads back to one still being followed ends there. Handing
    // back that value's own unfinished answer would have it wait on itself,
    // which is what happened once the cycle passed through an `await`: the
    // run stopped with nothing left to happen. Calls are made one at a time,
    // so a value met again while it is followed is always a cycle.
    if (this.following.has(key)) return Promise.resolve(undefined);
    let found = this.followed.get(key);
    if (!found) {
      if (depth > MAX_DEPTH) found = Promise.resolve(undefined);
      else {
        this.following.add(key);
        found = this.follow(file, node, depth).finally(() => this.following.delete(key));
      }
      this.followed.set(key, found);
    }
    return found;
  }

  private async follow(
    file: string,
    node: Node,
    depth: number,
  ): Promise<string | undefined> {
    switch (node.type) {
      case "parenthesized_expression": {
        const inner = node.namedChildren[0];
        return inner ? this.classOf(file, inner, depth + 1) : undefined;
      }
      case "identifier":
        return (await this.shown(file, node)) ?? this.assigned(file, node, depth);
      case "attribute": {
        const name = node.childForFieldName("attribute");
        const object = node.childForFieldName("object");
        if (!name || !object) return undefined;
        return (
          (await this.shown(file, name)) ??
          this.member(await this.classOf(file, object, depth + 1), name.text)
        );
      }
      case "subscript": {
        const value = node.childForFieldName("value");
        const key = stringValue(node.childForFieldName("subscript"));
        if (!value || key === undefined) return undefined;
        return this.member(await this.classOf(file, value, depth + 1), key);
      }
      case "call":
        return this.called(file, node, depth);
      default:
        return undefined;
    }
  }

  /** What the checker shows a name to be, where that is one of the SDK's classes. */
  private async shown(file: string, name: Node): Promise<string | undefined> {
    const shown = classIn(hoverType(await this.references.typeAt(file, name.startIndex)));
    return shown ? this.qualify(shown) : undefined;
  }

  /** `Subscription` as the SDK exports it, `stripe.Subscription`, where it does. */
  private qualify(name: string): Promise<string | undefined> {
    let found = this.qualified.get(name);
    if (!found) {
      const full = name.startsWith(`${this.module}.`) ? name : `${this.module}.${name}`;
      found = this.references
        .moduleAttribute(this.module, full.slice(this.module.length + 1))
        .then((declaration) => (declaration ? full : undefined))
        .catch(() => undefined);
      this.qualified.set(name, found);
    }
    return found;
  }

  /** The class of a member of an SDK class, as the SDK declares it. */
  private async member(
    holder: string | undefined,
    name: string,
  ): Promise<string | undefined> {
    if (!holder || !this.references.memberType || !/^[A-Za-z_]\w*$/.test(name)) {
      return undefined;
    }
    const shown = classIn(hoverType(await this.references.memberType(holder, [name])));
    return shown ? this.qualify(shown) : undefined;
  }

  /** Where the consumer assigned a name, or what every call passes a parameter. */
  private async assigned(
    file: string,
    name: Node,
    depth: number,
  ): Promise<string | undefined> {
    const points = await this.references.definitionAt(file, name.startIndex);
    if (points.length === 0) return undefined;
    const found: (string | undefined)[] = [];
    for (const point of points) {
      if (!isSpan(point)) return undefined;
      const tree = await this.sources.tree(point.file);
      const target = tree && nodeAt(tree, point.start, point.end);
      if (!target) return undefined;
      const holder = target.parent;
      if (
        holder?.type === "assignment" &&
        holder.childForFieldName("left")?.id === target.id
      ) {
        const right = holder.childForFieldName("right");
        // `x: Subscription` alone binds nothing, and the checker already read it.
        if (!right) return undefined;
        found.push(await this.classOf(point.file, right, depth + 1));
        continue;
      }
      const parameter = parameterOf(target);
      if (parameter) {
        found.push(await this.passed(point.file, parameter, depth));
        continue;
      }
      return undefined;
    }
    return agreed(found);
  }

  /**
   * What every call in the project passes to an unannotated parameter. One
   * call the value cannot be followed from, or two that disagree, and the
   * parameter is not known.
   */
  private async passed(
    file: string,
    parameter: { fn: Node; index: number; name: string; method: boolean },
    depth: number,
  ): Promise<string | undefined> {
    if (!this.references.referencesAt) return undefined;
    const fnName = parameter.fn.childForFieldName("name");
    if (!fnName) return undefined;
    const uses = await this.references.referencesAt(file, fnName.startIndex);
    if (uses.length === 0 || uses.length > MAX_CALLS) return undefined;
    const found: (string | undefined)[] = [];
    for (const use of uses) {
      const tree = await this.sources.tree(use.file);
      const node = tree && nodeAt(tree, use.start, use.end);
      const callee =
        node?.parent?.type === "attribute" &&
        node.parent.childForFieldName("attribute")?.id === node.id
          ? node.parent
          : node;
      const call = callee?.parent;
      if (
        !callee ||
        call?.type !== "call" ||
        call.childForFieldName("function")?.id !== callee.id
      )
        return undefined;
      const args = (call.childForFieldName("arguments")?.namedChildren ?? []).filter(
        (arg): arg is Node => arg !== null && arg.type !== "comment",
      );
      if (
        args.some((arg) => arg.type === "list_splat" || arg.type === "dictionary_splat")
      )
        return undefined;
      // `obj.method(x)` passes `x` as the second parameter, after `self`.
      const bound = parameter.method && callee.type === "attribute" ? 1 : 0;
      const keyword = args.find(
        (arg) =>
          arg.type === "keyword_argument" &&
          arg.childForFieldName("name")?.text === parameter.name,
      );
      const positional = args.filter((arg) => arg.type !== "keyword_argument");
      const arg =
        keyword?.childForFieldName("value") ?? positional[parameter.index - bound];
      if (!arg) return undefined;
      found.push(await this.classOf(use.file, arg, depth + 1));
    }
    return agreed(found);
  }

  private async called(
    file: string,
    call: Node,
    depth: number,
  ): Promise<string | undefined> {
    const callee = call.childForFieldName("function");
    const args = (call.childForFieldName("arguments")?.namedChildren ?? []).filter(
      (arg): arg is Node => arg !== null && arg.type !== "comment",
    );
    if (!callee) return undefined;
    if (callee.type === "attribute") {
      const method = callee.childForFieldName("attribute");
      const object = callee.childForFieldName("object");
      if (!method || !object) return undefined;
      // `sub.get("latest_invoice")` reads a key as a subscript does.
      if (method.text === "get" && args[0]) {
        const key = stringValue(args[0]);
        return key === undefined
          ? undefined
          : this.member(await this.classOf(file, object, depth + 1), key);
      }
      // A plain copy of an object is the same object's shape.
      if (
        ["to_dict", "to_dict_recursive", "copy"].includes(method.text) &&
        args.length === 0
      ) {
        return this.classOf(file, object, depth + 1);
      }
    }
    if (
      callee.type === "identifier" &&
      ["dict", "deepcopy", "copy"].includes(callee.text) &&
      args.length === 1 &&
      args[0]?.type !== "keyword_argument"
    ) {
      return this.classOf(file, args[0] as Node, depth + 1);
    }
    const name =
      callee.type === "attribute" ? callee.childForFieldName("attribute") : callee;
    if (!name) return undefined;
    const said = returnedClass(await this.references.typeAt(file, name.startIndex));
    if (said) return this.qualify(said);
    // A function of the consumer's own: what each of its returns is.
    const points = await this.references.definitionAt(file, name.startIndex);
    if (points.length !== 1 || !isSpan(points[0] as Span)) return undefined;
    const point = points[0] as Span;
    const tree = await this.sources.tree(point.file);
    const fn = tree && enclosing(tree, point.start, "function_definition");
    if (!fn || fn.childForFieldName("name")?.startIndex !== point.start) return undefined;
    const returns = descendantsOfType(fn, ["return_statement"]).filter(
      (statement) =>
        enclosing(tree, statement.startIndex, "function_definition")?.id === fn.id,
    );
    if (returns.length === 0) return undefined;
    const found: (string | undefined)[] = [];
    for (const statement of returns) {
      const value = statement.namedChildren[0];
      if (!value) return undefined;
      found.push(await this.classOf(point.file, value, depth + 1));
    }
    return agreed(found);
  }
}

/** The one answer every way agrees on, or nothing. */
function agreed(found: readonly (string | undefined)[]): string | undefined {
  const first = found[0];
  return first !== undefined && found.every((each) => each === first) ? first : undefined;
}

/** The function an unannotated parameter belongs to, and where in its list it is. */
export function parameterOf(
  name: Node,
): { fn: Node; index: number; name: string; method: boolean } | undefined {
  const parameters = name.parent;
  if (parameters?.type !== "parameters") return undefined;
  const fn = parameters.parent;
  if (fn?.type !== "function_definition") return undefined;
  const list = parameters.namedChildren.filter(
    (child): child is Node => child !== null && child.type !== "comment",
  );
  const index = list.findIndex((child) => child.id === name.id);
  if (index === -1) return undefined;
  const inClass =
    fn.parent?.type === "block" && fn.parent.parent?.type === "class_definition";
  const decorated = fn.parent?.type === "decorated_definition" ? fn.parent : undefined;
  const staticMethod = decorated?.text.startsWith("@staticmethod") ?? false;
  const method =
    (inClass || decorated?.parent?.parent?.type === "class_definition") && !staticMethod;
  return { fn, index, name: name.text, method };
}
