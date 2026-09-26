/**
 * Values an SDK's vocabulary gained, where the consumer decides on one.
 *
 * An API adds a value to a field it answers with: Anthropic's `stop_reason`
 * gained `compaction`, then `model_context_window_exceeded`. Code that matches
 * on the field, or compares it with the old values, still type-checks and
 * quietly treats the new value as none of them, or reaches an
 * `assert_never` at run time. The SDK declares the vocabulary as a literal
 * alias (`StopReason`) in both releases, so what the new release lists that
 * the old one did not is known before anything runs.
 *
 * A decision is a `match` whose cases are string literals, or a comparison of
 * a value with string literals. It is taken to be on a vocabulary only where
 * every literal it names is one of that vocabulary's old values and it names
 * at least two of them: one literal says little about which list it came from.
 * Where it already names every new value, nothing is shown. Otherwise each
 * case that names the vocabulary's values is shown, since which of them
 * should take the new value, or whether a new case should, is the consumer's
 * choice; a comparison is shown where it is written.
 */
import type { ManualSite } from "@invariant-app/migrate-core";
import { type EngineResult, manualAt, type Sources } from "./engine.ts";
import { descendantsOfType, type Node, stringValue } from "./syntax.ts";
import { vocabularies } from "./values.ts";

/** A literal alias of the new release, with the values it gained and the old ones. */
export interface Grown {
  name: string;
  before: ReadonlySet<string>;
  added: readonly string[];
}

/** Each literal alias both releases declare, where the new one lists values the old one did not. */
export function grownVocabularies(old: string, next: string): Grown[] {
  const before = vocabularies(old).aliases;
  const after = vocabularies(next).aliases;
  const grown: Grown[] = [];
  for (const [name, values] of after) {
    const was = before.get(name);
    if (!was || was.size === 0) continue;
    const added = [...values].filter((value) => !was.has(value)).sort();
    if (added.length > 0) grown.push({ name, before: was, added });
  }
  return grown;
}

/** The string literals a case's patterns name, not those of anything nested in its body. */
function caseLiterals(clause: Node): string[] {
  return clause.namedChildren
    .filter((child): child is Node => child?.type === "case_pattern")
    .flatMap((pattern) => descendantsOfType(pattern, ["string"]))
    .flatMap((node) => {
      const value = stringValue(node);
      return value === undefined ? [] : [value];
    });
}

/** The literals a comparison compares with: `x == "a"`, `x in ("a", "b")`. */
function comparedLiterals(comparison: Node): string[] | undefined {
  const operands = comparison.namedChildren.filter(
    (child): child is Node => child !== null,
  );
  if (operands.length !== 2) return undefined;
  const literals = (node: Node): string[] | undefined => {
    if (node.type === "string") {
      const value = stringValue(node);
      return value === undefined ? undefined : [value];
    }
    if (["tuple", "list", "set"].includes(node.type)) {
      const values = node.namedChildren.map((item) =>
        item ? stringValue(item) : undefined,
      );
      return values.every((value) => value !== undefined) && values.length > 0
        ? (values as string[])
        : undefined;
    }
    return undefined;
  };
  const [left, right] = operands as [Node, Node];
  return literals(right) ?? literals(left);
}

/** What the vocabularies a decision's literals all come from gained, that it does not name. */
function unhandled(literals: readonly string[], grown: readonly Grown[]): Grown[] {
  if (new Set(literals).size < 2) return [];
  return grown.filter(
    (vocabulary) =>
      literals.every((value) => vocabulary.before.has(value)) &&
      vocabulary.added.some((value) => !literals.includes(value)),
  );
}

const describe = (found: readonly Grown[], literals: readonly string[]): string => {
  const added = [...new Set(found.flatMap((each) => each.added))]
    .filter((value) => !literals.includes(value))
    .map((value) => `"${value}"`);
  const names = found.map((each) => `\`${each.name}\``).join(" and ");
  return `the upgraded SDK's ${names} can now also be ${added.join(", ")}, which nothing here decides on`;
};

/** Every decision on a vocabulary the upgrade grew, in the consumer's files. */
export async function grownVocabularySites(
  sources: Sources,
  grown: readonly Grown[],
  result: EngineResult,
): Promise<void> {
  if (grown.length === 0) return;
  for (const [file, text] of sources.texts) {
    if (!text.includes("match") && !/[=!]=|\bin\b/.test(text)) continue;
    const tree = await sources.tree(file);
    if (!tree) continue;
    const sites: ManualSite[] = [];
    for (const statement of descendantsOfType(tree.rootNode, ["match_statement"])) {
      const clauses = descendantsOfType(statement, ["case_clause"]).filter(
        // Only this match's own cases, not those of a match nested in one.
        (clause) => clause.parent?.parent?.id === statement.id,
      );
      const named = clauses.map((clause) => ({ clause, literals: caseLiterals(clause) }));
      const literals = named.flatMap((each) => each.literals);
      const found = unhandled(literals, grown);
      if (found.length === 0) continue;
      const reason = describe(found, literals);
      for (const { clause, literals: own } of named) {
        if (own.length === 0) continue;
        const pattern = clause.namedChildren.find(
          (child) => child?.type === "case_pattern",
        );
        sites.push(
          manualAt(
            file,
            text,
            clause.startIndex,
            pattern?.endIndex ?? clause.startIndex,
            "",
            reason,
            pattern?.startIndex ?? clause.startIndex,
          ),
        );
      }
    }
    for (const comparison of descendantsOfType(tree.rootNode, ["comparison_operator"])) {
      const literals = comparedLiterals(comparison);
      if (!literals) continue;
      const found = unhandled(literals, grown);
      if (found.length === 0) continue;
      sites.push(
        manualAt(
          file,
          text,
          comparison.startIndex,
          comparison.endIndex,
          "",
          describe(found, literals),
        ),
      );
    }
    result.manual.push(...sites);
  }
}
