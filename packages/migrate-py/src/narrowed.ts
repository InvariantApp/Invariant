/**
 * Where a value the SDK now widens runs into the consumer's own narrower type.
 *
 * Typed Python often copies an SDK's `Literal` of values into its own
 * signatures. polar's `DisputeStatus.from_stripe(status: Literal["lost",
 * ..., "won"])` took Stripe's dispute statuses, matched on them, and when
 * Stripe added "prevented" the checker's error was at the call, where
 * `dispute.status` no longer fits the parameter. The fix is not there: it is
 * the parameter's annotation, and the `match` on it that needs a new case.
 * So an argument error against a function of the consumer's also reports
 * that function's signature, and any `match` in it on that parameter.
 */
import type { Edit, ManualSite } from "@invariant-app/migrate-core";
import { manualAt } from "./engine.ts";
import type { Diagnostic } from "./pyright.ts";
import { isSpan, type ReferenceProvider } from "./references.ts";
import { descendantsOfType, enclosing, type Node, parsePython } from "./syntax.ts";

const UPGRADE = "sdk-upgrade";

/** Where an offset in the edited text was before the edits (`index.ts`). */
type Back = (offset: number, edits: readonly Edit[]) => number;

export async function narrowedParameters(
  references: ReferenceProvider,
  /** Each file's text as checked, after the edits. */
  now: Map<string, string>,
  /** Each file's text as it was read. */
  original: Map<string, string>,
  file: string,
  diagnostic: Diagnostic,
  edits: readonly Edit[],
  back: Back,
): Promise<ManualSite[]> {
  if ((diagnostic.code ?? diagnostic.rule) !== "reportArgumentType") return [];
  const parameter = /parameter "(\w+)"/.exec(diagnostic.message)?.[1];
  const text = now.get(file);
  if (!parameter || text === undefined) return [];
  const lines = text.split("\n");
  const offset =
    lines
      .slice(0, diagnostic.range.start.line)
      .reduce((sum, line) => sum + line.length + 1, 0) + diagnostic.range.start.character;
  const tree = await parsePython(text);
  try {
    const call = enclosing(tree, offset, "call");
    const callee = call?.childForFieldName("function");
    const name =
      callee?.type === "attribute" ? callee.childForFieldName("attribute") : callee;
    if (!name) return [];
    const sites: ManualSite[] = [];
    for (const place of await references.definitionAt(file, name.startIndex)) {
      if (!isSpan(place)) continue;
      const definedText = now.get(place.file);
      // A file the checker read on the way, such as the model module a
      // helper lives in, was never edited: as read is as checked.
      const readText =
        original.get(place.file) ??
        (edits.some((edit) => edit.file === place.file) ? undefined : definedText);
      if (definedText === undefined || readText === undefined) continue;
      const defined = await parsePython(definedText);
      try {
        const fn = enclosing(defined, place.start, "function_definition");
        const body = fn?.childForFieldName("body");
        const parameters = fn?.childForFieldName("parameters");
        if (!fn || !body || !parameters) continue;
        const named = (node: Node | null) =>
          node?.type === "identifier"
            ? node.text
            : (node?.childForFieldName("name")?.text ?? node?.namedChildren[0]?.text);
        if (!parameters.namedChildren.some((child) => named(child) === parameter))
          continue;
        const mine = edits.filter((edit) => edit.file === place.file);
        const report = (start: number, end: number, reason: string) =>
          sites.push(
            manualAt(
              place.file,
              readText,
              back(start, mine),
              back(end, mine),
              UPGRADE,
              reason,
            ),
          );
        const said = diagnostic.message
          .split("\n")
          .slice(0, 2)
          .map((line) => line.trim());
        report(
          fn.startIndex,
          parameters.endIndex,
          `\`${parameter}\` is passed a value the upgraded SDK widened: ${said.join(" ")}`,
        );
        for (const match of descendantsOfType(body, ["match_statement"])) {
          if (match.childForFieldName("subject")?.text !== parameter) continue;
          report(
            match.startIndex,
            match.endIndex,
            `this matches on \`${parameter}\`, which can now hold a value it has no case for`,
          );
        }
      } finally {
        defined.delete();
      }
    }
    return sites;
  } finally {
    tree.delete();
  }
}
