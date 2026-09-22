/**
 * The consumer migration engine.
 *
 * Finding the call sites is the type checker's job, not a pattern matcher's.
 * Asking it for every reference to a property declared in the SDK returns the
 * object-literal writes, the property reads, the destructuring bindings and the
 * type positions, through aliases and helper functions, with no heuristics and
 * no false positives.
 *
 * Every op that touches one field is then composed into a single edit for each
 * site. A rename and a unit conversion on the same value are one change to the
 * source, not two edits fighting over the same span, and composing them is what
 * turns `charge.amount` into `fromMinorUnits(charge.amount_cents)` rather than
 * into either half of it.
 *
 * Anything outside the shapes below is reported with an exact location rather
 * than rewritten on a guess. A migration that quietly gets one call site wrong
 * is worse than one that says which call site it could not do.
 */
import type { AddOp, Codec, DataOp, DefaultOp } from "@invariant/ir";
import {
  Node,
  type Project,
  type PropertySignature,
  SyntaxKind,
  type Type,
  type TypeElementTypes,
} from "ts-morph";
import type { Edit, Replacement } from "./edits.ts";
import { exactMinorUnits } from "./numbers.ts";
import type { MigrationPlan, Role, TargetSymbol } from "./plan.ts";

export interface ManualSite {
  file: string;
  line: number;
  column: number;
  changeId: string;
  reason: string;
  snippet: string;
  /**
   * Byte offset in the file as it was before any edit.
   *
   * Kept so the reported line can be moved to where the site ends up. A
   * migration that inserts an import shifts every line below it, and a report
   * that points a reviewer one line above the thing it is talking about is
   * worse than one that points nowhere.
   */
  offset: number;
  /** Where the flagged node ends, also before any edit, so a reviewer sees its extent. */
  end?: number;
}

export interface EngineResult {
  edits: Edit[];
  manual: ManualSite[];
  /** Helper names the edits used, so each file's import is extended once. */
  helpersUsed: Map<string, Set<string>>;
}

function roleOf(node: Node): Role {
  const parent = node.getParent();
  if (!parent) return "unknown";

  if (Node.isPropertyAssignment(parent) && parent.getNameNode() === node) {
    const initializer = parent.getInitializer();
    return initializer && Node.isNumericLiteral(initializer)
      ? "write-literal"
      : "write-expression";
  }
  if (Node.isShorthandPropertyAssignment(parent) && parent.getNameNode() === node) {
    return "write-expression";
  }
  if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === node) {
    return "read-access";
  }
  if (Node.isBindingElement(parent)) return "destructure";
  if (Node.isPropertySignature(parent) || Node.isTypeReference(parent))
    return "type-reference";
  return "unknown";
}

export function manualFrom(node: Node, changeId: string, reason: string): ManualSite {
  const source = node.getSourceFile();
  const { line, column } = source.getLineAndColumnAtPos(node.getStart());
  return {
    file: source.getFilePath(),
    line,
    column,
    changeId,
    reason,
    snippet: (node.getParent() ?? node).getText().slice(0, 120),
    offset: node.getStart(),
    end: node.getEnd(),
  };
}

function segmentsOf(pointer: string): string[] {
  return pointer.split("/").filter((segment) => segment !== "");
}

function nestedWrite(path: readonly string[], value: string): string {
  const [head, ...rest] = path;
  if (head === undefined) return value;
  return rest.length === 0
    ? `${head}: ${value}`
    : `${head}: { ${nestedWrite(rest, value)} }`;
}

function useHelper(result: EngineResult, file: string, helper: string): void {
  const set = result.helpersUsed.get(file) ?? new Set<string>();
  set.add(helper);
  result.helpersUsed.set(file, set);
}

/**
 * What a group of ops does to one value, resolved before any source is touched.
 *
 * `path` is where the value now lives, `wrapRead` converts it on the way out
 * and `convertWrite` converts it on the way in. Ops apply in the order the
 * provider declared them, which is why a rename is already reflected in the
 * path a later conversion targets.
 */
interface Composed {
  path: string[];
  wrapRead: string | undefined;
  convertWrite: ((value: string, literal: boolean) => string | undefined) | undefined;
  changeIds: Set<string>;
  reasons: string[];
  unsupported: string | undefined;
}

/** What a re-encoding does to a value, in a reviewer's words. */
export function recoding(codec: Codec): string {
  switch (codec.kind) {
    case "scale10":
      return `the value times 10^${codec.exponent}`;
    case "enumMap":
      return "a renamed value";
    case "cast":
      return `${codec.to === "integer" ? "an" : "a"} ${codec.to} instead of ${codec.from === "integer" ? "an" : "a"} ${codec.from}`;
    case "dateFormat":
      return `${codec.to} instead of ${codec.from}`;
    case "stringCase":
      return `${codec.to} case instead of ${codec.from} case`;
    case "wrapArray":
      return "a list of one instead of the value";
    case "unwrapSingle":
      return "the one item instead of a list";
  }
}

function compose(
  targets: readonly TargetSymbol[],
  helpers: { toMinor: string; fromMinor: string } | undefined,
): Composed {
  const first = targets[0] as TargetSymbol;
  const composed: Composed = {
    path: [first.property],
    wrapRead: undefined,
    convertWrite: undefined,
    changeIds: new Set(),
    reasons: [],
    unsupported: undefined,
  };

  for (const target of targets) {
    const op: DataOp = target.op;
    composed.changeIds.add(target.changeId);

    if (op.op === "move") {
      composed.path = segmentsOf(op.to);
      composed.reasons.push(`renamed ${op.from} to ${op.to}`);
      continue;
    }
    if (op.op === "convert" && op.codec.kind === "scale10") {
      const exponent = op.codec.exponent;
      if (!helpers) {
        composed.unsupported = "the SDK exports no exact conversion helpers";
        continue;
      }
      composed.wrapRead = exponent > 0 ? helpers.fromMinor : helpers.toMinor;
      composed.convertWrite = (value, literal) => {
        if (literal) {
          const exact = exactMinorUnits(value, exponent);
          if (exact !== undefined) return exact;
        }
        return `${exponent > 0 ? helpers.toMinor : helpers.fromMinor}(${value})`;
      };
      composed.reasons.push("converted the amount to the unit the contract now uses");
      continue;
    }
    // Enum values are edited at the literal. Every other re-encoding changes
    // what a value is, not only where it lives, and moving the field without
    // converting it would compile against a loose type and be wrong.
    if (op.op === "convert" && op.codec.kind === "enumMap") continue;
    if (op.op === "convert") {
      composed.unsupported = `${op.path} is now written as ${recoding(op.codec)}, which this engine does not rewrite yet`;
      continue;
    }
    if (op.op === "remove") {
      composed.unsupported = `\`${segmentsOf(op.path).join(".")}\` is no longer in the contract, and nothing was declared in its place`;
    }
    if (op.op === "add") continue;
  }

  return composed;
}

function editFrom(
  node: Node,
  start: number,
  end: number,
  replacement: Replacement,
  composed: Composed,
): Edit {
  return {
    file: node.getSourceFile().getFilePath(),
    start,
    end,
    replacement,
    changeId: [...composed.changeIds][0] ?? "",
    author: "codemod",
    reason: composed.reasons.join("; "),
  };
}

function applyComposed(
  node: Node,
  role: Role,
  composed: Composed,
  result: EngineResult,
): void {
  const changeId = [...composed.changeIds][0] ?? "";
  if (composed.unsupported) {
    result.manual.push(manualFrom(node, changeId, composed.unsupported));
    return;
  }

  const parent = node.getParent();
  const file = node.getSourceFile().getFilePath();

  switch (role) {
    case "write-literal":
    case "write-expression": {
      const shorthand = Node.isShorthandPropertyAssignment(parent);
      if (!Node.isPropertyAssignment(parent) && !shorthand) {
        result.manual.push(manualFrom(node, changeId, "unrecognised write position"));
        return;
      }
      const assignment = parent as Node;
      const literal = role === "write-literal";

      if (composed.convertWrite) {
        // The helper is needed unless the value turns out to be a literal this
        // resolves exactly, which the transform below decides. Importing one
        // that goes unused is caught by the type check, not shipped.
        const sample = composed.convertWrite("x", false) ?? "";
        const open = sample.indexOf("(");
        if (open > 0) useHelper(result, file, sample.slice(0, open));
      }

      result.edits.push(
        editFrom(
          node,
          assignment.getStart(),
          assignment.getEnd(),
          (current: string) => {
            // `current` is the assignment as it stands after any inner edit, so a
            // value that was itself migrated is already in its new form.
            const separator = current.indexOf(":");
            const value =
              shorthand || separator === -1
                ? current
                : current.slice(separator + 1).trim();
            if (!composed.convertWrite) return nestedWrite(composed.path, value);

            // Both sides of this assignment moved to the same unit, so converting
            // again would only undo what the inner edit already did.
            const unwrapped = composed.wrapRead
              ? new RegExp(`^${composed.wrapRead}\\((.*)\\)$`, "s").exec(value)
              : null;
            if (unwrapped) return nestedWrite(composed.path, unwrapped[1] as string);

            const converted = composed.convertWrite(value, literal);
            return nestedWrite(composed.path, converted ?? value);
          },
          composed,
        ),
      );
      return;
    }

    case "read-access": {
      if (!Node.isPropertyAccessExpression(parent)) {
        result.manual.push(manualFrom(node, changeId, "unrecognised read position"));
        return;
      }
      const object = parent.getExpression().getText();
      const optional = parent.hasQuestionDotToken();

      // An optional read yields a value or nothing, and a conversion helper
      // takes a value. Wrapping it would either drop the `?.` and turn a safe
      // read into one that throws, or pass `undefined` into arithmetic. Both
      // are worse than saying so: the shapes of the two expressions genuinely
      // differ, and which of them the caller wants is not derivable from the
      // Change.
      if (optional && composed.wrapRead) {
        result.manual.push(
          manualFrom(
            node,
            changeId,
            `this reads ${node.getText()} through an optional chain, and the value ` +
              "now needs converting. Decide what the result should be when there " +
              "is nothing there, then convert it.",
          ),
        );
        return;
      }

      let text = `${object}${optional ? "?." : "."}${composed.path.join(".")}`;
      if (composed.wrapRead) {
        useHelper(result, file, composed.wrapRead);
        text = `${composed.wrapRead}(${text})`;
      }
      result.edits.push(
        editFrom(node, parent.getStart(), parent.getEnd(), text, composed),
      );
      return;
    }

    case "destructure": {
      if (!Node.isBindingElement(parent)) {
        result.manual.push(manualFrom(node, changeId, "unrecognised binding"));
        return;
      }
      if (composed.path.length > 1) {
        result.manual.push(
          manualFrom(
            node,
            changeId,
            `the value is now nested at ${composed.path.join(".")}`,
          ),
        );
        return;
      }
      const head = composed.path[0] as string;
      const local = parent.getNameNode().getText();

      if (!composed.wrapRead) {
        result.edits.push(
          editFrom(
            node,
            parent.getStart(),
            parent.getEnd(),
            local === head ? head : `${head}: ${local}`,
            composed,
          ),
        );
        return;
      }

      // Renaming the binding alone would leave the local holding one unit while
      // every use of it still means the other. Binding the new name and
      // converting once keeps the local's meaning exactly as it was.
      const declaration = parent.getParent()?.getParent();
      const statement = Node.isVariableDeclaration(declaration)
        ? declaration.getFirstAncestorByKind(SyntaxKind.VariableStatement)
        : undefined;
      if (!statement) {
        result.manual.push(
          manualFrom(
            node,
            changeId,
            "cannot convert a destructured amount outside a declaration",
          ),
        );
        return;
      }

      useHelper(result, file, composed.wrapRead);
      const indent = " ".repeat(statement.getStart() - statement.getStartLinePos());
      result.edits.push(
        editFrom(node, parent.getStart(), parent.getEnd(), head, composed),
      );
      result.edits.push(
        editFrom(
          node,
          statement.getEnd(),
          statement.getEnd(),
          `\n${indent}const ${local} = ${composed.wrapRead}(${head});`,
          composed,
        ),
      );
      return;
    }

    default:
      result.manual.push(manualFrom(node, changeId, `cannot rewrite a ${role}`));
  }
}

/** String literals compared against, or assigned to, a value whose vocabulary changed. */
function applyEnum(
  node: Node,
  role: Role,
  map: Record<string, string>,
  changeId: string,
  result: EngineResult,
): void {
  const replace = (literal: Node | undefined): boolean => {
    if (!literal || !Node.isStringLiteral(literal)) return false;
    const mapped = map[literal.getLiteralValue()];
    if (mapped === undefined) return false;
    result.edits.push({
      file: literal.getSourceFile().getFilePath(),
      start: literal.getStart(),
      end: literal.getEnd(),
      replacement: JSON.stringify(mapped),
      changeId,
      author: "codemod",
      reason: "updated a value to the vocabulary the contract now uses",
    });
    return true;
  };

  const otherSideOf = (expression: Node, self: Node): Node | undefined => {
    if (!Node.isBinaryExpression(expression)) return undefined;
    return expression.getLeft() === self ? expression.getRight() : expression.getLeft();
  };

  if (role === "read-access") {
    const access = node.getParent();
    if (!access) return;
    if (replace(otherSideOf(access.getParent() as Node, access))) return;

    // `expect(payment.object).toBe("charge")` compares just as much as `===`
    // does, it simply routes the comparison through a call. When the property
    // is the argument to one call and that call is the receiver of another,
    // the second call's string arguments are being compared against it.
    const inner = access.getParent();
    if (!Node.isCallExpression(inner) || !inner.getArguments().includes(access)) return;
    let outer: Node | undefined = inner.getParent();
    for (let hops = 0; hops < 3 && outer; hops += 1) {
      if (Node.isCallExpression(outer)) {
        for (const argument of outer.getArguments()) replace(argument);
        return;
      }
      if (!Node.isPropertyAccessExpression(outer)) return;
      outer = outer.getParent();
    }
  }

  if (role === "write-literal" || role === "write-expression") {
    const parent = node.getParent();
    if (Node.isPropertyAssignment(parent)) replace(parent.getInitializer());
    return;
  }

  if (role === "destructure") {
    // Follow the local binding to wherever it is compared.
    const parent = node.getParent();
    if (!Node.isBindingElement(parent)) return;
    const name = parent.getNameNode();
    if (!Node.isIdentifier(name)) return;
    for (const reference of name.findReferencesAsNodes()) {
      replace(otherSideOf(reference.getParent() as Node, reference));
    }
  }
}

/**
 * String literals sitting where the contract's own vocabulary is expected.
 *
 * `expect(payment.object).toBe("charge")` passes the value to a function rather
 * than comparing it, so there is no comparison to find. What there is instead
 * is a contextual type: the position expects exactly the values the old
 * contract defined. Rewriting on that is type-directed, not a guess about what
 * a string happens to say.
 *
 * A value that appears somewhere with no such type, inside an assembled string
 * for instance, is reported rather than rewritten. Guessing at the meaning of
 * arbitrary text is how a migration quietly breaks something.
 */
function applyContextualEnums(
  project: Project,
  map: Record<string, string>,
  changeId: string,
  scope: EditScope,
  result: EngineResult,
): void {
  const olds = new Set(Object.keys(map));
  const edited = new Set<string>();

  for (const source of project.getSourceFiles()) {
    if (!editable(source, scope)) continue;

    for (const literal of source.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
      const value = literal.getLiteralValue();
      const mapped = map[value];
      if (mapped === undefined) continue;

      const contextual = literal.getContextualType();
      const members = contextual?.isUnion()
        ? contextual.getUnionTypes()
        : contextual
          ? [contextual]
          : [];
      const expectsContractValues =
        members.length > 0 &&
        members.every((member) => {
          const literalValue = member.getLiteralValue();
          return typeof literalValue === "string" && olds.has(literalValue);
        });
      if (!expectsContractValues) continue;

      const key = `${source.getFilePath()}:${literal.getStart()}`;
      if (edited.has(key)) continue;
      edited.add(key);

      result.edits.push({
        file: source.getFilePath(),
        start: literal.getStart(),
        end: literal.getEnd(),
        replacement: JSON.stringify(mapped),
        changeId,
        author: "codemod",
        reason: "updated a value to the vocabulary the contract now uses",
      });
    }

    // Anything left in assembled text is flagged for a person to look at.
    // Only the literal chunks of a template are considered: the interpolated
    // expressions are code, and everything above has already migrated those.
    for (const template of source.getDescendantsOfKind(SyntaxKind.TemplateExpression)) {
      const chunks = [
        template.getHead().getLiteralText(),
        ...template.getTemplateSpans().map((span) => span.getLiteral().getLiteralText()),
      ].join("\u0000");

      const stale = [...olds].find((old) => new RegExp(`\\b${old}\\b`).test(chunks));
      if (stale === undefined) continue;
      const { line, column } = source.getLineAndColumnAtPos(template.getStart());
      result.manual.push({
        file: source.getFilePath(),
        line,
        column,
        changeId,
        reason: `this text still contains "${stale}", which the contract now calls "${map[stale] ?? ""}"`,
        offset: template.getStart(),
        snippet: template.getText().slice(0, 120),
      });
    }
  }
}

/**
 * Whether a file is one this migration is allowed to change.
 *
 * The type checker loads the whole import graph, which reaches the SDK and, in
 * a workspace, whatever else the repository depends on. Only files inside the
 * repository being migrated may be edited: a migration that reaches into a
 * dependency is not a migration, it is damage.
 */
export interface EditScope {
  /** The repository being migrated. Nothing outside it is ever written. */
  repoDir: string;
  /**
   * Files and directories that describe the contract but are not the
   * consumer's own code: a generated SDK, or a generated types file.
   *
   * Two separate things used to share one name here, and consumer B is where
   * that broke. A hand-written SDK lives outside the repository, so "where the
   * declarations are" and "what must not be edited" happened to coincide.
   * Generated types live inside it, usually in the same directory as the code
   * that imports them, so treating the whole directory as off limits excluded
   * every edit and the migration silently did nothing.
   *
   * Declarations are read from these paths. They are never written, because
   * they are regenerated from the new contract instead.
   */
  generated: readonly string[];
}

function isGenerated(path: string, scope: EditScope): boolean {
  return scope.generated.some((entry) => path.startsWith(entry));
}

export function editable(node: Node, scope: EditScope): boolean {
  const path = node.getSourceFile().getFilePath();
  return path.startsWith(scope.repoDir) && !isGenerated(path, scope);
}

/**
 * Finds the declaration that describes a schema, wherever the generator put it.
 *
 * A hand-written SDK exports `interface Payment`. `openapi-typescript` instead
 * emits one `interface components` with everything nested under
 * `schemas.Payment`, so the same schema is reachable only by walking a path.
 * Supporting both is the point: an indexer that only understands one generator
 * shape is an indexer that works for one customer.
 *
 * A dotted name in the symbol map is that path. A bare one is a top-level
 * declaration, which is what every existing map already contains.
 */
export function membersOf(
  project: Project,
  path: string,
  scope: EditScope,
): TypeElementTypes[] | undefined {
  const [head, ...rest] = path.split(".");
  if (head === undefined) return undefined;

  // A name qualified by the namespaces it is declared in, as stripe-node's
  // `Stripe.StripeConfig` inside `declare module "stripe"`, before a path
  // through members.
  if (rest.length > 0) {
    for (const source of project.getSourceFiles()) {
      if (!isGenerated(source.getFilePath(), scope)) continue;
      for (const declaration of source.getDescendantsOfKind(
        SyntaxKind.InterfaceDeclaration,
      )) {
        if (qualifiedName(declaration) === path) return declaration.getMembers();
      }
    }
  }

  for (const source of project.getSourceFiles()) {
    if (!isGenerated(source.getFilePath(), scope)) continue;

    const root = source.getInterface(head) ?? source.getTypeAlias(head);
    if (!root) continue;

    let members: TypeElementTypes[] = Node.isInterfaceDeclaration(root)
      ? root.getMembers()
      : literalMembers(root.getTypeNode());

    for (const segment of rest) {
      const property = members.find(
        (member) => Node.isPropertySignature(member) && member.getName() === segment,
      );
      if (!property || !Node.isPropertySignature(property)) return undefined;
      members = literalMembers(property.getTypeNode());
    }
    return members;
  }
  return undefined;
}

/**
 * A declaration's name with the namespaces around it, leaving out an ambient
 * module's quoted name, which is the package and not part of the type's name.
 */
export function qualifiedName(
  declaration: Node & { getName(): string | undefined },
): string {
  const names = [declaration.getName() ?? ""];
  for (const ancestor of declaration.getAncestors()) {
    if (!Node.isModuleDeclaration(ancestor)) continue;
    const name = ancestor.getName();
    if (/^["']/.test(name)) continue;
    names.unshift(name);
  }
  return names.join(".");
}

/**
 * The members of the object at `within` inside a type: each step is a
 * property, its type taken from the checker with null left out, and `*` a
 * list's items. Undefined where any step is not one object type.
 */
export function nestedMembers(
  project: Project,
  typeName: string,
  within: readonly string[],
  scope: EditScope,
): TypeElementTypes[] | undefined {
  let members = membersOf(project, typeName, scope);
  let type: Type | undefined;
  for (const segment of within) {
    if (segment === "*") {
      const items = type?.getArrayElementType();
      if (!items) return undefined;
      type = items.getNonNullableType();
    } else {
      const property = propertyOf(members, segment);
      if (!property) return undefined;
      type = property.getType().getNonNullableType();
    }
    // A list's own members are the array's; the next step, `*`, reads its items.
    const declaration = type.getSymbol()?.getDeclarations()[0];
    members =
      Node.isInterfaceDeclaration(declaration) || Node.isTypeLiteral(declaration)
        ? declaration.getMembers()
        : undefined;
  }
  return members;
}

function literalMembers(node: Node | undefined): TypeElementTypes[] {
  return node && Node.isTypeLiteral(node) ? node.getMembers() : [];
}

function propertyOf(
  members: readonly TypeElementTypes[] | undefined,
  name: string,
): PropertySignature | undefined {
  const found = members?.find(
    (member) => Node.isPropertySignature(member) && member.getName() === name,
  );
  return found && Node.isPropertySignature(found) ? found : undefined;
}

/**
 * An op that means every caller now has to send the field: a new required
 * one, or an existing one that stopped being optional.
 */
function suppliesField(op: DataOp): op is AddOp | DefaultOp {
  return (
    op.op === "add" || (op.op === "default" && op.toward === "new" && op.when !== "null")
  );
}

export function runEngine(
  project: Project,
  plan: MigrationPlan,
  scope: EditScope,
): EngineResult {
  const result: EngineResult = { edits: [], manual: [], helpersUsed: new Map() };

  const membersFor = (target: TargetSymbol) =>
    target.within
      ? nestedMembers(project, target.typeName, target.within, scope)
      : membersOf(project, target.typeName, scope);
  const propertyIn = (target: TargetSymbol) =>
    propertyOf(membersFor(target), target.property);

  // One group per field, so every op that touches it composes into one edit.
  const groups = new Map<string, TargetSymbol[]>();
  for (const target of plan.targets) {
    // Neither edits an existing reference: a field that must now be sent is
    // written into the literals below, and one that may now be missing or
    // null is left to the type checker, which knows every place it is read.
    if (["add", "default", "dropNull"].includes(target.op.op)) continue;
    const key = [target.typeName, ...(target.within ?? []), target.property].join(".");
    groups.set(key, [...(groups.get(key) ?? []), target]);
  }

  for (const targets of groups.values()) {
    const first = targets[0] as TargetSymbol;
    const declaration = propertyIn(first);
    if (!declaration) continue;

    const composed = compose(targets, plan.symbols.helpers);
    const enums = targets.filter(
      (target) => target.op.op === "convert" && target.op.codec.kind === "enumMap",
    );
    for (const target of enums) {
      if (target.op.op !== "convert" || target.op.codec.kind !== "enumMap") continue;
      applyContextualEnums(
        project,
        Object.fromEntries(target.op.codec.pairs),
        target.changeId,
        scope,
        result,
      );
    }

    for (const node of declaration.findReferencesAsNodes()) {
      if (!editable(node, scope)) continue;
      const role = roleOf(node);
      if (role === "type-reference") continue;

      for (const target of enums) {
        if (target.op.op !== "convert" || target.op.codec.kind !== "enumMap") continue;
        applyEnum(
          node,
          role,
          Object.fromEntries(target.op.codec.pairs),
          target.changeId,
          result,
        );
      }

      // A field whose only change was its vocabulary keeps its name and place.
      // A removed one keeps them too, and is exactly what a person must see.
      if (
        composed.path.length === 1 &&
        composed.path[0] === first.property &&
        !composed.wrapRead &&
        !composed.unsupported
      ) {
        continue;
      }
      applyComposed(node, role, composed, result);
    }
  }

  // A newly required field has no existing reference to anchor to, so the
  // object literals that write the type are found through its other properties.
  for (const target of plan.targets) {
    if (!suppliesField(target.op)) continue;
    // The field itself, inside whatever object `within` leads to.
    const head = target.property;

    {
      const members = membersFor(target);
      if (!members) continue;

      const literals = new Set<Node>();
      for (const property of members) {
        if (!Node.isPropertySignature(property)) continue;
        for (const reference of property.findReferencesAsNodes()) {
          if (!editable(reference, scope)) continue;
          const parent = reference.getParent();
          const literal = parent?.getParent();
          if (
            parent &&
            (Node.isPropertyAssignment(parent) ||
              Node.isShorthandPropertyAssignment(parent)) &&
            Node.isObjectLiteralExpression(literal)
          ) {
            literals.add(literal);
          }
        }
      }

      for (const literal of literals) {
        if (!Node.isObjectLiteralExpression(literal)) continue;
        const already = literal
          .getProperties()
          .some(
            (property) =>
              Node.isPropertyAssignment(property) && property.getName() === head,
          );
        if (already) continue;

        // A draft writes null where no value is ever sent: the field exists
        // only in responses. A literal of that type is then the consumer's own
        // stand-in for a response, such as a test fixture, and what it should
        // hold is theirs to say; null would be a guess, and for a list a
        // wrong one.
        if (target.op.value === null) {
          result.manual.push(
            manualFrom(
              literal,
              target.changeId,
              `this object stands for a response that now has \`${head}\`; add the value it should hold`,
            ),
          );
          continue;
        }
        const anchor = literal.getProperties()[0];
        const brace = literal.getFirstChildByKind(SyntaxKind.OpenBraceToken);
        if (!anchor || !brace) continue;

        // Insert just after the opening brace rather than before the first
        // property. A zero-width edit at a property's own start would sit
        // inside that property's span, and the rewrite of that property would
        // then swallow it.
        const multiline = anchor.getStartLineNumber() !== literal.getStartLineNumber();
        const indent = " ".repeat(anchor.getStart() - anchor.getStartLinePos());
        result.edits.push({
          file: literal.getSourceFile().getFilePath(),
          start: brace.getEnd(),
          end: brace.getEnd(),
          replacement: multiline
            ? `\n${indent}${head}: ${JSON.stringify(target.op.value)},`
            : ` ${head}: ${JSON.stringify(target.op.value)},`,
          changeId: target.changeId,
          author: "codemod",
          reason: "supplied the default this field always had before it became explicit",
        });
      }
    }
  }

  return result;
}
