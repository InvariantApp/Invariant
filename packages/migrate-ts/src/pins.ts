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

/** The literal an option's value comes down to, through assertions and one constant. */
function literalBehind(node: Node, scope: EditScope): Node | undefined {
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
  if (!Node.isIdentifier(value)) return undefined;
  // A constant the consumer declared once, as `const API_VERSION = "..."`.
  const [declaration, ...others] = value.getSymbol()?.getDeclarations() ?? [];
  if (!declaration || others.length > 0 || !Node.isVariableDeclaration(declaration)) {
    return undefined;
  }
  // Only a `const`: a `let` may be reassigned where the checker cannot say.
  const list = declaration.getVariableStatement()?.getDeclarationList();
  if (list?.getDeclarationKind() !== "const") return undefined;
  const initializer = declaration.getInitializer();
  return initializer && editable(initializer, scope)
    ? literalBehind(initializer, scope)
    : undefined;
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
    if (
      !Node.isPropertyAssignment(assignment) ||
      assignment.getNameNode() !== reference
    ) {
      continue;
    }
    const initializer = assignment.getInitializer();
    const literal = initializer && literalBehind(initializer, scope);
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
