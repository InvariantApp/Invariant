/**
 * What a draft cannot settle, asked as a question with the Change already
 * written around it.
 *
 * Two kinds. A vocabulary decision asks which value an old caller should be
 * shown when a field's values changed. A value decision asks what an old
 * caller should send, or be given, where the specification has nothing to
 * say: a field that became required with no default, one a response stopped
 * carrying, one that may now be missing. Either way the op exists and the
 * draft is complete except for the answer, which is left as the placeholder
 * the gate refuses.
 */
import { CHOOSE_ONE, type Change, type Op, type Scope } from "@invariant/ir";
import type { FieldShape } from "./candidates.ts";
import { type FoldDecision, vocabularyChange } from "./vocabulary.ts";

type Presence = Extract<Op, { op: "default" }>;

export interface ValueDecision {
  kind: "value";
  /** The id the drafted Change carries. */
  id: string;
  schema: string;
  /** What a Change making this decision is scoped to, when it is not the named schema. */
  scope?: Scope;
  field: string;
  pointer: string;
  /** The op the answer completes; everything about it but the value is known. */
  op: { op: "add" } | { op: "remove" } | Pick<Presence, "op" | "when" | "toward">;
  /**
   * The field as the side the value is given to declares it, which an answer
   * has to satisfy: the old contract's for a value shown to an old caller,
   * the new one's for a value sent on their behalf.
   */
  shape: FieldShape;
  summary: string;
  /** Why this is a decision rather than something derivable. */
  why: string;
}

export type Decision = FoldDecision | ValueDecision;

/** A decision as a Change file, with the placeholder where the answer goes. */
export function decisionChange(decision: Decision): Change {
  if (decision.kind === "vocabulary") return vocabularyChange(decision);
  const path = decision.pointer;
  const op: Op =
    decision.op.op === "add"
      ? { op: "add", path, value: CHOOSE_ONE }
      : decision.op.op === "remove"
        ? { op: "remove", path, restore: CHOOSE_ONE }
        : { ...decision.op, path, value: CHOOSE_ONE };
  return {
    irVersion: 1,
    id: decision.id,
    summary: decision.summary,
    scopes: [decision.scope ?? { schema: `#/components/schemas/${decision.schema}` }],
    ops: [op],
  };
}

/** What an answer to a value decision has to be, in words. */
export function describeShape(shape: FieldShape): string {
  if (shape.enumValues && shape.enumValues.length > 0) {
    return `one of ${shape.enumValues.join(", ")}`;
  }
  const type = shape.type ?? "any JSON value";
  const article = /^[aeiou]/.test(type) ? "an" : "a";
  const base = shape.type === undefined ? type : `${article} ${type}`;
  const format = shape.format ? ` in ${shape.format} format` : "";
  return `${base}${format}${shape.nullable ? ", or null" : ""}`;
}
