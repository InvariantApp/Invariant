/**
 * The contract a consumer says it speaks, moved to the one the upgrade speaks.
 *
 * An SDK that sends an API version names it in its options, as stripe-node's
 * `apiVersion`, and types it as the one version that release was built for.
 * Upgrading the package without moving the pin is a type error; moving it by
 * hand is the most common edit on a Stripe upgrade there is. The type
 * checker finds every place the option is written, through a constant or an
 * assertion, and the literal is rewritten where it stands. Anything else, an
 * environment variable or a value computed at runtime, is shown to a person:
 * what it holds is not in the source.
 */
import { Node, type Project } from "ts-morph";
import {
  type EditScope,
  type EngineResult,
  editable,
  manualFrom,
  membersOf,
} from "./engine.ts";
import type { SymbolMap } from "./plan.ts";

const CHANGE = "sdk-upgrade";

/** How many hops a value is followed through before it is shown to a person instead. */
const MAX_HOPS = 8;

/**
 * The literal an option's value comes down to: through assertions, `const`
 * declarations, the consumer's own configuration objects, shorthand
 * properties and destructuring, as far as the type checker can say where the
 * value was written. decipad writes the pin once in its configuration and
 * passes it on as `const { apiVersion } = thirdParty().stripe` and then
 * `{ apiVersion }` in five places; the edit is the one literal.
 */
function literalBehind(node: Node, scope: EditScope, hops = 0): Node | undefined {
  if (hops > MAX_HOPS) return undefined;
  let value: Node = node;
  while (
    Node.isAsExpression(value) ||
    Node.isSatisfiesExpression(value) ||
    Node.isParenthesizedExpression(value) ||
    Node.isTypeAssertion(value)
  ) {
    value = value.getExpression();
  }
  if (Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value)) {
    return value;
  }
  if (Node.isShorthandPropertyAssignment(value)) {
    const checker = value.getProject().getTypeChecker();
    return writtenAt(checker.getShorthandAssignmentValueSymbol(value), scope, hops);
  }
  if (Node.isPropertyAccessExpression(value)) {
    return writtenAt(value.getNameNode().getSymbol(), scope, hops);
  }
  if (Node.isIdentifier(value)) return writtenAt(value.getSymbol(), scope, hops);
  return undefined;
}

/** The literal a symbol's one declaration holds, in the consumer's own code. */
function writtenAt(
  symbol: ReturnType<Node["getSymbol"]>,
  scope: EditScope,
  hops: number,
): Node | undefined {
  const [declaration, ...others] = symbol?.getDeclarations() ?? [];
  if (!declaration || others.length > 0 || !editable(declaration, scope))
    return undefined;
  const next = hops + 1;
  if (Node.isVariableDeclaration(declaration)) {
    // Only a `const`: a `let` may be reassigned where the checker cannot say.
    const list = declaration.getVariableStatement()?.getDeclarationList();
    if (list?.getDeclarationKind() !== "const") return undefined;
    const initializer = declaration.getInitializer();
    return initializer ? literalBehind(initializer, scope, next) : undefined;
  }
  if (Node.isPropertyAssignment(declaration)) {
    const initializer = declaration.getInitializer();
    return initializer ? literalBehind(initializer, scope, next) : undefined;
  }
  if (Node.isShorthandPropertyAssignment(declaration)) {
    return literalBehind(declaration, scope, next);
  }
  if (Node.isBindingElement(declaration)) {
    // `const { apiVersion } = source`: the property of what is destructured.
    const pattern = declaration.getParent();
    const holder = pattern?.getParent();
    if (!Node.isObjectBindingPattern(pattern) || !Node.isVariableDeclaration(holder)) {
      return undefined;
    }
    const list = holder.getVariableStatement()?.getDeclarationList();
    if (list?.getDeclarationKind() !== "const") return undefined;
    const name = declaration.getPropertyNameNode()?.getText() ?? declaration.getName();
    const source = holder.getInitializer();
    return source
      ? writtenAt(source.getType().getProperty(name), scope, next)
      : undefined;
  }
  return undefined;
}

/** Moves every pin the consumer wrote to the label the upgrade speaks. */
export function bumpPins(
  project: Project,
  symbols: SymbolMap,
  scope: EditScope,
  result: EngineResult,
): void {
  const pin = symbols.pin;
  if (!pin) return;
  const property = membersOf(project, pin.type, scope)?.find(
    (member) => Node.isPropertySignature(member) && member.getName() === pin.property,
  );
  if (!property || !Node.isPropertySignature(property)) return;

  const seen = new Set<string>();
  for (const reference of property.findReferencesAsNodes()) {
    if (!editable(reference, scope)) continue;
    const assignment = reference.getParent();
    // `{ apiVersion: value }`, or `{ apiVersion }` with the value in a binding.
    const written = Node.isPropertyAssignment(assignment)
      ? assignment.getNameNode() === reference
        ? assignment.getInitializer()
        : undefined
      : Node.isShorthandPropertyAssignment(assignment) &&
          assignment.getNameNode() === reference
        ? assignment
        : undefined;
    if (written === undefined) continue;
    const literal = literalBehind(written, scope);
    if (!literal) {
      result.manual.push(
        manualFrom(
          reference,
          CHANGE,
          `the ${pin.property} here is not written in the source; set it to ${pin.label}`,
        ),
      );
      continue;
    }
    const text = literal.getText();
    const key = `${literal.getSourceFile().getFilePath()}:${literal.getStart()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (text.slice(1, -1) === pin.label) continue;
    const quote = text[0] ?? '"';
    result.edits.push({
      file: literal.getSourceFile().getFilePath(),
      start: literal.getStart(),
      end: literal.getEnd(),
      replacement: `${quote}${pin.label}${quote}`,
      changeId: CHANGE,
      author: "codemod",
      reason: `speaks ${pin.label}, the contract the upgrade is built for`,
    });
  }
}
