/**
 * Calls to an operation the provider retired, shown to a person.
 *
 * There is nothing to rewrite a retired call into unless the provider says
 * what replaced it, and even then the replacement usually takes other
 * arguments: Stripe's `invoices.retrieveUpcoming` became `createPreview`, a
 * POST with a body of its own. So each call is found through the type checker,
 * by the SDK method the symbol map says calls the operation, and reported
 * where it is, with the provider's guidance when it gave some. The consumer's
 * own stubs of the method, as `sinon.stub(client.subscriptions, "del")`, are
 * references too and are reported the same way.
 */
import { Node, type Project, SyntaxKind } from "ts-morph";
import {
  type EditScope,
  type EngineResult,
  editable,
  manualFrom,
  qualifiedName,
} from "./engine.ts";
import type { MigrationPlan } from "./plan.ts";

/** Every declaration of `method` on the class or interface the SDK names `typeName`. */
function methodDeclarations(
  project: Project,
  typeName: string,
  method: string,
  scope: EditScope,
): Node[] {
  const found: Node[] = [];
  for (const source of project.getSourceFiles()) {
    const path = source.getFilePath();
    if (!scope.generated.some((entry) => path.startsWith(entry))) continue;
    const holders = [
      ...source.getDescendantsOfKind(SyntaxKind.ClassDeclaration),
      ...source.getDescendantsOfKind(SyntaxKind.InterfaceDeclaration),
    ];
    for (const holder of holders) {
      if (qualifiedName(holder) !== typeName && holder.getName() !== typeName) continue;
      for (const member of holder.getMembers()) {
        if (
          (Node.isMethodDeclaration(member) || Node.isMethodSignature(member)) &&
          member.getName() === method
        ) {
          found.push(member);
        }
      }
    }
  }
  return found;
}

/** Reports every call the consumer makes to an operation the provider retired. */
export function flagRetired(
  project: Project,
  plan: MigrationPlan,
  scope: EditScope,
  result: EngineResult,
): void {
  const operations = plan.symbols.operations ?? {};
  const seen = new Set<string>();
  for (const retired of plan.retired) {
    const caller = operations[retired.key];
    if (!caller) continue;
    const [verb, path] = retired.key.split(" ");
    const reason =
      `\`${caller.method}\` calls ${(verb ?? "").toUpperCase()} ${path}, which the provider retired` +
      (retired.guidance ? `; ${retired.guidance}` : "");
    for (const declaration of methodDeclarations(
      project,
      caller.type,
      caller.method,
      scope,
    )) {
      const named = declaration.getFirstChildByKind(SyntaxKind.Identifier);
      if (!named) continue;
      for (const reference of named.findReferencesAsNodes()) {
        if (!editable(reference, scope)) continue;
        const key = `${reference.getSourceFile().getFilePath()}:${reference.getStart()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.manual.push(manualFrom(reference, retired.changeId, reason));
      }
    }
  }
}
