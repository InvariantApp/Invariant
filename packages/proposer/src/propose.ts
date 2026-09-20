/**
 * Drafting Changes from a structural diff.
 *
 * What comes out is a file for a person to read, edit and merge. It is never
 * applied, never shipped, and never trusted: a draft still has to explain the
 * whole breaking diff before the release gate will pass, so the cost of a
 * wrong proposal is a review comment rather than a broken integration.
 *
 * The ops are derived, not asked for. A judge says only which field replaced
 * which; whether that is a rename, a unit change or an enum remapping, and
 * what the scale factor is, comes from the declared shapes.
 */
import type { Change, Op } from "@invariant/ir";
import { type FieldShape, type SchemaDelta, schemaDeltas } from "./candidates.ts";
import type { Judge, JudgeId } from "./judge.ts";
import { questionsFor } from "./judge.ts";
import { stemOf, UNIT_SUFFIXES } from "./rules.ts";

/** Below this, a draft is marked for explicit attention rather than assumed good. */
export const DEFAULT_ATTENTION_THRESHOLD = 0.6;

export interface Proposal {
  change: Change;
  judge: JudgeId;
  confidence: number;
  /** `explicit` means a reviewer should not skim past this one. */
  attention: "normal" | "explicit";
  /** Why the ops came out the way they did, in a reviewer's words. */
  notes: string[];
}

const MINOR_UNIT_EXPONENTS: ReadonlyMap<string, number> = new Map([
  ["cents", 2],
  ["minor", 2],
  ["ms", 3],
  ["millis", 3],
]);

function slug(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Turns a confirmed field pairing into ops, from the shapes alone.
 *
 * A judge is never asked for a scale factor. `amount` declared to two decimal
 * places becoming `amount_cents` declared as an integer says the exponent is
 * two, and saying it any other way would be guessing about arithmetic.
 */
export function opsFor(
  removed: FieldShape,
  successor: FieldShape,
): { ops: Op[]; notes: string[] } {
  const ops: Op[] = [];
  const notes: string[] = [];

  if (removed.name !== successor.name) {
    ops.push({ op: "move", from: removed.pointer, to: successor.pointer });
    notes.push(`\`${removed.name}\` became \`${successor.name}\``);
  }

  const suffix = slug(successor.name).split("_").at(-1);
  const exponent = suffix === undefined ? undefined : MINOR_UNIT_EXPONENTS.get(suffix);
  const numericChange =
    removed.type === "number" && successor.type === "integer" && exponent !== undefined;

  if (numericChange) {
    ops.push({
      op: "convert",
      path: successor.pointer,
      codec: { kind: "scale10", exponent, onInexact: "reject" },
    });
    notes.push(
      `the \`${suffix}\` suffix and the change from number to integer say the values scale by 10^${exponent}. ` +
        "Check that against the contract's declared precision before merging.",
    );
  } else if (removed.type !== successor.type && removed.type && successor.type) {
    notes.push(
      `the type changed from ${removed.type} to ${successor.type}, which this draft does not express. ` +
        "Add the right codec, or say why no conversion is needed.",
    );
  }

  const before = removed.enumValues;
  const after = successor.enumValues;
  if (before && after) {
    const kept = before.filter((value) => after.includes(value));
    const dropped = before.filter((value) => !after.includes(value));
    const gained = after.filter((value) => !before.includes(value));

    if (dropped.length > 0 || gained.length > 0) {
      // A one-to-one pairing is only obvious when exactly one value moved.
      // Anything else is left for a person rather than guessed at.
      const pairs: [string, string][] = kept.map((value) => [value, value]);
      if (dropped.length === gained.length && dropped.length === 1) {
        pairs.push([dropped[0] as string, gained[0] as string]);
        notes.push(`\`${dropped[0]}\` became \`${gained[0]}\``);
      } else if (dropped.length > 0) {
        notes.push(
          `the allowed values changed (${dropped.join(", ")} went, ${gained.join(", ") || "nothing"} arrived). ` +
            "Pair them up by hand: which old value maps to which new one is not derivable from the shapes.",
        );
      }
      if (pairs.length === before.length) {
        ops.push({
          op: "convert",
          path: successor.pointer,
          codec: { kind: "enumMap", pairs },
        });
      }
    }
  }

  return { ops, notes };
}

/** Something that changed which the proposer would not draft. Reported, not hidden. */
export interface Unresolved {
  schema: string;
  field: string;
  reason: string;
}

export interface ProposeOutcome {
  proposals: Proposal[];
  unresolved: Unresolved[];
}

export interface ProposeOptions {
  judge: Judge;
  /** Text from the pull request. Treated as evidence, never as instruction. */
  context?: string;
  attentionThreshold?: number;
}

/**
 * Proposes one Change per schema whose fields a judge could pair up.
 */
export async function propose(
  oldContract: Parameters<typeof schemaDeltas>[0],
  newContract: Parameters<typeof schemaDeltas>[1],
  options: ProposeOptions,
): Promise<ProposeOutcome> {
  const threshold = options.attentionThreshold ?? DEFAULT_ATTENTION_THRESHOLD;
  const deltas = schemaDeltas(oldContract, newContract);

  const altered = alteredProposals(deltas);
  const unresolved: Unresolved[] = [...altered.unresolved, ...additions(deltas)];

  const questions = deltas.flatMap((delta: SchemaDelta) =>
    questionsFor(delta, options.context),
  );
  if (questions.length === 0) return { proposals: altered.proposals, unresolved };

  const results = await options.judge.align(questions);
  const proposals: Proposal[] = [...altered.proposals];

  questions.forEach((question, index) => {
    const result = results[index];
    if (!result || result.answer.abstained || result.answer.successor === null) {
      unresolved.push({
        schema: question.schema,
        field: question.removed.name,
        reason:
          result?.answer.successor === null && !result.answer.abstained
            ? "nothing in the new contract replaces it, so this is a removal a person has to decide about"
            : "no judge would say which field replaced it",
      });
      return;
    }

    const successor = question.candidates.find(
      (candidate) => candidate.name === result.answer.successor,
    );
    if (!successor) return;

    const { ops, notes } = opsFor(question.removed, successor);
    if (ops.length === 0) {
      unresolved.push({
        schema: question.schema,
        field: question.removed.name,
        reason: `paired with \`${successor.name}\`, but ${notes.join("; ") || "no op expresses the difference"}`,
      });
      return;
    }

    const id = `chg_${slug(question.schema)}_${slug(stemOf(question.removed.name))}`;
    const confidence = result.answer.confidence;

    proposals.push({
      change: {
        irVersion: 1,
        id,
        summary: `\`${question.removed.name}\` became \`${successor.name}\` on ${question.schema}.`,
        scopes: [{ schema: `#/components/schemas/${question.schema}` }],
        ops,
        provenance: {
          proposed_by: {
            judge: result.judge,
            ...(result.model ? { model: result.model } : {}),
            confidence,
          },
        },
      },
      judge: result.judge,
      confidence,
      attention: confidence >= threshold ? "normal" : "explicit",
      notes:
        confidence >= threshold
          ? notes
          : [
              `the judge was only ${(confidence * 100).toFixed(0)}% sure this pairing is right. Check it yourself.`,
              ...notes,
            ],
    });
  });

  // A field that a draft already accounts for is not an open question. Saying
  // it twice would bury the ones that really are unaccounted for.
  const accountedFor = new Set(
    proposals.flatMap((proposal) =>
      proposal.change.ops.flatMap((op) =>
        op.op === "move" ? [`${scopeName(proposal)}.${op.to.replace("/", "")}`] : [],
      ),
    ),
  );

  return {
    proposals,
    unresolved: unresolved.filter(
      (entry) => !accountedFor.has(`${entry.schema}.${entry.field}`),
    ),
  };
}

/** The schema a proposal is scoped to, for matching against an unresolved field. */
function scopeName(proposal: Proposal): string {
  const scope = proposal.change.scopes?.[0];
  if (!scope || !("schema" in scope)) return "";
  return scope.schema.slice(scope.schema.lastIndexOf("/") + 1);
}

/** Fields that are new in the target contract, which need a default nobody can derive. */
function additions(deltas: readonly SchemaDelta[]): Unresolved[] {
  return deltas.flatMap((delta) =>
    delta.added
      .filter((field) => field.required)
      .map((field) => ({
        schema: delta.schema,
        field: field.name,
        reason:
          "newly required, and the value a caller who predates it should get is not in the specification",
      })),
  );
}

/**
 * Fields that kept their name but changed shape.
 *
 * No judge is involved: the field is plainly the same one, so the only
 * question is what happened to its values, and that is in the declared shapes.
 * A vocabulary change is the common case and the one worth drafting.
 *
 * Not yet covered: a field that is new in the target contract with no removed
 * counterpart. Deciding whether it is genuinely new or a replacement for
 * something is the alignment question run the other way round, and the default
 * it needs is not in the specification at all. Those still get written by hand,
 * and the release gate refuses the release until they are.
 */
function alteredProposals(deltas: readonly SchemaDelta[]): ProposeOutcome {
  const proposals: Proposal[] = [];
  const unresolved: Unresolved[] = [];

  for (const delta of deltas) {
    for (const pair of delta.altered) {
      const { ops, notes } = opsFor(pair.old, pair.new);
      if (ops.length === 0) {
        unresolved.push({
          schema: delta.schema,
          field: pair.old.name,
          reason: notes.join("; ") || "its shape changed in a way no op expresses",
        });
        continue;
      }

      proposals.push({
        change: {
          irVersion: 1,
          id: `chg_${slug(delta.schema)}_${slug(pair.old.name)}`,
          summary: `\`${pair.old.name}\` changed shape on ${delta.schema}.`,
          scopes: [{ schema: `#/components/schemas/${delta.schema}` }],
          ops,
          provenance: { proposed_by: { judge: "rules", confidence: 1 } },
        },
        judge: "rules",
        confidence: 1,
        attention: "normal",
        notes: [`the field kept its name, so only its values moved`, ...notes],
      });
    }
  }

  return { proposals, unresolved };
}

export { UNIT_SUFFIXES };
