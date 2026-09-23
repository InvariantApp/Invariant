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
import { covers, type OpenApiDocument, schemaDirections } from "@invariant-app/contract";
import {
  type Change,
  type JsonValue,
  narrows,
  type Op,
  type ScalarType,
  type Scope,
} from "@invariant-app/ir";
import { type FieldShape, type SchemaDelta, schemaDeltas } from "./candidates.ts";
import { caseCodec, listCodec, timeCodec } from "./codecs.ts";
import { type Decision, decisionChange, type ValueDecision } from "./decisions.ts";
import {
  methodMoveChanges,
  methodMoves,
  operationIdChanges,
  parameterDeltas,
  parameterDrafts,
  retireChange,
  retiredEndpoints,
  statusChanges,
} from "./endpoints.ts";
import type { AlignmentQuestion, Judge, JudgeId } from "./judge.ts";
import { questionsFor } from "./judge.ts";
import { describePrefixMove, detectPrefixMove, prefixChange } from "./prefix.ts";
import { type Restatement, restatements } from "./restate.ts";
import { stemOf, UNIT_SUFFIXES } from "./rules.ts";
import { foldDecisions, retiredValueDecisions, retiredValues } from "./vocabulary.ts";

/**
 * How much a rename inferred from one value going and one arriving is worth.
 * Below the attention threshold on purpose, so a person always sees it.
 */
const RENAME_GUESS_CONFIDENCE = 0.5;

/** Below this, a draft is marked for explicit attention rather than assumed good. */
export const DEFAULT_ATTENTION_THRESHOLD = 0.6;

/**
 * The confidence each judge's answer needs before it becomes a draft, as
 * `eval/ownership.yaml` measured it. Confidence is not comparable between
 * judges: Jev is right on everything it answers from 0.6, while S2 was wrong
 * nine times between 0.6 and 0.8 and never above 0.81, so one floor for both
 * would let the second guess where the first would not.
 */
export const ANSWER_THRESHOLDS: Readonly<Record<JudgeId, number>> = {
  rules: DEFAULT_ATTENTION_THRESHOLD,
  jev: 0.6,
  s2: 0.85,
};

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
  // A list's items and a map's values are named, as a restatement names
  // them, so a Change to a list and one to what it holds keep apart.
  return text
    .replaceAll("*", "items")
    .replaceAll("{}", "values")
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

  const recoded = numericChange
    ? undefined
    : (timeCodec(removed, successor) ?? listCodec(removed, successor));

  if (recoded !== undefined) {
    ops.push({ op: "convert", path: successor.pointer, codec: recoded.codec });
    notes.push(recoded.note);
  } else if (numericChange) {
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

    const recased =
      dropped.length > 0 && gained.length > 0 ? caseCodec(before, after) : undefined;
    if (recased !== undefined) {
      ops.push({ op: "convert", path: successor.pointer, codec: recased.codec });
      notes.push(recased.note);
    } else if (dropped.length > 0 || gained.length > 0) {
      // A one-to-one pairing is only obvious when exactly one value moved.
      // Anything else is left for a person rather than guessed at.
      const pairs: [string, string][] = kept.map((value) => [value, value]);
      if (dropped.length === gained.length && dropped.length === 1) {
        pairs.push([dropped[0] as string, gained[0] as string]);
        notes.push(`\`${dropped[0]}\` became \`${gained[0]}\``);
      } else if (dropped.length > 0 && gained.length === 0) {
        notes.push(
          `${dropped.map((value) => `\`${value}\``).join(", ")} ${dropped.length === 1 ? "is" : "are"} no longer accepted, and nothing arrived in ${dropped.length === 1 ? "its" : "their"} place. ` +
            "Which accepted value an old caller's should become is a decision the shapes do not settle.",
        );
      } else if (dropped.length > 0) {
        notes.push(
          `the allowed values changed (${dropped.join(", ")} went, ${gained.join(", ")} arrived). ` +
            "Pair them up by hand: which old value maps to which new one is not derivable from the shapes.",
        );
      }
      // A mapping that only restates values as themselves explains nothing: a
      // field that gained values and lost none is a fold decision, not this.
      const renames = pairs.some(([from, to]) => from !== to);
      if (renames && pairs.length === before.length) {
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
   * decision says the op exists, the Change is drafted, and one value needs
   * choosing. Reporting the second as the first is how the commonest breaking
   * change in the wild came to be described here as impossible.
   */
  decisions: Decision[];
}

/** What one family of drafting produced. */
type Drafted = Pick<ProposeOutcome, "proposals" | "unresolved"> & {
  decisions: ValueDecision[];
};

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
 * Proposes one Change per schema whose fields a judge could pair up, and a
 * restatement wherever a schema provably says the same values another way.
 */
export async function propose(
  oldContract: Parameters<typeof schemaDeltas>[0],
  newContract: Parameters<typeof schemaDeltas>[1],
  options: ProposeOptions,
): Promise<ProposeOutcome> {
  return restated(
    await drafted(oldContract, newContract, options),
    restatements(oldContract, newContract),
  );
}

/**
 * What a restatement makes unnecessary, taken out, and the restatements added.
 *
 * A place proved to hold nothing old callers were not promised, and to refuse
 * nothing they send, needs no other op, and one written anyway would act on
 * the old statement of a place the restatement then replaces. A restatement
 * under a place another draft moves or rewrites is left out instead: it was
 * proved against the old contract as it stood, and that draft changes it.
 */
function restated(
  outcome: ProposeOutcome,
  found: readonly (readonly Restatement[])[],
): ProposeOutcome {
  if (found.length === 0) return outcome;
  const scopeOf = (change: Change) => {
    const scope = change.scopes?.[0];
    return change.scopes?.length === 1 && scope && "schema" in scope
      ? scope.schema.slice(scope.schema.lastIndexOf("/") + 1)
      : undefined;
  };
  const pathsOf = (op: Op): string[] =>
    "path" in op && typeof op.path === "string"
      ? [op.path]
      : op.op === "move"
        ? [op.from, op.to]
        : [];
  const within = (path: string, place: string) =>
    place === "" || path === place || path.startsWith(`${place}/`);
  const others = [
    ...outcome.proposals.map((proposal) => proposal.change),
    ...outcome.decisions.map(decisionChange),
  ];
  // Left out where another draft acts above the place, moves something
  // across its edge, reaches through a reference under it, or changes a
  // schema the place refers to. PayPal's wallet restated its phone number
  // while a decision made the phone schema's country code always present for
  // old callers, and both cannot hold.
  const allowed = (restatement: Restatement) =>
    !others.some((change) => {
      const scope = scopeOf(change);
      return scope !== undefined && restatement.reaches.has(scope);
    }) &&
    !others.some(
      (change) =>
        scopeOf(change) === restatement.schema &&
        change.ops.some((op) => {
          const paths = pathsOf(op);
          const inside = paths.filter((path) => within(path, restatement.path));
          const above = paths.some(
            (path) => path !== restatement.path && within(restatement.path, path),
          );
          // Through a reference under the place, the draft changes what the
          // reference names, and the restatement would write the place
          // back as referring to that name's old statement.
          const through = inside.some((path) => !restatement.inPlace(path));
          return above || through || (inside.length > 0 && inside.length < paths.length);
        }),
    );
  // For each change, the outermost place allowed; the rest go with it.
  const chosen = [...new Set(found.flatMap((options) => options.find(allowed) ?? []))];
  const kept = chosen.filter(
    (restatement) =>
      !chosen.some(
        (other) =>
          other !== restatement &&
          other.schema === restatement.schema &&
          other.path !== restatement.path &&
          within(restatement.path, other.path),
      ),
  );
  const covered = (change: Change, op: Op) =>
    kept.some(
      (restatement) =>
        scopeOf(change) === restatement.schema &&
        pathsOf(op).length > 0 &&
        pathsOf(op).every(
          (path) => within(path, restatement.path) && restatement.inPlace(path),
        ),
    );
  const proposals = outcome.proposals.flatMap((proposal) => {
    const ops = proposal.change.ops.filter((op) => !covered(proposal.change, op));
    if (ops.length === proposal.change.ops.length) return [proposal];
    return ops.length === 0 ? [] : [{ ...proposal, change: { ...proposal.change, ops } }];
  });
  const decisions = outcome.decisions.filter((decision) => {
    const change = decisionChange(decision);
    return !change.ops.every((op) => covered(change, op));
  });
  const unresolved = outcome.unresolved.filter(
    (entry) =>
      !kept.some(
        (restatement) =>
          restatement.schema === entry.schema &&
          within(`/${entry.field.split(".").join("/")}`, restatement.path),
      ),
  );
  return {
    proposals: [
      ...proposals,
      ...kept.map((restatement) => ({
        change: restatement.change,
        judge: "rules" as const,
        confidence: 1,
        attention: "normal" as const,
        notes: [
          restatement.path === ""
            ? "proved to allow the same values: nothing old callers are sent was ruled out for them, and nothing they send is refused"
            : `proved to allow the same values at ${restatement.path}`,
        ],
      })),
    ],
    unresolved,
    impasses: impassesIn(unresolved),
    decisions,
  };
}

async function drafted(
  oldContract: Parameters<typeof schemaDeltas>[0],
  newContract: Parameters<typeof schemaDeltas>[1],
  options: ProposeOptions,
): Promise<ProposeOutcome> {
  const thresholdFor = (judge: JudgeId) =>
    options.attentionThreshold ?? ANSWER_THRESHOLDS[judge] ?? DEFAULT_ATTENTION_THRESHOLD;
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
            describePrefixMove(move) +
              (move.unexplained > 0
                ? ` ${move.unexplained} others went that this does not explain.`
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
  // Operations that kept their path and changed method, and whatever query
  // parameters went into their new body with them.
  const methodMoved = methodMoves(oldContract, newContract, relocated);
  for (const entry of methodMoved)
    relocated.add(`${entry.from.method} ${entry.from.path}`);
  const methodChanges: Proposal[] = methodMoved.flatMap((entry) =>
    methodMoveChanges(entry).map((change) => ({
      change,
      judge: "rules" as const,
      confidence: 1,
      // The same path under a new method is very likely the same operation,
      // and a person should still say so.
      attention: "explicit" as const,
      notes: [
        `${entry.from.method.toUpperCase()} ${entry.from.path} is gone and the same path is now served by ${entry.to.method.toUpperCase()}` +
          (entry.intoBody.length > 0
            ? `, with ${entry.intoBody.join(", ")} moved from the query string into the body`
            : ""),
      ],
    })),
  );
  const retiredOperations = retiredEndpoints(oldContract, newContract, relocated);
  const retired: Proposal[] = retiredOperations.map((endpoint) => ({
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
  }));

  // A schema no operation reaches has nothing to serve, and the gate reports
  // nothing for it. Plaid documents every webhook payload that way; asking a
  // judge about them costs a question and drafts a Change for nobody. Nor
  // does a body scoped to an operation this proposal retires: an operation
  // whose id lives on at an unrelated path is still gone for its old callers,
  // and a Change to its body would scope to nothing.
  const retiredIds = new Set(retiredOperations.map((endpoint) => endpoint.operationId));
  const deltas = schemaDeltas(oldContract, newContract).filter((delta) => {
    if (
      delta.scope &&
      "operation" in delta.scope &&
      retiredIds.has(delta.scope.operation)
    )
      return false;
    const sides = sidesOfDelta(oldContract, delta);
    return sides.request || sides.response;
  });
  const scopes = new Map(deltas.map((delta) => [delta.schema, scopeOf(delta)]));

  const parameterWork = parameterDrafts(parameterDeltas(oldContract, newContract));
  const parameters: Proposal[] = parameterWork.drafts.map((entry) => ({
    change: entry.change,
    judge: "rules" as const,
    confidence: 1,
    attention: entry.attention,
    notes: entry.notes,
  }));

  const renamedOperations: Proposal[] = operationIdChanges(oldContract, newContract).map(
    (change) => ({
      change,
      judge: "rules" as const,
      confidence: 1,
      attention: "normal" as const,
      notes: [
        "the operation stayed where it was and was renamed; nothing on the wire moves, but generated clients rename the method",
      ],
    }),
  );

  // An operation that answers another success status where the documents say
  // which one replaced which. Not for an operation this proposal retires or
  // moved, whose old place has no counterpart to compare.
  const statuses: Proposal[] = statusChanges(oldContract, newContract).map((change) => {
    const op = change.ops[0] as Extract<Change["ops"][number], { op: "status" }>;
    return {
      change,
      judge: "rules" as const,
      confidence: 1,
      attention: "normal" as const,
      notes: [
        `an old caller is answered ${op.from} wherever the operation now answers ${op.to}, ` +
          `with no body where its contract promised none; check that ${op.from} is what your ` +
          "server answered before",
      ],
    };
  });

  const altered = alteredProposals(deltas, oldContract);
  const added = additions(deltas, oldContract);
  const gone = removals(deltas, oldContract);
  const regrouped = regroupedProposals(deltas, oldContract);
  const valueDecisions = [
    ...altered.decisions,
    ...added.decisions,
    ...gone.decisions,
    ...regrouped.decisions,
  ];
  altered.proposals.unshift(
    ...moved,
    ...methodChanges,
    ...retired,
    ...parameters,
    ...renamedOperations,
    ...statuses,
    ...regrouped.proposals,
    ...added.proposals,
    ...gone.proposals,
  );
  const unresolved: Unresolved[] = [
    ...altered.unresolved,
    ...added.unresolved,
    ...gone.unresolved,
    ...parameterWork.questions,
  ];

  const questions = deltas.flatMap((delta: SchemaDelta) =>
    questionsFor(delta, options.context),
  );
  if (questions.length === 0) {
    return {
      proposals: altered.proposals,
      unresolved,
      impasses: impassesIn(unresolved),
      decisions: [
        ...valueDecisions,
        ...foldDecisions(
          deltas.filter((delta) => sidesOfDelta(oldContract, delta).response),
        ),
        ...retiredValueDecisions(
          deltas.filter((delta) => sidesOfDelta(oldContract, delta).request),
        ),
      ],
    };
  }

  const results = await options.judge.align(questions);
  const proposals: Proposal[] = [...altered.proposals];
  const deltaOf = new Map(deltas.map((delta) => [delta.schema, delta]));

  questions.forEach((question, index) => {
    const result = results[index];
    if (!result || result.answer.abstained || result.answer.successor === null) {
      // Whether it was renamed stays an open question. If it was dropped, the
      // Change is known, and it is drafted beside the question.
      const dropped = droppedDraft(question, deltaOf.get(question.schema), oldContract);
      if (dropped?.decision) valueDecisions.push(dropped.decision);
      if (dropped?.proposal) proposals.push(dropped.proposal);
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
    if (result.answer.confidence < thresholdFor(result.judge)) {
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
        scopes: [
          scopes.get(question.schema) ?? {
            schema: `#/components/schemas/${question.schema}`,
          },
        ],
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
        op.op === "move" ? [`${scopeName(proposal)}.${nameAt(op.to)}`] : [],
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
    decisions: [
      ...valueDecisions,
      ...foldDecisions(
        deltas.filter((delta) => sidesOfDelta(oldContract, delta).response),
      ),
      ...retiredValueDecisions(
        deltas.filter((delta) => sidesOfDelta(oldContract, delta).request),
      ),
    ],
  };
}

/** A field's name, as the candidates name nested fields, from its pointer. */
function nameAt(pointer: string): string {
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .join(".");
}

/** The schema a proposal is scoped to, for matching against an unresolved field. */
function scopeName(proposal: Proposal): string {
  const scope = proposal.change.scopes?.[0];
  if (!scope || !("schema" in scope)) return "";
  return scope.schema.slice(scope.schema.lastIndexOf("/") + 1);
}

/**
 * Which sides of a message a schema appears on in a contract.
 *
 * From the reference graph rather than by listing every place the schema
 * sits: only the direction matters here, and on Stripe, where nearly every
 * object reaches nearly every other through expandable fields, listing the
 * places took minutes per schema.
 */
function sidesOf(
  document: Parameters<typeof schemaDeltas>[0],
  schema: string,
): { request: boolean; response: boolean } {
  return schemaDirections(document, `#/components/schemas/${schema}`);
}

/** What a Change about this delta is scoped to. */
function scopeOf(delta: SchemaDelta): Scope {
  return delta.scope ?? { schema: `#/components/schemas/${delta.schema}` };
}

function sidesOfDelta(
  document: Parameters<typeof schemaDeltas>[0],
  delta: SchemaDelta,
): { request: boolean; response: boolean } {
  return delta.sides ?? sidesOf(document, delta.schema);
}

const fieldSlug = (schema: string, field: string, what: string) =>
  `chg_${slug(schema)}_${slug(field)}_${what}`.slice(0, 128);

/**
 * Fields that moved together out of a wrapper or into a new one, drafted as
 * the moves they are: one Change per wrapper, so a reviewer reads "the
 * revision's attributes were flattened into it" once instead of forty
 * removals and forty unrelated additions. Anything else about a field that
 * moved, a vocabulary or a format, is drafted with its move, as it is for a
 * rename.
 */
function regroupedProposals(
  deltas: readonly SchemaDelta[],
  oldContract: Parameters<typeof schemaDeltas>[0],
): { proposals: Proposal[]; decisions: ValueDecision[] } {
  const proposals: Proposal[] = [];
  const decisions: ValueDecision[] = [];
  for (const delta of deltas) {
    const sides =
      (delta.regrouped ?? []).length > 0 ? sidesOfDelta(oldContract, delta) : NEITHER;
    const byWrapper = new Map<string, NonNullable<SchemaDelta["regrouped"]>>();
    for (const pair of delta.regrouped ?? []) {
      const key = `${pair.kind} ${pair.wrapper}`;
      byWrapper.set(key, [...(byWrapper.get(key) ?? []), pair]);
    }
    for (const pairs of byWrapper.values()) {
      const [first] = pairs;
      if (!first) continue;
      const wrapper = first.wrapper.split("/").filter(Boolean).join(".");
      const ops: Op[] = [];
      const notes: string[] = [
        first.kind === "hoisted"
          ? `the ${pairs.length} fields \`${wrapper}\` held are now where it was, and \`${wrapper}\` is gone: each is the same field one level up, so each is a \`move\``
          : `${pairs.length} fields are now inside a new \`${wrapper}\`: each is the same field one level down, so each is a \`move\``,
      ];
      for (const pair of pairs) {
        const drafted = opsFor(pair.old, pair.new);
        ops.push(...drafted.ops);
        // The first note is the move itself, said once above for all of them.
        notes.push(...drafted.notes.slice(1));
        // Whether it may be left out or null moved with it, at its new place:
        // Datadog's revision attributes came up a level, and its `cve` came
        // up optional where old callers were always given it.
        const presence = presenceOps(pair.old, pair.new, sides);
        ops.push(...presence.ops);
        notes.push(...presence.notes);
        for (const question of presence.questions) {
          decisions.push({
            kind: "value",
            id: fieldSlug(delta.schema, pair.new.name, `default_${question.op.toward}`),
            schema: delta.schema,
            ...(delta.scope ? { scope: delta.scope } : {}),
            field: pair.new.name,
            pointer: pair.new.pointer,
            op: question.op,
            shape: question.shape,
            summary:
              question.op.toward === "old"
                ? `\`${pair.new.name}\` on ${delta.schema} may now be missing or null for callers who were always given it.`
                : `\`${pair.new.name}\` on ${delta.schema} needs a value from callers who could leave it out.`,
            why: question.why,
          });
        }
      }
      const guessed = ops.some(
        (op) =>
          op.op === "convert" &&
          op.codec.kind === "enumMap" &&
          op.codec.pairs.some(([from, to]) => from !== to),
      );
      const confidence = guessed ? RENAME_GUESS_CONFIDENCE : 1;
      proposals.push({
        change: {
          irVersion: 1,
          id: fieldSlug(delta.schema, wrapper, first.kind),
          summary:
            first.kind === "hoisted"
              ? `\`${wrapper}\` was dissolved on ${delta.schema}, and what it held moved up a level.`
              : `Fields on ${delta.schema} moved into a new \`${wrapper}\`.`,
          scopes: [scopeOf(delta)],
          ops,
          provenance: { proposed_by: { judge: "rules", confidence } },
        },
        judge: "rules",
        confidence,
        attention: guessed ? "explicit" : "normal",
        notes,
      });
    }
  }
  return { proposals, decisions };
}

/**
 * Fields that are new and required in the target contract.
 *
 * Drafted where no value has to be invented: the specification gives the
 * field's default, or the schema appears only in responses, where an `add`
 * takes the field out of old callers' responses and its value is never used.
 * Anywhere else, what a caller who predates the field should send is a
 * decision, and it is reported as one.
 */
function additions(
  deltas: readonly SchemaDelta[],
  oldContract: Parameters<typeof schemaDeltas>[0],
): Drafted {
  const proposals: Proposal[] = [];
  const unresolved: Unresolved[] = [];
  const decisions: ValueDecision[] = [];
  for (const delta of deltas) {
    const required = delta.added.filter((field) => field.required);
    if (required.length === 0) continue;
    const sides = sidesOfDelta(oldContract, delta);
    for (const field of required) {
      const value =
        field.default !== undefined ? field.default : !sides.request ? null : undefined;
      if (value === undefined) {
        const why =
          "newly required, and the value a caller who predates it should get is not in the specification";
        if (delta.removed.length > 0) {
          // Beside fields that went, it may be one of them renamed, which is
          // the judge's question and not a value to choose.
          unresolved.push({
            schema: delta.schema,
            field: field.name,
            reason: why,
            side: "added",
          });
        } else {
          decisions.push({
            kind: "value",
            id: fieldSlug(delta.schema, field.name, "added"),
            schema: delta.schema,
            ...(delta.scope ? { scope: delta.scope } : {}),
            field: field.name,
            pointer: field.pointer,
            op: { op: "add" },
            shape: field,
            summary: `\`${field.name}\` is new and required on ${delta.schema}.`,
            why: `\`${field.name}\` is new and required in requests, and the value sent for a caller who predates it is not in the specification.`,
          });
        }
        continue;
      }
      proposals.push({
        change: {
          irVersion: 1,
          id: fieldSlug(delta.schema, field.name, "added"),
          summary: `\`${field.name}\` is new and required on ${delta.schema}.`,
          scopes: [scopeOf(delta)],
          ops: [{ op: "add", path: field.pointer, value }],
          provenance: { proposed_by: { judge: "rules", confidence: 1 } },
        },
        judge: "rules",
        confidence: 1,
        attention: "normal",
        notes: [
          field.default !== undefined
            ? `the specification gives \`${field.name}\` a default, which old callers' requests are given`
            : `${delta.schema} appears only in responses, so the field is taken out of old callers' responses and no value is ever sent`,
        ],
      });
    }
  }
  return { proposals, unresolved, decisions };
}

/**
 * Fields removed from a schema to which nothing was added, so nothing can
 * have replaced them.
 *
 * Drafted as a `remove` where the schema appears only in requests: old
 * callers' requests drop what the server no longer reads, and there is no
 * response to restore a value into. A field removed from a response, that old
 * callers were always given, needs a value only the provider can choose.
 */
function removals(
  deltas: readonly SchemaDelta[],
  oldContract: Parameters<typeof schemaDeltas>[0],
): Drafted {
  const proposals: Proposal[] = [];
  const unresolved: Unresolved[] = [];
  const decisions: ValueDecision[] = [];
  for (const delta of deltas) {
    // A schema replaced under its name, or turned into a choice between
    // others, kept its fields somewhere else: nothing here was dropped.
    if (delta.added.length > 0 || delta.removed.length === 0 || delta.replaced) continue;
    const sides = sidesOfDelta(oldContract, delta);
    for (const field of delta.removed) {
      if (sides.response && field.required) {
        decisions.push({
          kind: "value",
          id: fieldSlug(delta.schema, field.name, "removed"),
          schema: delta.schema,
          ...(delta.scope ? { scope: delta.scope } : {}),
          field: field.name,
          pointer: field.pointer,
          op: { op: "remove" },
          shape: field,
          summary: `\`${field.name}\` was removed from ${delta.schema}.`,
          why: `Old callers were always given \`${field.name}\`, and nothing in the new contract replaces it. What they should be given in its place is not in the specification.`,
        });
        continue;
      }
      // Old callers' responses never promised it, so it is only a request
      // that has to change, and there is nothing to put back.
      if (!sides.request) continue;
      proposals.push({
        change: {
          irVersion: 1,
          id: fieldSlug(delta.schema, field.name, "removed"),
          summary: `\`${field.name}\` was removed from ${delta.schema}.`,
          scopes: [scopeOf(delta)],
          ops: [{ op: "remove", path: field.pointer }],
          provenance: { proposed_by: { judge: "rules", confidence: 1 } },
        },
        judge: "rules",
        confidence: 1,
        attention: "normal",
        notes: [
          sides.response
            ? `nothing was added to ${delta.schema} to replace it, so old callers' requests drop it, and their responses were never promised it`
            : `nothing was added to ${delta.schema} to replace it, and it appears only in requests, so old callers' requests drop it`,
        ],
      });
    }
  }
  return { proposals, unresolved, decisions };
}

/**
 * A field a judge could not pair with anything, drafted as the Change it is
 * if it was dropped rather than renamed. Which it was stays an open question
 * beside the draft.
 *
 * In a response old callers were always given, what they are given in its
 * place is a decision. Otherwise only their requests change: they drop it,
 * and a person confirms that is what happened, so the draft asks for
 * explicit review. A field only responses carried, and never promised,
 * needs nothing.
 */
function droppedDraft(
  question: AlignmentQuestion,
  delta: SchemaDelta | undefined,
  oldContract: Parameters<typeof schemaDeltas>[0],
): { decision?: ValueDecision; proposal?: Proposal } | undefined {
  if (!delta || delta.replaced) return undefined;
  const field = question.removed;
  const sides = sidesOfDelta(oldContract, delta);
  const others = question.candidates.map((candidate) => `\`${candidate.name}\``);
  const unpaired = `no judge would say it became ${others.join(" or ") || "anything"}`;
  if (sides.response && field.required) {
    return {
      decision: {
        kind: "value",
        id: fieldSlug(delta.schema, field.name, "removed"),
        schema: delta.schema,
        ...(delta.scope ? { scope: delta.scope } : {}),
        field: field.name,
        pointer: field.pointer,
        op: { op: "remove" },
        shape: field,
        summary: `\`${field.name}\` was removed from ${delta.schema}.`,
        why: `\`${field.name}\` is gone and ${unpaired}. If it was dropped, old callers were always given it, and what they should be given in its place is not in the specification.`,
      },
    };
  }
  if (!sides.request) return undefined;
  return {
    proposal: {
      change: {
        irVersion: 1,
        id: fieldSlug(delta.schema, field.name, "removed"),
        summary: `\`${field.name}\` was removed from ${delta.schema}.`,
        scopes: [scopeOf(delta)],
        ops: [{ op: "remove", path: field.pointer }],
        provenance: { proposed_by: { judge: "rules", confidence: 1 } },
      },
      judge: "rules",
      confidence: 1,
      attention: "explicit",
      notes: [
        `drafted as dropped from old callers' requests because ${unpaired}. If it was renamed, write the move instead.`,
      ],
    },
  };
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
/**
 * A list's items that stopped accepting values, as the op that leaves those
 * values out of what old callers send: the list is the item's parent.
 */
function droppedFromList(pair: {
  old: FieldShape;
  new: FieldShape;
}): { ops: Op[]; notes: string[] } | undefined {
  if (!pair.old.pointer.endsWith("/*")) return undefined;
  const from = pair.old.enumValues;
  const to = pair.new.enumValues;
  if (!from || !to || to.some((value) => !from.includes(value))) return undefined;
  const went = from.filter((value) => !to.includes(value));
  if (went.length === 0) return undefined;
  return {
    ops: [
      {
        op: "convert",
        path: pair.old.pointer.slice(0, -2),
        codec: { kind: "dropValues", values: went },
      },
    ],
    notes: [
      `${went.length} value${went.length === 1 ? "" : "s"} the list no longer accepts ${went.length === 1 ? "is" : "are"} left out of what old callers send; what they asked for with ${went.length === 1 ? "it" : "them"} is not given`,
    ],
  };
}

/**
 * A list old callers are sent whose items named no values and now name some,
 * or that holds no value twice and gained values, as the op that leaves those
 * values out of it on the way back.
 *
 * Discord's applications listed `event_webhooks_types` as a list of no
 * values at all, and a later release as twelve kinds of event. An old caller
 * was told the list is always empty and has no value of its own to be shown
 * any of the twelve as, so the list it is sent leaves them out, a loss the
 * provider acknowledges. Where the old list named values, which one a new
 * value is shown as is a decision, asked as a fold, unless the list holds no
 * value twice: folded onto a value it may already hold, a new one would show
 * old callers that value twice, so it is left out as well.
 */
function droppedFromResponseList(
  pair: { old: FieldShape; new: FieldShape },
  sides: { request: boolean; response: boolean },
): { ops: Op[]; notes: string[] } | undefined {
  if (!sides.response || !pair.old.pointer.endsWith("/*")) return undefined;
  const from = pair.old.enumValues;
  const to = pair.new.enumValues;
  if (from !== undefined && pair.old.inSet && to !== undefined) {
    const gained = to.filter((value) => !from.includes(value));
    if (gained.length === 0 || from.some((value) => !to.includes(value))) {
      return undefined;
    }
    return {
      ops: [
        {
          op: "convert",
          path: pair.old.pointer.slice(0, -2),
          codec: { kind: "dropValues", values: gained },
        },
      ],
      notes: [
        `the list holds no value twice, so ${gained.length === 1 ? "the value it gained is" : `the ${gained.length} values it gained are`} left out of what old callers are sent rather than shown as one it may already hold, a declared loss to acknowledge`,
      ],
    };
  }
  if (from === undefined || from.length > 0 || !to?.length) return undefined;
  return {
    ops: [
      {
        op: "convert",
        path: pair.old.pointer.slice(0, -2),
        codec: { kind: "dropValues", values: to },
      },
    ],
    notes: [
      `the list named no values and now names ${to.length}; old callers were told it is always empty, so ${to.length === 1 ? "it is" : "they are"} left out of what they are sent, a declared loss to acknowledge`,
    ],
  };
}

/**
 * Whether a field only old callers send only gained values: every value they
 * send is still accepted, so it breaks nobody and asks nothing.
 */
function onlyGrewForRequests(
  pair: { old: FieldShape; new: FieldShape },
  sides: { request: boolean; response: boolean },
): boolean {
  const from = pair.old.enumValues;
  const to = pair.new.enumValues;
  return (
    sides.request &&
    !sides.response &&
    pair.old.type === pair.new.type &&
    from !== undefined &&
    to !== undefined &&
    from.every((value) => to.includes(value))
  );
}

function alteredProposals(
  deltas: readonly SchemaDelta[],
  oldContract: Parameters<typeof schemaDeltas>[0],
): Drafted {
  const proposals: Proposal[] = [];
  const unresolved: Unresolved[] = [];
  const decisions: ValueDecision[] = [];

  for (const delta of deltas) {
    const sides = delta.altered.length > 0 ? sidesOfDelta(oldContract, delta) : undefined;
    for (const pair of delta.altered) {
      const narrowed = narrowOps(pair.old, pair.new, sides ?? NEITHER);
      // A list whose items stopped accepting values old callers may send:
      // those values are left out of the list, and the rest is served.
      const listDrop =
        ((sides ?? NEITHER).request ? droppedFromList(pair) : undefined) ??
        droppedFromResponseList(pair, sides ?? NEITHER);
      // A vocabulary that only shrank needs no pairing, and saying it does
      // would send a reviewer looking for a rename that never happened.
      const shape = listDrop
        ? listDrop
        : narrowed.ops.length > 0
          ? { ops: [], notes: [] }
          : opsFor(pair.old, pair.new);
      // A single value only old callers send that lost values is asked about
      // as one decision, `retiredValueDecisions`, rather than left open.
      const retiredAsked =
        (sides ?? NEITHER).request && retiredValues(pair) !== undefined;
      const reshaped = valuesDiffer(pair.old, pair.new);
      // A vocabulary that grew is asked about as a fold decision, and the
      // rest of what changed about the field is still drafted below.
      if (
        reshaped &&
        shape.ops.length === 0 &&
        narrowed.ops.length === 0 &&
        !foldCovers(pair, sides ?? NEITHER) &&
        !onlyUnstated(pair.old, pair.new) &&
        typesWidened(pair.old, pair.new).type === undefined &&
        !retiredAsked &&
        !onlyGrewForRequests(pair, sides ?? NEITHER)
      ) {
        unresolved.push({
          schema: delta.schema,
          field: pair.old.name,
          reason: shape.notes.join("; ") || "its shape changed in a way no op expresses",
          side: "removed",
        });
        continue;
      }
      const presence = presenceOps(pair.old, pair.new, sides ?? NEITHER);
      for (const question of presence.questions) {
        decisions.push({
          kind: "value",
          id: fieldSlug(delta.schema, pair.old.name, `default_${question.op.toward}`),
          schema: delta.schema,
          ...(delta.scope ? { scope: delta.scope } : {}),
          field: pair.old.name,
          pointer: pair.new.pointer,
          op: question.op,
          shape: question.shape,
          summary:
            question.op.toward === "old"
              ? `\`${pair.old.name}\` on ${delta.schema} may now be missing or null for callers who were always given it.`
              : `\`${pair.old.name}\` on ${delta.schema} needs a value from callers who could leave it out.`,
          why: question.why,
        });
      }
      const widened = widenOps(pair.old, pair.new, sides ?? NEITHER);
      if (widened.unresolved) {
        unresolved.push({
          schema: delta.schema,
          field: pair.old.name,
          reason: widened.unresolved,
          side: "removed",
        });
      }
      const relaxed = restatedBounds(
        pair.old,
        pair.new,
        sides ?? NEITHER,
        relaxOps(pair.old, pair.new, sides ?? NEITHER),
      );
      // A vocabulary that opened into a choice of text is written as that
      // choice, which allows nothing the relaxed field does not, and the
      // compiler proves it before it writes it.
      // A value that may now be one of several types is written as the choice
      // the new contract states, proved to allow nothing more than the types.
      if (relaxed.ops.some((op) => op.op === "relax" && Array.isArray(op.set.type))) {
        relaxed.ops.push({ op: "restate", path: pair.new.pointer });
        relaxed.notes.push(
          `\`${pair.old.name}\` is written as a choice between the types it may now be`,
        );
      }
      if (
        pair.new.anyText &&
        relaxed.ops.some((op) => op.op === "relax" && op.set.enum === null)
      ) {
        relaxed.ops.push({ op: "restate", path: pair.new.pointer });
        relaxed.notes.push(
          `\`${pair.old.name}\` is now written as a choice between the values it named and any other text, which says no more than that it holds any text`,
        );
      }
      if (relaxed.unresolved) {
        unresolved.push({
          schema: delta.schema,
          field: pair.old.name,
          reason: relaxed.unresolved,
          side: "removed",
        });
      }
      const ops = [
        ...shape.ops,
        ...narrowed.ops,
        ...presence.ops,
        ...widened.ops,
        ...relaxed.ops,
      ];
      // Whether a field may be left out or null changed only in the direction
      // no old caller is hurt by, which the gate does not report either.
      if (ops.length === 0) continue;

      // One value that went and one that arrived is a pairing the documents
      // make possible, not one they state: Adyen dropped `alma` and added
      // `wero`, two different payment methods. Drafted, because it is often
      // right, and put in front of a person, because nothing here knows.
      const guessed = ops.some(
        (op) =>
          op.op === "convert" &&
          op.codec.kind === "enumMap" &&
          op.codec.pairs.some(([from, to]) => from !== to),
      );
      const confidence = guessed ? RENAME_GUESS_CONFIDENCE : 1;
      proposals.push({
        change: {
          irVersion: 1,
          id: `chg_${slug(delta.schema)}_${slug(pair.old.name)}`,
          summary: `\`${pair.old.name}\` changed shape on ${delta.schema}.`,
          scopes: [scopeOf(delta)],
          ops,
          provenance: { proposed_by: { judge: "rules", confidence } },
        },
        judge: "rules",
        confidence,
        attention: guessed ? "explicit" : "normal",
        notes: [
          reshaped
            ? "the field kept its name, so only its values moved"
            : "the field kept its name and its values",
          ...shape.notes,
          ...narrowed.notes,
          ...presence.notes,
          ...widened.notes,
          ...relaxed.notes,
          ...(guessed
            ? [
                "a value that went is paired with the one that arrived only because each was the only one; confirm it is the same thing renamed, and not one retired and an unrelated one added",
              ]
            : []),
        ],
      });
    }
  }

  return { proposals, unresolved, decisions };
}

const NEITHER = { request: false, response: false };

/**
 * Bounds on a value that moved, drafted as a `relax` where a response may now
 * carry values old callers were told could not happen. A bound that narrowed
 * on something old callers send is not drafted: nothing can serve it, and it
 * is reported so the provider knows it will turn callers away.
 */
export function relaxOps(
  old: FieldShape,
  next: FieldShape,
  sides: { request: boolean; response: boolean },
): { ops: Op[]; notes: string[]; unresolved?: string } {
  const before = old.bounds ?? {};
  const after = next.bounds ?? {};
  const set: Record<string, JsonValue> = {
    ...unstated(old, next),
    ...typesWidened(old, next),
  };
  for (const keyword of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const value = after[keyword] ?? null;
    if (JSON.stringify(before[keyword] ?? null) !== JSON.stringify(value))
      set[keyword] = value;
  }
  const changed = Object.keys(set);
  if (changed.length === 0) return { ops: [], notes: [] };
  const narrowed = changed.filter((keyword) =>
    narrows(
      keyword,
      keyword === "type" ? old.type : before[keyword],
      set[keyword] as JsonValue,
    ),
  );
  // A bound that narrowed on something old callers send cannot be served, and
  // is reported. It says nothing about the bounds beside it that widened,
  // which a response can still declare: PayPal raises a `maxLength` and adds
  // a `pattern` to the same field in one release.
  const unresolved =
    sides.request && narrowed.length > 0
      ? `\`${old.name}\` now allows less (${narrowed.join(", ")}) in requests, so old callers will be refused for values their contract allowed; no Change can hide that`
      : undefined;
  const widened = changed.filter((keyword) => !narrowed.includes(keyword));
  const declared = unresolved === undefined ? changed : widened;
  if (!sides.response || widened.length === 0) {
    return { ops: [], notes: [], ...(unresolved ? { unresolved } : {}) };
  }
  return {
    ops: [
      {
        op: "relax",
        path: next.pointer,
        set: Object.fromEntries(
          declared.map((keyword) => [keyword, set[keyword]]),
        ) as never,
      },
    ],
    notes: [
      `\`${old.name}\` may now hold values its old bounds ruled out (${widened.join(", ")}); they pass through as the API produced them, a declared loss to acknowledge`,
    ],
    ...(unresolved ? { unresolved } : {}),
  };
}

/**
 * Bounds read one keyword at a time as narrowed on a field old callers send,
 * which read together rule out nothing they did: Discord stated `int32` on a
 * `rate_limit_per_user` it had always bounded to 0 and 21600, and any format
 * that appears reads as a narrowing on its own. Where the new statement is
 * proved to accept every value old callers send, and to send them nothing
 * their contract ruled out, it is drafted as the `restate` it is, which the
 * compiler proves again; otherwise the reading stands.
 */
function restatedBounds(
  old: FieldShape,
  next: FieldShape,
  sides: { request: boolean; response: boolean },
  relaxed: ReturnType<typeof relaxOps>,
): ReturnType<typeof relaxOps> {
  if (
    relaxed.unresolved === undefined ||
    old.type === undefined ||
    old.type !== next.type ||
    old.required !== next.required ||
    old.nullable !== next.nullable ||
    old.enumValues?.join("|") !== next.enumValues?.join("|") ||
    old.enumNull !== next.enumNull ||
    old.unlistedValues !== next.unlistedValues ||
    old.variants?.join("|") !== next.variants?.join("|") ||
    old.ref !== next.ref ||
    JSON.stringify(old.items) !== JSON.stringify(next.items)
  ) {
    return relaxed;
  }
  const before = { document: UNREFERENCED, schema: statedAs(old) };
  const after = { document: UNREFERENCED, schema: statedAs(next) };
  if (
    (sides.request && !covers(after, before).covered) ||
    (sides.response && !covers(before, after).covered)
  ) {
    return relaxed;
  }
  const changed = Object.keys({ ...old.bounds, ...next.bounds }).filter(
    (keyword) =>
      JSON.stringify(old.bounds?.[keyword]) !== JSON.stringify(next.bounds?.[keyword]),
  );
  return {
    ops: [{ op: "restate", path: next.pointer }],
    notes: [
      `\`${old.name}\` is bounded differently (${changed.join(", ")}), and read together its bounds allow every value they did, and nothing more`,
    ],
  };
}

/** A field's value as a schema, as much of it as its shape records. */
function statedAs(field: FieldShape): JsonValue {
  const type = field.type as string;
  const values: JsonValue[] | undefined = field.enumValues
    ? [...field.enumValues, ...(field.enumNull ? [null] : [])]
    : undefined;
  return {
    type: field.nullable ? [type, "null"] : type,
    ...(values ? { enum: values } : {}),
    ...(field.bounds ?? {}),
  };
}

/** The document a shape's schema is read in: it names no other schema, so none. */
const UNREFERENCED = { openapi: "3.1.0", paths: {} } as unknown as OpenApiDocument;

/**
 * A vocabulary that lost values and gained none, on a field only old callers
 * are sent: a state the API no longer reaches, as Apicurio's `DELETED`, or
 * Stripe retiring a status. Nothing is shown to an old caller that its
 * contract does not name, so no pairing is needed and none is guessed at;
 * what it may wait for and never see is drafted as a declared loss.
 *
 * On a field old callers send, the values they send are refused now, and
 * which accepted value each should become is a decision, left to the paths
 * that ask it.
 */
export function narrowOps(
  old: FieldShape,
  next: FieldShape,
  sides: { request: boolean; response: boolean },
): { ops: Op[]; notes: string[] } {
  const before = old.enumValues;
  const after = next.enumValues;
  // An enum that still lists null cannot be restated by `relax`, whose values
  // are text, numbers and booleans; that field is left for a person.
  if (
    !sides.response ||
    sides.request ||
    !after?.length ||
    old.type !== next.type ||
    next.enumNull
  ) {
    return { ops: [], notes: [] };
  }
  // A field that held any text and now names the values it holds, as PayPal's
  // error `location` became `body`, `path` or `query`: every value it can send
  // is one the old contract already allowed, so nothing is lost at all. The
  // differ reports each named value as added, which is how one such field
  // left hundreds of deltas unexplained.
  if (
    before === undefined &&
    old.type === "string" &&
    !old.variants &&
    !old.unlistedValues &&
    !next.unlistedValues
  ) {
    return {
      ops: [{ op: "relax", path: next.pointer, set: { enum: after } }],
      notes: [
        `\`${old.name}\` now names the values it holds (${after.map((value) => `\`${value}\``).join(", ")}), each of them text the old contract already allowed; nothing an old caller is sent changes`,
      ],
    };
  }
  if (!before?.length || after.some((value) => !before.includes(value))) {
    return { ops: [], notes: [] };
  }
  const gone: (string | null)[] = before.filter((value) => !after.includes(value));
  // Null listed in the old enum and not the new: the field is never null any more.
  if (old.enumNull && !next.enumNull) gone.push(null);
  if (gone.length === 0) return { ops: [], notes: [] };
  return {
    ops: [{ op: "relax", path: next.pointer, set: { enum: after } }],
    notes: [
      `\`${old.name}\` is never ${gone.map((value) => `\`${value}\``).join(" or ")} any more; old callers are sent only values they know, but one waiting for ${gone.length === 1 ? "that one" : "those"} will never see it, a declared loss to acknowledge`,
    ],
  };
}

/**
 * A union in a response that can now hold a kind of object old callers do not
 * know, drafted as a `widen` for each one, shown as whatever the old union
 * already allows: its id where the union took a plain string, as Stripe's
 * expandable fields do; null where it could be null; left out where it could
 * be, which for the items of a list means left out of the list. A union that
 * allows none of those has nothing to show, and says so.
 *
 * A union in a request that accepts more breaks nobody, and is left alone.
 */
export function widenOps(
  old: FieldShape,
  next: FieldShape,
  sides: { request: boolean; response: boolean },
): { ops: Op[]; notes: string[]; unresolved?: string } {
  const known = new Set(
    (old.variants ?? []).map((ref) => ref.slice(ref.lastIndexOf("/") + 1)),
  );
  const gained = (next.variants ?? []).filter(
    (ref) => !known.has(ref.slice(ref.lastIndexOf("/") + 1)),
  );
  if (!sides.response || old.variants === undefined || gained.length === 0) {
    return { ops: [], notes: [] };
  }
  // An item of a list is never missing from its place the way a field is,
  // but it can be left out of the list, which is what old callers are shown.
  const item = next.pointer.endsWith("/*");
  const show = old.idBranch
    ? "id"
    : old.nullable
      ? "null"
      : !old.required || item
        ? "absent"
        : undefined;
  const names = gained
    .map((ref) => `\`${ref.slice(ref.lastIndexOf("/") + 1)}\``)
    .join(", ");
  if (show === undefined) {
    return {
      ops: [],
      notes: [],
      unresolved: `\`${old.name}\` can now hold ${names}, and the old union allows no id, no null and no leaving it out, so there is nothing old callers could be shown instead`,
    };
  }
  return {
    ops: gained.map((variant) => ({ op: "widen", path: next.pointer, variant, show })),
    notes: [
      `\`${old.name}\` can now hold ${names}, which old callers never heard of; they are shown ${show === "id" ? "its id, as for a field they did not expand" : show === "null" ? "null" : item ? "the item left out of the list" : "the field left out"} instead, a declared loss to acknowledge`,
    ],
  };
}

/** Whether the values a field can hold changed, apart from null and absence. */
/**
 * Whether the values a field holds are a different kind of thing. A format
 * that moved while the type stayed is a claim about the same values, which
 * `relax` states; counting it here reported PayPal's hundreds of dropped
 * formats as reshapings no op could express.
 */
/**
 * What a field stopped stating about its value: the list of values it held,
 * as Mistral's fine-tuning `model` became any string, or its type, as
 * Twilio's free-form objects lost `type: object`. Either only widens what it
 * may hold. A field that became a union has not stopped stating anything; it
 * states something else, and is not this.
 */
function unstated(old: FieldShape, next: FieldShape): { enum?: null; type?: null } {
  if (
    next.variants !== undefined ||
    next.choice ||
    next.unlistedValues ||
    next.ref !== undefined
  )
    return {};
  // Listed in place, or in a named schema the field referred to: Mistral's
  // `model` was a reference to `FineTuneableModel` and became a plain string.
  const listed = Boolean(old.enumValues?.length) || old.unlistedValues === true;
  return {
    ...(listed && next.enumValues === undefined ? { enum: null } : {}),
    ...(old.type !== undefined && next.type === undefined ? { type: null } : {}),
  };
}

/** Whether all that changed about its values is what it stopped stating. */
/**
 * A value of one type that may now be one of several, the one it was among
 * them: Okta's user schema attributes listed an enum's values as text, and
 * a later release as text or whole numbers.
 */
function typesWidened(old: FieldShape, next: FieldShape): { type?: string[] } {
  if (old.type === undefined || old.types !== undefined || next.types === undefined) {
    return {};
  }
  const kept =
    next.types.includes(old.type) ||
    (old.type === "integer" && next.types.includes("number"));
  return kept ? { type: next.types } : {};
}

function onlyUnstated(old: FieldShape, next: FieldShape): boolean {
  if (Object.keys(unstated(old, next)).length === 0) return false;
  return (
    next.enumValues === undefined && (next.type === old.type || next.type === undefined)
  );
}

function valuesDiffer(a: FieldShape, b: FieldShape): boolean {
  // A vocabulary is a set: the same values listed in another order are the
  // same vocabulary.
  const vocabulary = (field: FieldShape) => field.enumValues?.toSorted().join("|");
  return a.type !== b.type || vocabulary(a) !== vocabulary(b);
}

/**
 * Whether a vocabulary that grew on a field old callers are sent is asked
 * about as a fold decision, so reporting it as inexpressible as well would
 * count one change twice, once as a question and once as a failure.
 */
function foldCovers(
  pair: { old: FieldShape; new: FieldShape },
  sides: { request: boolean; response: boolean },
): boolean {
  const from = pair.old.enumValues;
  const to = pair.new.enumValues;
  if (!sides.response || pair.old.type !== pair.new.type || !from?.length || !to) {
    return false;
  }
  const gained = to.filter((value) => !from.includes(value));
  const lost = from.filter((value) => !to.includes(value));
  // One out and one in is drafted as a rename instead, and what a set gained
  // is left out of it.
  return (
    gained.length > 0 &&
    !(gained.length === 1 && lost.length === 1) &&
    !(pair.old.inSet && lost.length === 0)
  );
}

/**
 * A field that may now be left out or null where it could not before, or the
 * other way round, drafted for each side of the wire the schema reaches where
 * the difference breaks an old caller.
 *
 * Nothing is invented. A null an optional field can no longer carry is sent
 * as the field left out. Anything that needs a value takes the one the
 * specification declares as the field's default, and without one it is a
 * decision for the provider, reported as such.
 */
export function presenceOps(
  old: FieldShape,
  next: FieldShape,
  sides: { request: boolean; response: boolean },
): { ops: Op[]; notes: string[]; questions: PresenceQuestion[] } {
  const ops: Op[] = [];
  const notes: string[] = [];
  const questions: PresenceQuestion[] = [];
  const declared = next.default !== undefined ? next.default : old.default;
  const when = (absent: boolean, nulled: boolean) =>
    absent && nulled ? "absent-or-null" : absent ? "absent" : "null";

  if (sides.response) {
    // Old callers were promised the field, or a value in it.
    const absent = old.required && !next.required;
    const nulled = !old.nullable && next.nullable;
    if (absent || (nulled && old.required)) {
      if (declared === undefined) {
        questions.push({
          op: { op: "default", when: when(absent, nulled), toward: "old" },
          shape: old,
          why: `Old callers were always given \`${old.name}\`, and it may now be ${absent && nulled ? "missing or null" : absent ? "missing" : "null"}. What they should be shown in its place is not in the specification.`,
        });
      } else {
        ops.push({
          op: "default",
          path: next.pointer,
          value: declared,
          when: when(absent, nulled),
          toward: "old",
        });
        notes.push(
          `old callers are given the declared default ${JSON.stringify(declared)} where \`${old.name}\` is now left out or null`,
        );
      }
    } else if (nulled) {
      ops.push({ op: "dropNull", path: next.pointer, toward: "old" });
      notes.push(
        `\`${old.name}\` can now be null, and old callers, who could always be sent it left out, are sent it that way`,
      );
    }
  }

  if (sides.request && !sides.response && !old.nullable && next.nullable) {
    // Nothing an old caller sends changes, and there is no response to keep a
    // null out of, so this only records the change.
    ops.push({ op: "dropNull", path: next.pointer, toward: "old" });
    notes.push(`\`${old.name}\` now accepts null, which no old caller sends`);
  }

  if (sides.request) {
    // Old callers may leave out, or send null in, what the server now needs.
    const absent = !old.required && next.required;
    const nulled = old.nullable && !next.nullable;
    if (absent || (nulled && next.required)) {
      if (next.default === undefined) {
        questions.push({
          op: { op: "default", when: when(absent, nulled), toward: "new" },
          shape: next,
          why: `\`${old.name}\` is now required in requests${nulled ? " and may not be null" : ""}, and the value sent for a caller who predates that is not in the specification.`,
        });
      } else {
        ops.push({
          op: "default",
          path: next.pointer,
          value: next.default,
          when: when(absent, nulled),
          toward: "new",
        });
        notes.push(
          `old callers who leave \`${old.name}\` out${nulled ? " or send null" : ""} are given the specification's default ${JSON.stringify(next.default)}`,
        );
      }
    } else if (nulled) {
      if (old.required) {
        questions.push({
          op: { op: "default", when: "null", toward: "new" },
          shape: next,
          why: `\`${old.name}\` can no longer be null, and old callers had to send it, so leaving it out is not something they ever chose. The value sent in place of their null is not in the specification.`,
        });
      } else {
        ops.push({ op: "dropNull", path: next.pointer, toward: "new" });
        notes.push(
          `\`${old.name}\` can no longer be null, so a null from an old caller is sent as the field left out`,
        );
      }
    }
  }

  return { ops, notes, questions };
}

/** A presence change that needs a value nobody has given. */
export interface PresenceQuestion {
  op: Extract<ValueDecision["op"], { op: "default" }>;
  shape: FieldShape;
  why: string;
}

export { UNIT_SUFFIXES };
