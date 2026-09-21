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
import type { Change, Op, ScalarType } from "@invariant/ir";
import { type FieldShape, type SchemaDelta, schemaDeltas } from "./candidates.ts";
import {
  parameterChanges,
  parameterDeltas,
  retireChange,
  retiredEndpoints,
} from "./endpoints.ts";
import type { Judge, JudgeId } from "./judge.ts";
import { questionsFor } from "./judge.ts";
import { detectPrefixMove, prefixChange } from "./prefix.ts";
import { stemOf, UNIT_SUFFIXES } from "./rules.ts";
import { type FoldDecision, foldDecisions } from "./vocabulary.ts";

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

/** What `cast` can move between. Anything structural is out of scope. */
const SCALARS = new Set(["string", "integer", "number", "boolean"]);

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
    // `cast` has always existed and this emitted a note instead of using it,
    // which is why aligning a renamed field left the type difference behind as
    // a fresh unexplained delta. Scalars only: nothing converts an object into
    // an array, and claiming otherwise would be worse than saying nothing.
    if (SCALARS.has(removed.type) && SCALARS.has(successor.type)) {
      ops.push({
        op: "convert",
        path: successor.pointer,
        codec: {
          kind: "cast",
          from: removed.type as ScalarType,
          to: successor.type as ScalarType,
        },
      });
      notes.push(
        `the type changed from ${removed.type} to ${successor.type}, which this ` +
          "draft converts. Check that every value the old contract allowed " +
          "survives the conversion.",
      );
    } else {
      notes.push(
        `the type changed from ${removed.type} to ${successor.type}, which no codec ` +
          "expresses. This is a reshaping rather than a re-encoding.",
      );
    }
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
  /**
   * Which side of the diff this field is on. Carried structurally rather than
   * inferred back out of `reason`, because grouping these is how a split gets
   * recognised as one thing instead of three.
   */
  side: "removed" | "added";
}

/**
 * A shape the IR deliberately cannot express, named as one problem.
 *
 * Worth separating from the per-field list because the per-field list is
 * misleading here: a provider reading "these three fields are unaccounted for"
 * will look for three Changes, and no three Changes exist. One field becoming
 * two is a single decision, and it is a decision about their own code.
 */
export interface Impasse {
  kind: "split" | "merge";
  schema: string;
  removed: string[];
  added: string[];
  /** What the catalog cannot do, and why it is not an oversight. */
  why: string;
  /** What the provider can actually do, in the order worth trying. */
  options: string[];
}

export interface ProposeOutcome {
  proposals: Proposal[];
  unresolved: Unresolved[];
  /** Unresolved fields that together form a change no op can express. */
  impasses: Impasse[];
  /**
   * Changes the IR can express once somebody decides what a caller should see.
   *
   * Kept apart from `impasses` because the two ask for opposite things. An
   * impasse says no op exists and the provider has to change their approach. A
   * decision says the op exists, the scaffold is written, and one value needs
   * choosing. Reporting the second as the first is how the commonest breaking
   * change in the wild came to be described here as impossible.
   */
  decisions: FoldDecision[];
}

const LIST = (names: readonly string[]): string =>
  names.map((name) => `\`${name}\``).join(" and ");

/**
 * Recognises the two shapes the IR has no op for.
 *
 * Only these two, and only when the counts are unambiguous. Several fields
 * removed beside several added is far more likely to be a handful of renames a
 * judge could not settle than one structural reshaping, and claiming otherwise
 * would send a provider looking for a problem they do not have.
 */
function impassesIn(unresolved: readonly Unresolved[]): Impasse[] {
  const bySchema = new Map<string, Unresolved[]>();
  for (const entry of unresolved) {
    const found = bySchema.get(entry.schema);
    if (found) found.push(entry);
    else bySchema.set(entry.schema, [entry]);
  }

  const impasses: Impasse[] = [];
  for (const [schema, entries] of [...bySchema].sort()) {
    const removed = entries.filter((e) => e.side === "removed").map((e) => e.field);
    const added = entries.filter((e) => e.side === "added").map((e) => e.field);

    const kind =
      removed.length === 1 && added.length > 1
        ? "split"
        : removed.length > 1 && added.length === 1
          ? "merge"
          : undefined;
    if (!kind) continue;

    const one = kind === "split" ? (removed[0] as string) : (added[0] as string);
    const many = kind === "split" ? added : removed;

    impasses.push({
      kind,
      schema,
      removed,
      added,
      why:
        kind === "split"
          ? `\`${one}\` became ${LIST(many)}. No op takes one value apart, because a ` +
            "response has to be put back together for the old caller and there is no " +
            "general way to rejoin what was separated."
          : `${LIST(many)} became \`${one}\`. No op joins values, because joining ` +
            "cannot be undone: the old caller's fields are not recoverable from the " +
            "one that replaced them.",
      options: [
        `Keep serving \`${kind === "split" ? one : one}\` as well. Deriving it ` +
          "alongside the new fields makes this release additive, and then there is " +
          "nothing here to explain.",
        "Declare a `behavior` Change and write the branch yourself. Run " +
          "`invariant check` and copy the lines it gives you into `covers:`, then " +
          '`inv.before("chg_...", { contract })` in your handler tells you which ' +
          "callers predate this. The release warns rather than passes, because " +
          "nothing transforms anything and only your tests can show the branch works.",
        "Stop serving the contracts that would break, by removing them from " +
          "`spec.released`. Honest, and sometimes right, but it is the one option " +
          "that breaks somebody.",
      ],
    });
  }

  return impasses;
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

  // Before anything about fields: did the whole API move? Versioning by URL
  // prefix is how most real APIs express a version, and left undetected it
  // reports every endpoint as removed and every new one as unrelated.
  const move = detectPrefixMove(oldContract, newContract);
  const moved: Proposal[] = move
    ? [
        {
          change: prefixChange(move),
          judge: "rules",
          confidence: move.confidence,
          attention: "explicit",
          notes: [
            `every endpoint under \`/${move.from}\` now lives under \`/${move.to}\`` +
              (move.unexplained > 0
                ? `, and ${move.unexplained} others went that this does not explain`
                : ""),
          ],
        },
      ]
    : [];

  // Endpoints a prefix move already accounts for must not also be reported as
  // retired, or a version bump produces a route change and a retirement for
  // every endpoint it touched.
  const relocated = new Set(
    (move?.moved ?? []).map((entry) => `${entry.method} ${entry.from}`),
  );
  const retired: Proposal[] = retiredEndpoints(oldContract, newContract, relocated).map(
    (endpoint) => ({
      change: retireChange(endpoint),
      judge: "rules" as const,
      confidence: 1,
      // Always explicit. Retiring an endpoint cannot be served to anyone still
      // calling it, and a reviewer should never skim past that.
      attention: "explicit" as const,
      notes: [
        `no transform can serve this: there is no handler left to reach. ` +
          "Old callers get an explicit refusal naming this change, rather than a 404.",
      ],
    }),
  );

  const parameters: Proposal[] = parameterChanges(
    parameterDeltas(oldContract, newContract),
  ).map((change) => ({
    change,
    judge: "rules" as const,
    confidence: 1,
    attention: "normal" as const,
    notes: ["the two documents state this mapping between them"],
  }));

  const altered = alteredProposals(deltas);
  altered.proposals.unshift(...moved, ...retired, ...parameters);
  const unresolved: Unresolved[] = [...altered.unresolved, ...additions(deltas)];

  const questions = deltas.flatMap((delta: SchemaDelta) =>
    questionsFor(delta, options.context),
  );
  if (questions.length === 0) {
    return {
      proposals: altered.proposals,
      unresolved,
      impasses: impassesIn(unresolved),
      decisions: foldDecisions(deltas),
    };
  }

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
        side: "removed",
      });
      return;
    }

    const successor = question.candidates.find(
      (candidate) => candidate.name === result.answer.successor,
    );
    if (!successor) return;

    // Below the threshold is not a draft, it is a guess, and it is reported as
    // an open question instead.
    //
    // This used to mark such answers for attention and draft them anyway,
    // while `eval/ownership.yaml` claimed no draft was ever written from one.
    // Running real APIs showed what the difference cost: on one Adyen pair
    // every alignment came back between 23% and 45% confident, pairing
    // `paymentInstrumentGroupId` with `aggregationLevel` among others, and each
    // one became a `move` that rewrote the predicted document on a guess.
    //
    // A wrong alignment is not a harmless suggestion. It relocates a value, so
    // a merged one would send real data to the wrong field.
    if (result.answer.confidence < threshold) {
      unresolved.push({
        schema: question.schema,
        field: question.removed.name,
        reason:
          `the best guess was \`${successor.name}\` at ` +
          `${(result.answer.confidence * 100).toFixed(0)}% confidence, which is ` +
          "below the threshold. Decide it yourself rather than reviewing a guess.",
        side: "removed",
      });
      return;
    }

    const { ops, notes } = opsFor(question.removed, successor);
    if (ops.length === 0) {
      unresolved.push({
        schema: question.schema,
        field: question.removed.name,
        reason: `paired with \`${successor.name}\`, but ${notes.join("; ") || "no op expresses the difference"}`,
        side: "removed",
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
      attention: "normal",
      notes,
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

  const open = unresolved.filter(
    (entry) => !accountedFor.has(`${entry.schema}.${entry.field}`),
  );

  return {
    proposals,
    unresolved: open,
    impasses: impassesIn(open),
    decisions: foldDecisions(deltas),
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
        side: "added" as const,
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
function alteredProposals(
  deltas: readonly SchemaDelta[],
): Pick<ProposeOutcome, "proposals" | "unresolved"> {
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
          side: "removed",
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
