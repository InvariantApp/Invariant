/**
 * The API called over plain HTTP, read against the same contract as the SDK.
 *
 * A consumer that calls `requests.post("https://api.stripe.com/v1/subscriptions",
 * data={...})` names an operation as exactly as one that calls the SDK: the
 * method and the path say which, and the provider's specification says what
 * that operation takes and returns. So the keys of the dictionary it sends
 * are that operation's parameters, and the JSON its response parses to is
 * the schema the specification gives for a success. A Change to either is
 * then as certain there as at a typed reference: a renamed parameter or
 * field is rewritten, a removed one is shown.
 *
 * Only what the source says outright is read: a URL whose text is written
 * in place, or put together from constants and values written in, and a
 * method named by the function called or written as a string. A URL built
 * any other way, or a path that fits no operation, is not the API's as far
 * as this can tell, and nothing about it is reported.
 */
import type { Change, Op } from "@invariant-app/ir";
import type { ManualSite, WireOperation } from "@invariant-app/migrate-core";
import { type EngineResult, manualAt, shownExtent } from "./engine.ts";
import {
  descendantsOfType,
  importedModules,
  type Node,
  stringValue,
  type Tree,
  withStringValue,
} from "./syntax.ts";
import { dictionaryAt } from "./unpacked.ts";

const METHODS = new Set(["get", "post", "put", "patch", "delete"]);
/** Clients whose module-level functions send one request each. */
const CLIENTS = new Set(["requests", "httpx"]);

/** A request to one of the API's operations, found in the source. */
export interface WireCall {
  call: Node;
  operation: WireOperation;
}

/**
 * The text a URL expression comes to, with `{}` wherever a value is put in:
 * `f"{BASE}/v1/subscriptions/{sub_id}"` is `{}/v1/subscriptions/{}` unless
 * `BASE` is a string constant the module assigns once.
 */
export function urlText(
  node: Node,
  constants: ReadonlyMap<string, string>,
): string | undefined {
  if (node.type === "string") {
    const plain = stringValue(node);
    if (plain !== undefined) return plain;
    // An f-string: its text, with each value put in as `{}`.
    const start = node.children[0]?.text ?? "";
    if (!/f/i.test(start.replace(/["']+$/, "")) || /b/i.test(start)) return undefined;
    let text = "";
    for (const part of node.children.slice(1, -1)) {
      if (!part) continue;
      if (part.type === "string_content") text += part.text;
      else if (part.type === "interpolation") {
        const inner = part.namedChildren[0];
        const known =
          inner?.type === "identifier" ? constants.get(inner.text) : undefined;
        text += known ?? "{}";
      } else return undefined;
    }
    return text;
  }
  if (node.type === "identifier") return constants.get(node.text) ?? "{}";
  if (node.type === "binary_operator" && node.children[1]?.type === "+") {
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    const a = left ? urlText(left, constants) : undefined;
    const b = right ? urlText(right, constants) : undefined;
    return a !== undefined && b !== undefined ? a + b : undefined;
  }
  if (node.type === "concatenated_string") {
    const parts = node.namedChildren.map((part) =>
      part ? urlText(part, constants) : undefined,
    );
    return parts.every((part) => part !== undefined) ? parts.join("") : undefined;
  }
  return undefined;
}

/** Module-level names assigned a plain string once, as `STRIPE_API = "https://..."`. */
function constantsOf(tree: Tree): Map<string, string> {
  const seen = new Map<string, string | undefined>();
  for (const statement of tree.rootNode.namedChildren) {
    const assignment =
      statement?.type === "expression_statement" ? statement.namedChildren[0] : null;
    if (assignment?.type !== "assignment") continue;
    const left = assignment.childForFieldName("left");
    const right = assignment.childForFieldName("right");
    if (left?.type !== "identifier") continue;
    const value = stringValue(right);
    seen.set(left.text, seen.has(left.text) ? undefined : value);
  }
  const constants = new Map<string, string>();
  for (const [name, value] of seen) if (value !== undefined) constants.set(name, value);
  return constants;
}

/** The operation a method and URL reach, where exactly one fits. */
export function operationFor(
  method: string,
  url: string,
  servers: readonly string[],
  operations: readonly WireOperation[],
): WireOperation | undefined {
  const bare = url.split(/[?#]/)[0] as string;
  let path: string | undefined;
  for (const server of servers) {
    const base = server.replace(/\/+$/, "");
    if (bare.startsWith(`${base}/`)) path = bare.slice(base.length);
  }
  // A base put in from elsewhere: the path is what follows it.
  if (path === undefined && bare.startsWith("{}/")) path = bare.slice(2);
  if (path === undefined) return undefined;
  const segments = path.split("/").filter((segment) => segment !== "");
  const fits = operations.filter((operation) => {
    if (operation.method !== method) return false;
    const template = operation.path.split("/").filter((segment) => segment !== "");
    return (
      template.length === segments.length &&
      template.every((part, at) => {
        const segment = segments[at] as string;
        if (/^\{[^}]+\}$/.test(part)) return segment !== "";
        return part === segment;
      })
    );
  });
  // `/v1/customers/search` fits `/v1/customers/{customer}` too; the one
  // with more of its path written out wins, and a tie names none.
  const literal = (operation: WireOperation) =>
    operation.path.split("/").filter((part) => part !== "" && !part.startsWith("{"))
      .length;
  const best = Math.max(...fits.map(literal));
  const top = fits.filter((operation) => literal(operation) === best);
  return top.length === 1 ? top[0] : undefined;
}

/** Every request in a file to one of the API's operations. */
export function wireCalls(
  tree: Tree,
  wire: { servers: string[]; operations: WireOperation[] },
): WireCall[] {
  const imported = importedModules(tree);
  const clients = [...CLIENTS].filter((client) => imported.has(client));
  if (clients.length === 0) return [];
  const constants = constantsOf(tree);
  const found: WireCall[] = [];
  for (const call of descendantsOfType(tree.rootNode, ["call"])) {
    const callee = call.childForFieldName("function");
    if (callee?.type !== "attribute") continue;
    const client = callee.childForFieldName("object");
    const name = callee.childForFieldName("attribute")?.text ?? "";
    if (client?.type !== "identifier" || !clients.includes(client.text)) continue;
    const args = (call.childForFieldName("arguments")?.namedChildren ?? []).filter(
      (arg): arg is Node => arg !== null && arg.type !== "comment",
    );
    const keyword = (key: string) =>
      args
        .find(
          (arg) =>
            arg.type === "keyword_argument" &&
            arg.childForFieldName("name")?.text === key,
        )
        ?.childForFieldName("value");
    const positional = args.filter((arg) => arg.type !== "keyword_argument");
    let method: string | undefined;
    let url: Node | null | undefined;
    if (METHODS.has(name)) {
      method = name;
      url = keyword("url") ?? positional[0];
    } else if (name === "request") {
      method = stringValue(keyword("method") ?? positional[0])?.toLowerCase();
      url = keyword("url") ?? positional[1];
    }
    if (!method || !url) continue;
    const text = urlText(url, constants);
    const operation = text && operationFor(method, text, wire.servers, wire.operations);
    if (operation) found.push({ call, operation });
  }
  return found;
}

/** What one Change does to one top-level name: renamed in place, or gone. */
interface Fate {
  changeId: string;
  renamed?: string;
  reason: string;
}

const segmentsOf = (pointer: string) =>
  pointer.split("/").filter((segment) => segment !== "");

/** What a list of ops does to each top-level name they touch. */
function fatesOf(ops: readonly Op[], changeId: string, fates: Map<string, Fate>): void {
  for (const op of ops) {
    if (op.op === "move") {
      const from = segmentsOf(op.from);
      const to = segmentsOf(op.to);
      if (from.length !== 1 || from[0]?.startsWith("@")) continue;
      fates.set(from[0] as string, {
        changeId,
        ...(to.length === 1 && !to[0]?.startsWith("@")
          ? { renamed: to[0] as string }
          : {}),
        reason: `renamed ${op.from} to ${op.to}`,
      });
    } else if (op.op === "remove") {
      const path = segmentsOf(op.path);
      if (path.length !== 1) continue;
      fates.set(path[0] as string, {
        changeId,
        reason: `\`${path[0]}\` is no longer in the contract, and nothing was declared in its place`,
      });
    }
  }
}

/** What the Changes do to each parameter of an operation, where it is sent. */
function parameterFates(
  changes: readonly Change[],
  operation: string,
  location: "query" | "body",
): Map<string, Fate> {
  const fates = new Map<string, Fate>();
  for (const change of changes) {
    for (const scope of change.scopes ?? []) {
      if (!("location" in scope) || scope.operation !== operation) continue;
      if (scope.location === location) fatesOf(change.ops, change.id, fates);
    }
  }
  return fates;
}

/** What the Changes do to each field of a schema. */
function fieldFates(changes: readonly Change[], schema: string): Map<string, Fate> {
  const fates = new Map<string, Fate>();
  for (const change of changes) {
    for (const scope of change.scopes ?? []) {
      if ("schema" in scope && scope.schema === `#/components/schemas/${schema}`) {
        fatesOf(change.ops, change.id, fates);
      }
    }
  }
  return fates;
}

/** The string keys read from a holder: `holder["k"]` and `holder.get("k")`. */
function keyReads(
  scope: Node,
  isHolder: (node: Node) => boolean,
): { key: Node; name: string }[] {
  const reads: { key: Node; name: string }[] = [];
  for (const subscript of descendantsOfType(scope, ["subscript"])) {
    const value = subscript.childForFieldName("value");
    const key = subscript.childForFieldName("subscript");
    const name = stringValue(key);
    if (value && key && name !== undefined && isHolder(value)) reads.push({ key, name });
  }
  for (const call of descendantsOfType(scope, ["call"])) {
    const callee = call.childForFieldName("function");
    const key = call.childForFieldName("arguments")?.namedChildren[0];
    const name = stringValue(key);
    if (
      callee?.type === "attribute" &&
      callee.childForFieldName("attribute")?.text === "get" &&
      key &&
      name !== undefined
    ) {
      const object = callee.childForFieldName("object");
      if (object && isHolder(object)) reads.push({ key, name });
    }
  }
  return reads;
}

/** The function or module a node is in. */
function scopeOf(node: Node): Node {
  let current = node.parent;
  while (current && current.type !== "function_definition" && current.type !== "module") {
    current = current.parent;
  }
  return current ?? node.tree.rootNode;
}

/** The name a call's value is assigned to, where it is assigned to one. */
function assignedName(node: Node): string | undefined {
  const holder = node.parent;
  return holder?.type === "assignment" &&
    holder.childForFieldName("right")?.id === node.id &&
    holder.childForFieldName("left")?.type === "identifier"
    ? holder.childForFieldName("left")?.text
    : undefined;
}

/**
 * The JSON a request's response parses to: `requests.get(...).json()`, or
 * `.json()` on the name the response is assigned to, or the name that is
 * assigned to in turn, within the function the request is made in. A name
 * assigned more than once there is not followed.
 */
function parsedBodies(call: Node): Node[] {
  const scope = scopeOf(call);
  const onceAssigned = (name: string) =>
    descendantsOfType(scope, ["assignment"]).filter(
      (assignment) => assignment.childForFieldName("left")?.text === name,
    ).length === 1;
  const isJson = (node: Node, holder: (object: Node) => boolean) =>
    node.type === "call" &&
    node.childForFieldName("function")?.type === "attribute" &&
    node.childForFieldName("function")?.childForFieldName("attribute")?.text === "json" &&
    holder(node.childForFieldName("function")?.childForFieldName("object") as Node);
  const response = assignedName(call);
  const holders = (object: Node) =>
    object.id === call.id ||
    (response !== undefined && object.type === "identifier" && object.text === response);
  if (response !== undefined && !onceAssigned(response)) return [];
  return descendantsOfType(scope, ["call"]).filter((node) => isJson(node, holders));
}

/**
 * Every request to the API in a file, against the Changes: each parameter
 * sent that a Change renamed or removed, and each field read from the
 * response that a Change renamed or removed on the schema it is.
 */
export function wireSites(
  file: string,
  text: string,
  tree: Tree,
  plan: {
    changes: readonly Change[];
    wire: { servers: string[]; operations: WireOperation[] };
  },
  result: EngineResult,
): void {
  const report = (node: Node, changeId: string, reason: string): ManualSite => {
    const extent = shownExtent(tree, text, node.startIndex, node.endIndex);
    return manualAt(file, text, extent.start, extent.end, changeId, reason);
  };
  const apply = (key: Node, fate: Fate, where: string) => {
    if (fate.renamed && stringValue(key) !== undefined) {
      result.edits.push({
        file,
        start: key.startIndex,
        end: key.endIndex,
        replacement: withStringValue(key, fate.renamed),
        changeId: fate.changeId,
        author: "codemod",
        reason: `${fate.reason}; ${where}`,
      });
    } else {
      result.manual.push(
        report(key.parent ?? key, fate.changeId, `${fate.reason}; ${where}`),
      );
    }
  };
  for (const { call, operation } of wireCalls(tree, plan.wire)) {
    const label = `${operation.method.toUpperCase()} ${operation.path}`;
    const args = call.childForFieldName("arguments")?.namedChildren ?? [];
    for (const arg of args) {
      if (arg?.type !== "keyword_argument") continue;
      const which = arg.childForFieldName("name")?.text ?? "";
      const location =
        which === "params"
          ? "query"
          : ["data", "json"].includes(which)
            ? "body"
            : undefined;
      const value = arg.childForFieldName("value");
      const dictionary = location && value ? dictionaryAt(value) : undefined;
      if (!location || !dictionary) continue;
      const fates = parameterFates(plan.changes, operation.id, location);
      for (const { key, node } of dictionary.keys) {
        const fate = fates.get(key);
        if (!fate) continue;
        const literal = node.type === "pair" ? node.childForFieldName("key") : null;
        const { renamed: _, ...shown } = fate;
        apply(literal ?? node, literal ? fate : shown, `sent here to ${label}`);
      }
    }
    if (!operation.response) continue;
    const fates = fieldFates(plan.changes, operation.response);
    if (fates.size === 0) continue;
    for (const body of parsedBodies(call)) {
      const parsed = assignedName(body);
      const scope = scopeOf(body);
      const reads = keyReads(
        scope,
        (node) =>
          node.id === body.id ||
          (parsed !== undefined && node.type === "identifier" && node.text === parsed),
      );
      for (const { key, name } of reads) {
        const fate = fates.get(name);
        if (fate) {
          apply(
            key,
            fate,
            `read here from the response of ${label}, a ${operation.response}`,
          );
        }
      }
    }
  }
}
