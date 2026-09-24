/**
 * A response field whose vocabulary grew, and the one decision that fixes it.
 *
 * This is the commonest breaking change in the wild. Across 686 published
 * version pairs it is the largest single category, and it is two thirds of
 * everything Stripe does to its callers: a response enum gains a value that a
 * caller written against the old contract has never heard of.
 *
 * It used to be reported as inexpressible. It is not. `enumMap` takes a `fold`
 * that says which existing value an old caller should be shown instead, and the
 * runtime applies it on the way out. What cannot be read off the documents is
 * *which* existing value, because that is a judgement about meaning rather than
 * a fact about shape.
 *
 * So this file does not guess. It names the decision, lists exactly which
 * values are available to fold onto, and writes the lines out so that making
 * the decision is editing one placeholder rather than learning a format. The
 * release stays blocked until someone does, which is the point: the provider
 * makes the change and the caller pays for it, so the provider is the one who
 * should have to say what the caller sees.
 */
import { CHOOSE_ONE, type Change } from "@invariant-app/ir";
import type { SchemaDelta } from "./candidates.ts";
import { caseCodec } from "./codecs.ts";

export interface FoldDecision {
  kind: "vocabulary";
  schema: string;
  /** What a Change making this decision is scoped to, when it is not the named schema. */
  scope?: SchemaDelta["scope"];
  field: string;
  pointer: string;
  /** Values the new contract can produce and the old one cannot name. */
  gained: string[];
  /** Values the old contract names that the new one no longer does. */
  lost: string[];
  /**
   * What an answer may name. For a response field, the values the old
   * contract names, which each gained value folds onto. For `request`, the
   * values the new contract accepts, which each lost value is sent as.
   */
  choices: string[];
  /**
   * The likeliest choice for each gained value, and for each lost value the
   * likeliest new one, ranked by what their names share. A suggestion, never
   * an answer: the draft built from it is marked for a person, and a fold is
   * a declared loss the gate will not pass until someone acknowledges it.
   */
  suggested: { fold: [string, string][]; pairs: [string, string][] };
  /** Why this is a decision rather than something derivable. */
  why: string;
  /**
   * `request` for a field old callers send that no longer accepts some of
   * their values: each value that went is sent as one the API still accepts,
   * and nothing is folded, since an old caller is never sent a value by it.
   * `gained` then lists what a value that went may have been renamed to.
   */
  direction?: "request";
}

/** The parts of a value's name: `CRA_MONITORING_ERROR` is cra, monitoring, error. */
function tokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 0);
}

/**
 * Values that exist to catch what nothing else names. Deliberately not
 * `failed` or `invalid`: those mean something, and showing a payment that is
 * still processing as failed would be worse than asking.
 */
const CATCH_ALLS = new Set([
  "other",
  "unknown",
  "unspecified",
  "generic",
  "api_error",
  "error",
]);

/** Placed where nothing suggests an answer, so the draft cannot pass without one. */
export { CHOOSE_ONE };

/**
 * The choice whose name most resembles `value`, or nothing when nothing does.
 *
 * Shared name parts count most, then a shared start of three characters, with
 * a catch-all breaking a tie. With no resemblance at all, a catch-all is
 * suggested if there is one, and otherwise nothing: a guess with no evidence
 * behind it is worse than a question.
 */
export function likeliest(value: string, choices: readonly string[]): string | undefined {
  const mine = new Set(tokens(value));
  let best: { choice: string; score: number } | undefined;
  for (const choice of choices) {
    const theirs = tokens(choice);
    const shared = theirs.filter((token) => mine.has(token)).length;
    let prefix = 0;
    const a = value.toLowerCase();
    const b = choice.toLowerCase();
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
    const evidence = shared * 4 + (prefix >= 3 ? 2 : 0);
    if (evidence === 0) continue;
    const score = evidence + (CATCH_ALLS.has(choice.toLowerCase()) ? 1 : 0);
    if (!best || score > best.score) best = { choice, score };
  }
  return best?.choice ?? choices.find((choice) => CATCH_ALLS.has(choice.toLowerCase()));
}

/**
 * One decision per response field whose vocabulary changed in a way the
 * documents do not settle: it gained values, with or without losing some.
 *
 * Gained values need a fold: which value the old caller is shown instead.
 * Lost values need a pair: which new value the old one became. Both are
 * questions about meaning, asked once per field, with the likeliest answer
 * filled in for a person to check.
 */
export function foldDecisions(deltas: readonly SchemaDelta[]): FoldDecision[] {
  const out: FoldDecision[] = [];

  for (const delta of deltas) {
    for (const { old: before, new: after } of delta.altered) {
      const from = before.enumValues;
      const to = after.enumValues;
      if (!from || !to || from.length === 0) continue;

      const gained = to.filter((value) => !from.includes(value));
      const lost = from.filter((value) => !to.includes(value));
      if (gained.length === 0) continue;
      // One out and one in is drafted as a rename elsewhere, for a person to
      // confirm; asking again here would ask twice.
      if (lost.length === 1 && gained.length === 1) continue;
      // Every value rewritten in another case is drafted as `stringCase`,
      // which already shows old callers their own spelling. Adyen's account
      // holder `status` went from `Active` to `active` and Twilio's operator
      // types from `pii_extract` to `pii-extract`; asked here as well, the
      // answer's map ran after the case codec, met values it had already
      // rewritten, and did not apply, so neither pair could be measured.
      if (lost.length > 0 && caseCodec(from, to) !== undefined) continue;
      // A list that holds no value twice only grew: what it gained is left
      // out of what old callers are sent, since folded onto a value the list
      // may already hold it would show them that value twice.
      if (before.inSet && lost.length === 0) continue;

      const kept = from.filter((value) => to.includes(value));
      const pairs: [string, string][] = lost.map((value) => [
        value,
        likeliest(value, gained) ?? likeliest(value, kept) ?? CHOOSE_ONE,
      ]);
      const pairedTo = new Set(pairs.map(([, target]) => target));
      // A gained value some lost value became is that value's new name, not
      // something to fold.
      const toFold = gained.filter((value) => !pairedTo.has(value));
      const fold: [string, string][] = toFold.map((value) => [
        value,
        likeliest(value, kept.length > 0 ? kept : from) ?? CHOOSE_ONE,
      ]);

      out.push({
        kind: "vocabulary",
        schema: delta.schema,
        ...(delta.scope ? { scope: delta.scope } : {}),
        field: before.name,
        pointer: before.pointer,
        gained,
        lost,
        choices: from,
        suggested: { fold, pairs },
        why:
          `\`${before.name}\` can now answer with ` +
          `${gained.map((value) => `\`${value}\``).join(", ")}, which the old ` +
          "contract never named" +
          (lost.length > 0
            ? `, and no longer with ${lost.map((value) => `\`${value}\``).join(", ")}`
            : "") +
          ". A caller that switches on this field has no branch for a new value. " +
          "Which of its own values it should be shown instead is a decision about " +
          "meaning, so it is not derivable from the two documents.",
      });
    }
  }

  return out;
}

/**
 * The single values a field only requests carry that no longer accepts some
 * of what old callers send: one decision per field, which value the API
 * still accepts each that went is sent as.
 *
 * Adyen, Plaid and PayPal each retired request values this way, a hundred
 * and twenty-odd places left as open questions because pairing them is a
 * judgement about meaning. It still is, and it is asked as one, with the
 * likeliest remaining value suggested: an old caller's request is sent on as
 * the nearest thing the API still accepts, rather than refused.
 *
 * Wherever old callers send the field. Where they are also answered with it,
 * the value an old one is sent as is shown to them as itself, since the API
 * no longer produces the one that went. A list's items are not asked about,
 * since `dropValues` serves those.
 *
 * Values that arrived as others went are asked about only where old callers
 * are never answered with the field (`responds` says where they are): Plaid's
 * processor token request stopped taking `paynote` as two new processors
 * arrived, and an old caller never sends either, so which value `paynote` is
 * sent as, one that stayed or one that arrived, is the same question. Where
 * they are answered with it, what arrived needs a fold as well, which
 * `foldDecisions` asks together with the pairing.
 */
export function retiredValueDecisions(
  deltas: readonly SchemaDelta[],
  responds: (delta: SchemaDelta) => boolean = () => true,
): FoldDecision[] {
  const out: FoldDecision[] = [];
  for (const delta of deltas) {
    const onlySent = !responds(delta);
    for (const pair of delta.altered) {
      const lost = retiredValues(pair, onlySent);
      if (lost === undefined) continue;
      const decision = retiredValueDecision({
        schema: delta.schema,
        ...(delta.scope ? { scope: delta.scope } : {}),
        field: pair.old.name,
        pointer: pair.old.pointer,
        from: pair.old.enumValues as string[],
        to: pair.new.enumValues as string[],
      });
      if (decision !== undefined) out.push(decision);
    }
  }
  return out;
}

/**
 * The decision for one value that no longer accepts some of what old callers
 * send, whether a body field or a parameter: which value each that went is
 * sent as, among the ones the API accepts now. Nothing where it accepts none.
 */
export function retiredValueDecision(field: {
  schema: string;
  scope?: SchemaDelta["scope"];
  field: string;
  pointer: string;
  /** The values the old contract names. */
  from: readonly string[];
  /** The values the new contract names. */
  to: readonly string[];
}): FoldDecision | undefined {
  const lost = field.from.filter((value) => !field.to.includes(value));
  const gained = field.to.filter((value) => !field.from.includes(value));
  const kept = field.from.filter((value) => field.to.includes(value));
  if (lost.length === 0 || field.to.length === 0) return undefined;
  return {
    kind: "vocabulary",
    direction: "request",
    schema: field.schema,
    ...(field.scope ? { scope: field.scope } : {}),
    field: field.field,
    pointer: field.pointer,
    gained,
    lost,
    choices: [...field.to],
    suggested: {
      fold: [],
      pairs: lost.map((value) => [
        value,
        likeliest(value, gained) ?? likeliest(value, kept) ?? CHOOSE_ONE,
      ]),
    },
    why:
      `\`${field.field}\` no longer accepts ` +
      `${lost.map((value) => `\`${value}\``).join(", ")}, which old callers may ` +
      "send" +
      (gained.length > 0
        ? `, and now accepts ${gained.map((value) => `\`${value}\``).join(", ")}, which they never send`
        : ", and nothing arrived in place of it") +
      ". Which value the API still accepts an old caller's should be sent as " +
      "is a decision about meaning, so it is not derivable from the two documents.",
  };
}

/**
 * The values a single field's vocabulary lost, or nothing where that is not
 * what happened. A list's items are left to `dropValues`.
 *
 * With `withGained`, for a field old callers only send, values may have
 * arrived as well; unless exactly one went as one arrived, which is drafted
 * as a rename for a person to confirm, or every value was recased, which
 * `stringCase` serves.
 */
export function retiredValues(
  pair: {
    old: { pointer: string; enumValues?: string[] | undefined };
    new: { enumValues?: string[] | undefined };
  },
  withGained = false,
): string[] | undefined {
  const from = pair.old.enumValues;
  const to = pair.new.enumValues;
  if (!from || !to || pair.old.pointer.endsWith("/*")) return undefined;
  const lost = from.filter((value) => !to.includes(value));
  const gained = to.filter((value) => !from.includes(value));
  if (lost.length === 0) return undefined;
  if (gained.length > 0) {
    if (!withGained) return undefined;
    if (lost.length === 1 && gained.length === 1) return undefined;
    if (caseCodec(from, to) !== undefined) return undefined;
  }
  return lost;
}

/**
 * A vocabulary decision as a Change file, every answer left as a placeholder.
 *
 * The suggestions go beside it, never into it: the gate refuses any Change
 * still carrying the placeholder, whatever the provider has set it to do
 * about declared loss, so a suggestion can never pass as a decision on its own.
 */
export function vocabularyChange(decision: FoldDecision): Change {
  const slug = (text: string) =>
    text
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  // The old values that stayed, each sent and shown as itself.
  const kept =
    decision.direction === "request"
      ? decision.choices.filter((value) => !decision.gained.includes(value))
      : decision.choices.filter((value) => !decision.lost.includes(value));
  return {
    irVersion: 1,
    id: `chg_${slug(decision.schema)}_${slug(decision.field)}_vocabulary`.slice(0, 120),
    summary:
      decision.direction === "request"
        ? `\`${decision.field}\` on ${decision.schema} no longer accepts values old callers may send.`
        : `\`${decision.field}\` on ${decision.schema} can answer with values old callers never saw.`,
    scopes: [decision.scope ?? { schema: `#/components/schemas/${decision.schema}` }],
    ops: [
      {
        op: "convert",
        path: decision.pointer,
        codec: {
          kind: "enumMap",
          pairs: [
            ...kept.map((value) => [value, value] as [string, string]),
            ...decision.lost.map((value) => [value, CHOOSE_ONE] as [string, string]),
          ],
          ...(decision.gained.length > 0 && decision.direction !== "request"
            ? {
                fold: decision.suggested.fold.map(
                  ([value]) => [value, CHOOSE_ONE] as [string, string],
                ),
              }
            : {}),
        },
      },
    ],
  };
}
