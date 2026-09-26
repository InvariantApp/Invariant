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
import type { AddOp, DataOp, DefaultOp } from "@invariant-app/ir";
import {
  type Edit,
  exactMinorUnits,
  type ManualSite,
  type MigrationPlan,
  type Replacement,
  type Role,
  recoding,
  type TargetSymbol,
} from "@invariant-app/migrate-core";
import {
  type InterfaceDeclaration,
  Node,
  type ObjectLiteralExpression,
  type Project,
  type PropertySignature,
  type StringLiteral,
  SyntaxKind,
  type Symbol as TsSymbol,
  type Type,
  type TypeElementTypes,
} from "ts-morph";
import { within } from "./paths.ts";

export type { ManualSite };

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

export { recoding };

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

    default: {
      // `customer["nickname"]`: the checker resolved the key to the field,
      // so a field renamed in place is renamed inside the string.
      const key =
        Node.isStringLiteral(node) &&
        Node.isElementAccessExpression(parent) &&
        parent.getArgumentExpression() === node;
      const head = composed.path[0] as string;
      if (
        key &&
        composed.path.length === 1 &&
        !composed.wrapRead &&
        !composed.convertWrite
      ) {
        const quote = node.getText()[0] ?? '"';
        result.edits.push(
          editFrom(
            node,
            node.getStart(),
            node.getEnd(),
            quote === "'" && !head.includes("'") ? `'${head}'` : JSON.stringify(head),
            composed,
          ),
        );
        return;
      }
      result.manual.push(
        manualFrom(
          node,
          changeId,
          key
            ? `this reads the field by a string key: ${composed.reasons.join("; ")}`
            : `cannot rewrite a ${role}`,
        ),
      );
    }
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

    // `String(customer.status) === "active"` compares the field as text.
    const text = access.getParent();
    if (
      Node.isCallExpression(text) &&
      isGlobalString(text.getExpression()) &&
      text.getArguments().length === 1 &&
      text.getArguments()[0] === access &&
      isEquality(text.getParent() as Node) &&
      replace(otherSideOf(text.getParent() as Node, text))
    )
      return;

    // `switch (customer.status)` compares the field with each case's value.
    const holder = access.getParent();
    if (Node.isSwitchStatement(holder) && holder.getExpression() === access) {
      for (const clause of holder.getClauses()) {
        if (Node.isCaseClause(clause)) replace(clause.getExpression());
      }
      return;
    }
    // `["active", "past_due"].includes(customer.status)` compares it with
    // each item of the list, as `indexOf` does.
    if (Node.isCallExpression(holder) && holder.getArguments()[0] === access) {
      const callee = holder.getExpression();
      const list = Node.isPropertyAccessExpression(callee)
        ? callee.getExpression()
        : undefined;
      if (
        Node.isPropertyAccessExpression(callee) &&
        ["includes", "indexOf"].includes(callee.getName()) &&
        Node.isArrayLiteralExpression(list)
      ) {
        for (const item of list.getElements()) replace(item);
        return;
      }
    }

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
  /** The field whose values the Change renamed. */
  covered: Node,
  /** Sites to show unless the value is rewritten after all (`runEngine`). */
  unsure: ManualSite[],
  /**
   * The alias the SDK declares the field's values as, `CustomerStatus`: a
   * literal whose position expects exactly that type expects the field's
   * values, whatever else the union holds.
   */
  vocabulary?: TsSymbol,
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
        (members.length > 0 &&
          members.every((member) => {
            const literalValue = member.getLiteralValue();
            return typeof literalValue === "string" && olds.has(literalValue);
          })) ||
        (vocabulary !== undefined && comparedWithVocabulary(literal, vocabulary));
      if (!expectsContractValues) continue;

      // The type says the literal is one of a vocabulary's values; which
      // field's, only the fields it meets can say. An SDK often gives a
      // response's field and a request's the same type, and a Change scoped
      // to one leaves the other's values as they were.
      const met = fieldsMet(literal);
      const mine = met.fields.filter((field) => field === covered);
      if (!met.unknown && met.fields.length > 0 && mine.length === 0) continue;
      if (met.unknown || mine.length !== met.fields.length) {
        unsure.push(
          manualFrom(
            literal,
            changeId,
            `"${value}" is one of the values the contract now calls "${mapped}" on this field, and ${
              met.unknown
                ? "where it comes from or goes cannot be followed to that field"
                : "it also meets fields whose values did not change"
            }; check which it is`,
          ),
        );
        continue;
      }

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

/** The SDK fields a value meets, and whether it meets something that cannot be followed. */
interface Met {
  fields: Node[];
  unknown: boolean;
}

const UNKNOWN: Met = { fields: [], unknown: true };

/** How deep a value is followed through the consumer's own functions. */
const MOST_STEPS = 4;

/**
 * The SDK fields a literal is compared with or given as: the property of the
 * request it is written into, the field it is compared with by `===`,
 * switched on or looked for in a list, followed back through the
 * consumer's own variables and functions.
 */
function fieldsMet(literal: Node): Met {
  let node = literal;
  let parent = node.getParent();
  while (
    Node.isParenthesizedExpression(parent) ||
    Node.isAsExpression(parent) ||
    Node.isSatisfiesExpression(parent)
  ) {
    node = parent;
    parent = node.getParent();
  }
  if (Node.isPropertyAssignment(parent) && parent.getInitializer() === node) {
    const holder = parent.getParent();
    const property = Node.isObjectLiteralExpression(holder)
      ? holder.getContextualType()?.getProperty(parent.getName())
      : undefined;
    return declaredFields(property?.getDeclarations() ?? []);
  }
  if (Node.isBinaryExpression(parent) && isEquality(parent)) {
    return valueFields(
      parent.getLeft() === node ? parent.getRight() : parent.getLeft(),
      0,
    );
  }
  if (Node.isCaseClause(parent) && parent.getExpression() === node) {
    const switched = parent.getParent()?.getParent();
    return Node.isSwitchStatement(switched)
      ? valueFields(switched.getExpression(), 0)
      : UNKNOWN;
  }
  if (Node.isArrayLiteralExpression(parent)) {
    const callee = parent.getParent();
    const call = callee?.getParent();
    const sought = Node.isCallExpression(call) ? call.getArguments()[0] : undefined;
    return Node.isPropertyAccessExpression(callee) &&
      callee.getExpression() === parent &&
      ["includes", "indexOf"].includes(callee.getName()) &&
      sought
      ? valueFields(sought, 0)
      : UNKNOWN;
  }
  return UNKNOWN;
}

function isEquality(expression: Node): boolean {
  if (!Node.isBinaryExpression(expression)) return false;
  return [
    SyntaxKind.EqualsEqualsEqualsToken,
    SyntaxKind.ExclamationEqualsEqualsToken,
    SyntaxKind.EqualsEqualsToken,
    SyntaxKind.ExclamationEqualsToken,
  ].includes(expression.getOperatorToken().getKind());
}

/** Declarations that are all properties of a type: fields, or nothing known. */
function declaredFields(declarations: readonly Node[]): Met {
  return declarations.length > 0 &&
    declarations.every(
      (each) => Node.isPropertySignature(each) || Node.isPropertyDeclaration(each),
    )
    ? { fields: [...declarations], unknown: false }
    : UNKNOWN;
}

/** Whether an identifier is the global `String`, as the language's own library declares it. */
function isGlobalString(node: Node): boolean {
  if (!Node.isIdentifier(node) || node.getText() !== "String") return false;
  const declarations = node.getSymbol()?.getDeclarations() ?? [];
  return (
    declarations.length > 0 &&
    declarations.every((each) =>
      /[\\/]typescript[\\/]lib[\\/]lib\.[^\\/]*\.d\.ts$/.test(
        each.getSourceFile().getFilePath(),
      ),
    )
  );
}

/** The SDK fields a value comes from. */
function valueFields(value: Node, steps: number): Met {
  if (steps > MOST_STEPS) return UNKNOWN;
  let node = value;
  while (true) {
    if (
      Node.isParenthesizedExpression(node) ||
      Node.isAsExpression(node) ||
      Node.isNonNullExpression(node) ||
      Node.isSatisfiesExpression(node)
    ) {
      node = node.getExpression();
      continue;
    }
    // `String(customer.status)` is the same value as text.
    if (
      Node.isCallExpression(node) &&
      isGlobalString(node.getExpression()) &&
      node.getArguments().length === 1
    ) {
      node = node.getArguments()[0] as Node;
      continue;
    }
    break;
  }
  if (Node.isPropertyAccessExpression(node)) {
    return declaredFields(node.getNameNode().getSymbol()?.getDeclarations() ?? []);
  }
  if (Node.isElementAccessExpression(node)) {
    return declaredFields(
      node.getArgumentExpression()?.getSymbol()?.getDeclarations() ?? [],
    );
  }
  if (!Node.isIdentifier(node)) return UNKNOWN;
  const declaration = node.getSymbol()?.getDeclarations()[0];
  if (Node.isVariableDeclaration(declaration)) {
    const initializer = declaration.getInitializer();
    const constant =
      declaration.getVariableStatement()?.getDeclarationList().getDeclarationKind() ===
      "const";
    return constant && initializer && Node.isIdentifier(declaration.getNameNode())
      ? valueFields(initializer, steps + 1)
      : UNKNOWN;
  }
  if (Node.isBindingElement(declaration)) {
    // `const { status } = customer` reads the field `status` of what it
    // destructures.
    const pattern = declaration.getParent();
    const holder = pattern?.getParent();
    const name = (
      declaration.getPropertyNameNode() ?? declaration.getNameNode()
    ).getText();
    const type =
      Node.isVariableDeclaration(holder) && Node.isObjectBindingPattern(pattern)
        ? holder.getType()
        : undefined;
    return declaredFields(type?.getProperty(name)?.getDeclarations() ?? []);
  }
  if (!Node.isParameterDeclaration(declaration)) return UNKNOWN;
  const fn = declaration.getParent();
  if (!Node.isFunctionDeclaration(fn)) return UNKNOWN;
  const name = fn.getNameNode();
  const own = declaration.getNameNode();
  if (!name || !Node.isIdentifier(own) || declaration.isRestParameter()) return UNKNOWN;
  const assigned = own.findReferencesAsNodes().some((reference) => {
    const holder = reference.getParent();
    return (
      Node.isBinaryExpression(holder) &&
      holder.getLeft() === reference &&
      holder.getOperatorToken().getKind() === SyntaxKind.EqualsToken
    );
  });
  if (assigned) return UNKNOWN;
  const index = fn.getParameters().indexOf(declaration);
  const calls = name.findReferencesAsNodes().filter((reference) => reference !== name);
  if (calls.length === 0) return UNKNOWN;
  const fields: Node[] = [];
  for (const reference of calls) {
    const call = reference.getParent();
    const argument =
      Node.isCallExpression(call) && call.getExpression() === reference
        ? call.getArguments()[index]
        : undefined;
    if (!argument) return UNKNOWN;
    const met = valueFields(argument, steps + 1);
    if (met.unknown) return UNKNOWN;
    fields.push(...met.fields);
  }
  return { fields, unknown: false };
}

/**
 * Whether a literal sits where the SDK's vocabulary type for a field is what
 * it is compared with or given as: its position expects that type, or it is
 * compared by `===` with a value of it, is a case of a `switch` over one, or
 * is an item of a list a value of it is looked for in. A value of that type
 * is one of the field's values wherever the consumer carries it, into a
 * helper of its own that takes a `CustomerStatus` as much as beside the
 * field itself.
 */
function comparedWithVocabulary(literal: StringLiteral, vocabulary: TsSymbol): boolean {
  const isVocabulary = (node: Node | undefined) =>
    node !== undefined &&
    node.getType().getAliasSymbol()?.compilerSymbol === vocabulary.compilerSymbol;
  if (
    literal.getContextualType()?.getAliasSymbol()?.compilerSymbol ===
    vocabulary.compilerSymbol
  )
    return true;
  const parent = literal.getParent();
  if (Node.isBinaryExpression(parent)) {
    const operator = parent.getOperatorToken().getKind();
    if (
      ![
        SyntaxKind.EqualsEqualsEqualsToken,
        SyntaxKind.ExclamationEqualsEqualsToken,
        SyntaxKind.EqualsEqualsToken,
        SyntaxKind.ExclamationEqualsToken,
      ].includes(operator)
    )
      return false;
    return isVocabulary(
      parent.getLeft() === literal ? parent.getRight() : parent.getLeft(),
    );
  }
  if (Node.isCaseClause(parent) && parent.getExpression() === literal) {
    const switched = parent.getParent()?.getParent();
    return Node.isSwitchStatement(switched) && isVocabulary(switched.getExpression());
  }
  if (Node.isArrayLiteralExpression(parent)) {
    const callee = parent.getParent();
    const call = callee?.getParent();
    return (
      Node.isPropertyAccessExpression(callee) &&
      callee.getExpression() === parent &&
      ["includes", "indexOf"].includes(callee.getName()) &&
      Node.isCallExpression(call) &&
      isVocabulary(call.getArguments()[0])
    );
  }
  return false;
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
  // Inside the repository by path, not by prefix: `/work/repo` is not a
  // prefix of anything in `/work/repo-other`.
  return within(scope.repoDir, path) && !isGenerated(path, scope);
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
 * The interface a symbol map names, where the name is one: top level, or
 * qualified by the namespaces it is declared in.
 */
function interfaceNamed(
  project: Project,
  path: string,
  scope: EditScope,
): InterfaceDeclaration | undefined {
  for (const source of project.getSourceFiles()) {
    if (!isGenerated(source.getFilePath(), scope)) continue;
    if (!path.includes(".")) {
      const found = source.getInterface(path);
      if (found) return found;
      continue;
    }
    for (const declaration of source.getDescendantsOfKind(
      SyntaxKind.InterfaceDeclaration,
    )) {
      if (qualifiedName(declaration) === path) return declaration;
    }
  }
  return undefined;
}

/**
 * Whether a reference to a field is certainly on a value of `type`: the
 * object read from, the literal written, or the value destructured is of
 * that type or one assignable to it, and not something nothing types.
 */
function readFrom(node: Node, role: Role, type: Type): boolean {
  const parent = node.getParent();
  let holder: Type | undefined;
  if (role === "read-access" && Node.isPropertyAccessExpression(parent)) {
    holder = parent.getExpression().getType();
  } else if (role === "write-literal" || role === "write-expression") {
    const literal = parent?.getParent();
    if (Node.isObjectLiteralExpression(literal)) holder = literal.getContextualType();
  } else if (role === "destructure" && Node.isBindingElement(parent)) {
    holder = parent.getParent()?.getType();
  }
  if (!holder || holder.isAny() || holder.isUnknown()) return false;
  return holder.getNonNullableType().isAssignableTo(type);
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

/** A field by the name it is read and written by where nothing types it. */
interface UntypedField {
  changeId: string;
  reason: string;
  /** References the checker already found, which are not looked at again. */
  typed: Set<string>;
  /**
   * Each declaration of a field by this name that a Change touched, and,
   * where it only moved, where it now is.
   */
  moved: { declaration: Node; path?: string[]; changeId: string; reason: string }[];
}

/**
 * The declaration of `field` on the type a value of `type` is, among those
 * a Change touched, where it is certainly one of them.
 */
function movedOn(
  type: Type | undefined,
  field: string,
  moved: UntypedField["moved"],
): UntypedField["moved"][number] | undefined {
  if (!type || type.isAny() || type.isUnknown()) return undefined;
  const declarations =
    type.getNonNullableType().getProperty(field)?.getDeclarations() ?? [];
  const found = moved.filter((each) => declarations.includes(each.declaration as never));
  return found.length === 1 ? found[0] : undefined;
}

/**
 * Where an object literal nothing types goes, when it is certain: it is a
 * `const`'s value, and every use of the `const` passes it to a call whose
 * parameter is a type the Change touched the field of, as request
 * parameters gathered first and handed to the SDK are. Its key is then the
 * field, by the types of the calls it flows into.
 */
function passedOnlyAs(
  literal: ObjectLiteralExpression,
  field: string,
  moved: UntypedField["moved"],
): UntypedField["moved"][number] | undefined {
  const holder = literal.getParent();
  if (!Node.isVariableDeclaration(holder) || holder.getInitializer() !== literal)
    return undefined;
  const name = holder.getNameNode();
  if (
    holder.getVariableStatement()?.getDeclarationList().getDeclarationKind() !==
      "const" ||
    !Node.isIdentifier(name)
  )
    return undefined;
  const checker = literal.getProject().getTypeChecker();
  const uses = name.findReferencesAsNodes().filter((reference) => reference !== name);
  const into = uses.map((reference) => {
    const call = reference.getParent();
    if (!Node.isCallExpression(call)) return undefined;
    const index = call.getArguments().indexOf(reference);
    const parameter =
      index === -1
        ? undefined
        : checker.getResolvedSignature(call)?.getParameters()[index];
    return parameter && movedOn(parameter.getTypeAtLocation(call), field, moved);
  });
  const first = into[0];
  return first && into.every((each) => each === first) ? first : undefined;
}

/**
 * What every call passes to the untyped parameter a value is, when it is
 * certain: the value is a parameter of a function of the consumer's that
 * nothing assigns to, the function is called by name, and every call passes
 * a value whose type declares the field as one the Change touched.
 */
function passedByEveryCaller(
  value: Node,
  field: string,
  moved: UntypedField["moved"],
): UntypedField["moved"][number] | undefined {
  if (!Node.isIdentifier(value)) return undefined;
  const parameter = value.getSymbol()?.getDeclarations()[0];
  if (!Node.isParameterDeclaration(parameter)) return undefined;
  const fn = parameter.getParent();
  if (!Node.isFunctionDeclaration(fn)) return undefined;
  const name = fn.getNameNode();
  const own = parameter.getNameNode();
  if (!name || !Node.isIdentifier(own)) return undefined;
  const index = fn.getParameters().indexOf(parameter);
  // Reassigned anywhere, it may hold something else where it is read.
  const assigned = own.findReferencesAsNodes().some((reference) => {
    const holder = reference.getParent();
    return (
      Node.isBinaryExpression(holder) &&
      holder.getLeft() === reference &&
      holder.getOperatorToken().getKind() === SyntaxKind.EqualsToken
    );
  });
  if (assigned) return undefined;
  const calls = name.findReferencesAsNodes().filter((reference) => reference !== name);
  const into = calls.map((reference) => {
    const call = reference.getParent();
    if (!Node.isCallExpression(call) || call.getExpression() !== reference)
      return undefined;
    return movedOn(call.getArguments()[index]?.getType(), field, moved);
  });
  const first = into[0];
  return first && into.every((each) => each === first) ? first : undefined;
}

/**
 * Uses of a field's name that nothing types: a key of an object literal with
 * no type to fit, a read, a subscript or a destructuring of a value typed
 * `any`. A test's stand-in for a subscription, `{ current_period_end: 123 }`
 * handed to a mock, is invisible to the checker, and is the ordinary way a
 * consumer's tests hold a response. Its name alone is no evidence it is the
 * field the Change is about, so each is shown to a person, as the Python pack
 * does with a dictionary's keys, unless the value flows certainly to or from
 * the SDK's type: an object every use of which passes it where that type is
 * expected (`passedOnlyAs`), or a parameter every call passes it to
 * (`passedByEveryCaller`). Those are rewritten. A use typed as anything at
 * all is the checker's to decide, and is left to it.
 */
function flagUntyped(
  project: Project,
  fields: ReadonlyMap<string, UntypedField>,
  sdk: string,
  scope: EditScope,
  result: EngineResult,
): void {
  if (fields.size === 0) return;
  const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Only the files that use the SDK: a name alone is weak evidence, and
  // weaker still in a file that never touches the SDK at all, unless the
  // types say the object is handed to it.
  const imports = new RegExp(
    `(?:from|import|require\\()\\s*['"]${literally(sdk)}(?:/[^'"]*)?['"]`,
  );
  const names = new RegExp(
    `\\b(?:${[...fields.keys()].map(literally).join("|")})\\b`,
    "g",
  );
  const untyped = (type: Type | undefined) =>
    type === undefined || type.isAny() || type.isUnknown();
  for (const source of project.getSourceFiles()) {
    if (!editable(source, scope)) continue;
    const text = source.getFullText();
    // A file that does not import the SDK is read only for stand-ins the
    // types say are handed to it (`passedAsSdk`).
    const importsSdk = imports.test(text);
    // Only where a name is written, rather than every node of the file.
    for (const match of text.matchAll(names)) {
      const field = fields.get(match[0]);
      const node = source.getDescendantAtPos(match.index);
      if (
        !field ||
        node === undefined ||
        !(Node.isIdentifier(node) || Node.isStringLiteral(node)) ||
        node.getText().replace(/^['"`]|['"`]$/g, "") !== match[0] ||
        field.typed.has(`${source.getFilePath()}:${node.getStart()}`)
      ) {
        continue;
      }
      const parent = node.getParent();
      let shown = false;
      const rename = (
        start: number,
        end: number,
        replacement: string,
        moved: UntypedField["moved"][number],
        through: string,
      ) =>
        result.edits.push({
          file: source.getFilePath(),
          start,
          end,
          replacement,
          changeId: moved.changeId,
          author: "codemod",
          reason: `${moved.reason}; ${through}`,
        });
      if (
        (Node.isPropertyAssignment(parent) ||
          Node.isShorthandPropertyAssignment(parent)) &&
        parent.getNameNode() === node
      ) {
        const literal = parent.getParent();
        if (
          Node.isObjectLiteralExpression(literal) &&
          untyped(literal.getContextualType())
        ) {
          const passed = importsSdk ? undefined : passedAsSdk(literal, match[0], scope);
          const into = importsSdk
            ? passedOnlyAs(literal, match[0], field.moved)
            : undefined;
          const head = into?.path?.length === 1 ? into.path[0] : undefined;
          if (into && head !== undefined) {
            const key = /^[A-Za-z_$][\w$]*$/.test(head) ? head : JSON.stringify(head);
            if (Node.isShorthandPropertyAssignment(parent)) {
              rename(
                parent.getStart(),
                parent.getEnd(),
                `${key}: ${node.getText()}`,
                into,
                "the object is only ever passed where the SDK's type is expected",
              );
            } else {
              rename(
                node.getStart(),
                node.getEnd(),
                key,
                into,
                "the object is only ever passed where the SDK's type is expected",
              );
            }
          } else if (importsSdk) shown = true;
          else if (passed) {
            result.manual.push(
              manualFrom(
                node,
                field.changeId,
                `${field.reason}; this object is passed where the SDK's \`${passed}\` is expected`,
              ),
            );
          }
        }
      } else if (!importsSdk) {
        continue;
      } else if (
        Node.isPropertyAccessExpression(parent) &&
        parent.getNameNode() === node
      ) {
        const receiver = parent.getExpression();
        const from = untyped(receiver.getType())
          ? passedByEveryCaller(receiver, match[0], field.moved)
          : undefined;
        if (from?.path) {
          rename(
            node.getStart(),
            node.getEnd(),
            from.path.join("."),
            from,
            "every call passes the SDK's object to the parameter it is read from",
          );
        } else shown = untyped(receiver.getType());
      } else if (
        Node.isElementAccessExpression(parent) &&
        parent.getArgumentExpression() === node
      ) {
        shown = untyped(parent.getExpression().getType());
      }
      if (shown) result.manual.push(manualFrom(node, field.changeId, field.reason));
    }
  }
}

/**
 * The SDK type a stand-in is handed to as an argument, where it declares
 * `field`: hiroppy's web-app-template tests its subscription handler with
 * `const subscription = { current_period_end: null, ... }` and
 * `handleSubscriptionUpsert(subscription)`, whose parameter is a
 * `Stripe.Subscription`, the mismatch silenced by `@ts-expect-error`. The
 * file never imports the SDK, but the types say what the object stands in
 * for.
 */
function passedAsSdk(
  literal: ObjectLiteralExpression,
  field: string,
  scope: EditScope,
): string | undefined {
  const holder = literal.getParent();
  if (!Node.isVariableDeclaration(holder) || holder.getInitializer() !== literal)
    return undefined;
  const list = holder.getVariableStatement()?.getDeclarationList();
  const name = holder.getNameNode();
  if (list?.getDeclarationKind() !== "const" || !Node.isIdentifier(name))
    return undefined;
  const checker = literal.getProject().getTypeChecker();
  for (const reference of name.findReferencesAsNodes()) {
    const call = reference.getParent();
    if (!Node.isCallExpression(call)) continue;
    const index = call.getArguments().indexOf(reference);
    if (index === -1) continue;
    const parameter = checker.getResolvedSignature(call)?.getParameters()[index];
    if (!parameter) continue;
    const type = parameter.getTypeAtLocation(call);
    const declared = type.getProperty(field)?.getDeclarations() ?? [];
    if (
      declared.length > 0 &&
      declared.every((declaration) =>
        isGenerated(declaration.getSourceFile().getFilePath(), scope),
      )
    ) {
      return type.getText(call);
    }
  }
  return undefined;
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
  /**
   * A field the type inherits from an interface it extends, as `email` on a
   * `Customer` that extends `CustomerBase`, with the type itself, which each
   * reference has to be proven to read it from.
   */
  const inheritedIn = (
    target: TargetSymbol,
  ): { declaration: PropertySignature; type: Type } | undefined => {
    if (target.within) return undefined;
    const root = interfaceNamed(project, target.typeName, scope);
    const declaration = root
      ?.getType()
      .getProperty(target.property)
      ?.getDeclarations()
      .find((each) => Node.isPropertySignature(each));
    if (
      !root ||
      !Node.isPropertySignature(declaration) ||
      !isGenerated(declaration.getSourceFile().getFilePath(), scope)
    )
      return undefined;
    return { declaration, type: root.getType() };
  };

  // One group per field, so every op that touches it composes into one edit.
  const groups = new Map<string, TargetSymbol[]>();
  /** Each moved or removed field's name, for the places nothing types. */
  const untypedFields = new Map<string, UntypedField>();
  /** Values the contextual pass could not place on a field (`applyContextualEnums`). */
  const unsure: ManualSite[] = [];
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
    const own = propertyIn(first);
    const inherited = own ? undefined : inheritedIn(first);
    const declaration = own ?? inherited?.declaration;
    if (!declaration) continue;

    const composed = compose(targets, plan.symbols.helpers);
    const typed = new Set<string>();
    const enums = targets.filter(
      (target) => target.op.op === "convert" && target.op.codec.kind === "enumMap",
    );
    // The alias the SDK declares the field's values as, where it declares one.
    const alias = declaration.getType().getAliasSymbol();
    const vocabulary = alias
      ?.getDeclarations()
      .every((each) => isGenerated(each.getSourceFile().getFilePath(), scope))
      ? alias
      : undefined;
    for (const target of enums) {
      if (target.op.op !== "convert" || target.op.codec.kind !== "enumMap") continue;
      applyContextualEnums(
        project,
        Object.fromEntries(target.op.codec.pairs),
        target.changeId,
        scope,
        result,
        declaration,
        unsure,
        vocabulary,
      );
    }

    for (const node of declaration.findReferencesAsNodes()) {
      if (!editable(node, scope)) continue;
      typed.add(`${node.getSourceFile().getFilePath()}:${node.getStart()}`);
      const role = roleOf(node);
      if (role === "type-reference") continue;
      // A field the type inherits is declared on a base other types may
      // share, so a reference is the Change's only where the value it is
      // read from, written into or destructured from is certainly the type.
      if (inherited && !readFrom(node, role, inherited.type)) {
        if (
          composed.path.join(".") !== first.property ||
          composed.wrapRead ||
          composed.unsupported
        ) {
          result.manual.push(
            manualFrom(
              node,
              first.changeId,
              `\`${first.property}\` is declared on a base that \`${first.typeName}\` shares, and this value is not certainly a \`${first.typeName}\`; if it is one, ${composed.unsupported ?? composed.reasons.join("; ")}`,
            ),
          );
        }
        continue;
      }

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

    if (
      composed.path.length !== 1 ||
      composed.path[0] !== first.property ||
      composed.wrapRead ||
      composed.unsupported
    ) {
      const name = first.property;
      const seen = untypedFields.get(name);
      const moved = {
        declaration: declaration as Node,
        ...(composed.wrapRead || composed.unsupported ? {} : { path: composed.path }),
        changeId: first.changeId,
        reason: composed.reasons.join("; "),
      };
      if (seen) {
        for (const position of typed) seen.typed.add(position);
        seen.moved.push(moved);
      } else {
        const what =
          composed.unsupported ??
          `the contract changed it: ${composed.reasons.join("; ")}`;
        untypedFields.set(name, {
          changeId: first.changeId,
          reason: `nothing types this \`${name}\`, so it is shown rather than rewritten; if it is the contract's field, ${what}`,
          typed,
          moved: [moved],
        });
      }
    }
  }
  flagUntyped(project, untypedFields, plan.symbols.package, scope, result);

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

  // A value one field's pass could not place is shown, unless another pass,
  // or the rewrite beside a field it is compared with, rewrote it after all.
  for (const site of unsure) {
    const rewritten = result.edits.some(
      (edit) =>
        edit.file === site.file && edit.start <= site.offset && site.offset < edit.end,
    );
    const shown = result.manual.some(
      (other) => other.file === site.file && other.offset === site.offset,
    );
    if (!rewritten && !shown) result.manual.push(site);
  }

  // A value renamed both beside the field it is compared with and by the
  // type its position expects is one edit, not two of the same span.
  const written = new Set<string>();
  result.edits = result.edits.filter((edit) => {
    if (typeof edit.replacement !== "string") return true;
    const key = `${edit.file}\u0000${edit.start}\u0000${edit.end}\u0000${edit.replacement}`;
    if (written.has(key)) return false;
    written.add(key);
    return true;
  });
  return result;
}
