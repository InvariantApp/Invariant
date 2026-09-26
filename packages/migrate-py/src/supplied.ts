/**
 * Fields a type now has that the places building one do not write.
 *
 * A request field that became required, with the value the API always used
 * when it was left out, is written into every request the consumer builds:
 * the keywords of a call whose parameters are that request's fields
 * (`create(**params: Unpack[CustomerCreateParams])`), and the keys of a
 * dictionary the checker types as it. Which call or dictionary builds the
 * request is the checker's to say, and it says it of the keywords and keys
 * already written: each resolves to the field the request type declares.
 *
 * A response field that is new has no value to write: a consumer builds a
 * response only as a stand-in, in a test, and what it should hold there is
 * theirs to say. Each place that constructs the response's class without
 * it is shown instead.
 */
import type { AddOp, DataOp, DefaultOp } from "@invariant-app/ir";
import type { MigrationPlan, TargetSymbol } from "@invariant-app/migrate-core";
import { type EngineResult, manualAt, type Sources, shownExtent } from "./engine.ts";
import {
  classDeclaration,
  type Declaration,
  isSpan,
  type ReferenceProvider,
  sameDeclaration,
} from "./references.ts";
import { descendantsOfType, type Node, stringValue } from "./syntax.ts";

/**
 * An op that means every caller now has to send the field: a new required
 * one, or an existing one that stopped being optional.
 */
function suppliesField(op: DataOp): op is AddOp | DefaultOp {
  return (
    op.op === "add" || (op.op === "default" && op.toward === "new" && op.when !== "null")
  );
}

/** A value as Python writes it, or nothing for one it has no literal for. */
export function pythonLiteral(value: unknown): string | undefined {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    const items = value.map(pythonLiteral);
    return items.every((item) => item !== undefined)
      ? `[${items.join(", ")}]`
      : undefined;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => {
        const literal = pythonLiteral(item);
        return literal === undefined ? undefined : `${JSON.stringify(key)}: ${literal}`;
      },
    );
    return entries.every((entry) => entry !== undefined)
      ? `{${entries.join(", ")}}`
      : undefined;
  }
  return undefined;
}

/**
 * The edit that writes `entry` last in a call's arguments or a dictionary,
 * keeping how the items are laid out: on one line after a comma, or on a
 * line of its own at the items' indent, with a trailing comma where the
 * items have one.
 */
export function appendedEntry(
  text: string,
  container: Node,
  entry: string,
): { start: number; end: number; replacement: string } | undefined {
  const close = container.children.at(-1);
  if (!close || ![")", "}"].includes(close.type)) return undefined;
  const items = container.namedChildren.filter(
    (item): item is Node => item !== null && item.type !== "comment",
  );
  const last = items.at(-1);
  if (!last) {
    return { start: close.startIndex, end: close.endIndex, replacement: `${entry})` };
  }
  const comma = container.children.find(
    (child) => child !== null && child.type === "," && child.startIndex >= last.endIndex,
  );
  const from = comma ? comma.endIndex : last.endIndex;
  const between = text.slice(from, close.startIndex);
  if (!between.includes("\n")) {
    return {
      start: from,
      end: close.endIndex,
      replacement: `${comma ? " " : ", "}${entry}${between}${close.text}`,
    };
  }
  const lineStart = text.lastIndexOf("\n", last.startIndex - 1) + 1;
  const indent = text.slice(lineStart, last.startIndex);
  if (!/^[ \t]*$/.test(indent)) return undefined;
  return {
    start: from,
    end: close.endIndex,
    replacement: `${comma ? "" : ","}\n${indent}${entry}${comma ? "," : ""}${between}${close.text}`,
  };
}

/** Whether a call or dictionary may pass more than it writes: `**params`. */
function unpacks(container: Node): boolean {
  return container.namedChildren.some(
    (child) => child?.type === "dictionary_splat" || child?.type === "list_splat",
  );
}

export async function suppliedFields(
  references: ReferenceProvider,
  sources: Sources,
  plan: MigrationPlan,
  result: EngineResult,
): Promise<void> {
  for (const target of plan.targets) {
    if (!suppliesField(target.op)) continue;
    await supplyField(references, sources, target, target.op.value, result);
  }
}

async function supplyField(
  references: ReferenceProvider,
  sources: Sources,
  target: TargetSymbol,
  value: unknown,
  result: EngineResult,
): Promise<void> {
  const within = target.within ?? [];
  const head = target.property;
  const literal = value === null ? undefined : pythonLiteral(value);
  /** Where the type declares each field a keyword or key names, asked once per name. */
  const declared = new Map<string, Promise<Declaration | undefined>>();
  const fieldOf = (name: string) => {
    let found = declared.get(name);
    if (!found) {
      found = references.declarationOf(target.typeName, [...within, name]);
      declared.set(name, found);
    }
    return found;
  };
  /** Whether the name written at `offset` resolves to the field the type declares. */
  const isField = async (file: string, offset: number, name: string) => {
    if (name === head || !/^[A-Za-z_]\w*$/.test(name)) return false;
    const field = await fieldOf(name);
    if (!field) return false;
    const points = await references.definitionAt(file, offset);
    return points.some((point) => !isSpan(point) && sameDeclaration(point, field));
  };
  let holder: Promise<Declaration | undefined> | undefined;
  const reason = "supplied the default this field always had before it became explicit";

  for (const [file, text] of sources.texts) {
    const tree = await sources.tree(file);
    if (!tree) continue;
    const add = (container: Node, entry: string) => {
      const edit = appendedEntry(text, container, entry);
      if (!edit) return;
      result.edits.push({
        file,
        ...edit,
        changeId: target.changeId,
        author: "codemod",
        reason,
      });
    };
    const standIn = (node: Node) => {
      const extent = shownExtent(tree, text, node.startIndex, node.endIndex);
      result.manual.push(
        manualAt(
          file,
          text,
          extent.start,
          extent.end,
          target.changeId,
          `this object stands for a response that now has \`${head}\`; add the value it should hold`,
          node.startIndex,
        ),
      );
    };

    for (const call of descendantsOfType(tree.rootNode, ["call"])) {
      const args = call.childForFieldName("arguments");
      if (args?.type !== "argument_list" || unpacks(args)) continue;
      const keywords = args.namedChildren.filter(
        (arg): arg is Node => arg?.type === "keyword_argument",
      );
      if (keywords.some((keyword) => keyword.childForFieldName("name")?.text === head))
        continue;
      // The type's own class, constructed: a stand-in where the field has no
      // value to write, as a response's new field has not.
      const callee = call.childForFieldName("function");
      const name =
        callee?.type === "attribute" ? callee.childForFieldName("attribute") : callee;
      if (within.length === 0 && name && /^[A-Z]/.test(name.text)) {
        holder ??= classDeclaration(references, target.typeName);
        const declaration = await holder;
        const points = declaration
          ? await references.definitionAt(file, name.startIndex)
          : [];
        if (
          declaration &&
          points.some((point) => !isSpan(point) && sameDeclaration(point, declaration))
        ) {
          if (literal === undefined) standIn(call);
          else add(args, `${head}=${literal}`);
          continue;
        }
      }
      // A call whose keywords are the type's fields, as a request's are.
      const first = keywords[0]?.childForFieldName("name");
      if (
        literal === undefined ||
        !first ||
        !/^[A-Za-z_]\w*$/.test(head) ||
        !(await isField(file, first.startIndex, first.text))
      )
        continue;
      add(args, `${head}=${literal}`);
    }

    for (const dictionary of descendantsOfType(tree.rootNode, ["dictionary"])) {
      if (unpacks(dictionary)) continue;
      const pairs = dictionary.namedChildren.filter(
        (pair): pair is Node => pair?.type === "pair",
      );
      const keys = pairs.map((pair) => pair.childForFieldName("key"));
      if (keys.some((key) => stringValue(key) === head)) continue;
      const first = keys[0];
      const key = stringValue(first);
      if (!first || key === undefined) continue;
      // Asked inside the quotes, where the key's name is.
      if (!(await isField(file, first.startIndex + 1, key))) continue;
      if (literal === undefined) standIn(dictionary);
      else {
        const quote = first.children[0]?.text.replace(/^[a-zA-Z]*/, "") ?? '"';
        add(dictionary, `${quote}${head}${quote}: ${literal}`);
      }
    }
  }
}
