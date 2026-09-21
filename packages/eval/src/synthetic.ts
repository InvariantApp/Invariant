/**
 * Answers to the decisions a draft leaves open, made up for measuring.
 *
 * A vocabulary decision asks a provider which value an old caller should be
 * shown. Nothing here can know that, and nothing here pretends to: these
 * answers exist to measure reachability, whether every delta would close once
 * somebody answered, which any answer the old contract can name settles as
 * well as the right one. What they cannot measure is whether the answer was
 * right; that is the auto-provider's job, and the false-closure number's.
 *
 * Used only by the proving ground. A synthetic answer never reaches a
 * provider's Change files, and every Change built here says so in its id.
 */
import type { Change, JsonValue } from "@invariant/ir";
import {
  CHOOSE_ONE,
  type Decision,
  decisionChange,
  type FieldShape,
  type FoldDecision,
} from "@invariant/proposer";

type Pair = [string, string];

/**
 * The decision's own draft with every placeholder filled, with an answer a
 * provider could have given.
 */
export function syntheticAnswer(decision: Decision): Change {
  if (decision.kind === "vocabulary") return vocabularyAnswer(decision);
  const drafted = decisionChange(decision);
  const value = valueFor(decision.shape);
  return {
    ...drafted,
    id: `${drafted.id.slice(0, 118)}_synthetic`,
    ops: drafted.ops.map((op) =>
      op.op === "remove" ? { ...op, restore: value } : { ...op, value },
    ) as Change["ops"],
  };
}

/** Values a string of each format has to look like to be one. */
const FORMATTED: Record<string, string> = {
  "date-time": "1970-01-01T00:00:00Z",
  date: "1970-01-01",
  time: "00:00:00Z",
  uuid: "00000000-0000-0000-0000-000000000000",
  uri: "https://example.invalid/",
  url: "https://example.invalid/",
  email: "synthetic@example.invalid",
  ipv4: "192.0.2.0",
  ipv6: "2001:db8::",
};

/** A value the field's declaration accepts, as plain as the declaration allows. */
function valueFor(shape: FieldShape): JsonValue {
  const [first] = shape.enumValues ?? [];
  if (first !== undefined) return first;
  switch (shape.type) {
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return FORMATTED[shape.format ?? ""] ?? "synthetic";
  }
}

/**
 * A vocabulary draft with every placeholder filled: the suggestion where there
 * is one, otherwise a value the old contract names.
 */
function vocabularyAnswer(decision: FoldDecision): Change {
  const drafted = decisionChange(decision);
  const op = drafted.ops[0];
  if (op?.op !== "convert" || op.codec.kind !== "enumMap") return drafted;

  const kept = decision.choices.filter((value) => !decision.lost.includes(value));
  const suggestedPair = new Map(
    decision.suggested.pairs.filter(([, to]) => to !== CHOOSE_ONE),
  );
  const suggestedFold = new Map(
    decision.suggested.fold.filter(([, to]) => to !== CHOOSE_ONE),
  );

  // A gained value a lost one is paired with is that value's new name, so it
  // is no longer folded; each gained value is the new name of one value at most.
  const renamed = new Set(suggestedPair.values());
  const free = decision.gained.filter((value) => !renamed.has(value));
  const pairs: Pair[] = op.codec.pairs.map(([from, to]) => {
    if (to !== CHOOSE_ONE) return [from, to];
    const suggested = suggestedPair.get(from);
    if (suggested !== undefined) return [from, suggested];
    const next = free.shift();
    if (next !== undefined) {
      renamed.add(next);
      return [from, next];
    }
    // Nothing new to call it: the state merged into one the new contract keeps.
    return [from, kept[0] ?? from];
  });

  const target = kept[0] ?? decision.choices[0];
  const fold: Pair[] =
    target === undefined
      ? []
      : decision.gained
          .filter((value) => !renamed.has(value))
          .map((value) => [value, suggestedFold.get(value) ?? target]);

  const { fold: _placeholders, ...codec } = op.codec;
  return {
    ...drafted,
    id: `${drafted.id.slice(0, 118)}_synthetic`,
    ops: [{ ...op, codec: { ...codec, pairs, ...(fold.length > 0 ? { fold } : {}) } }],
  };
}
