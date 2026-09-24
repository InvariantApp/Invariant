/**
 * Labelled cases mined from real deltas.
 *
 * The questions are the ones the product really asks: every pair in the
 * pinned corpus is compared by the proposer's own `schemaDeltas`, and each
 * removed field beside added ones becomes the alignment question drafting
 * would put to a judge, exactly as drafting would put it. Nothing about the
 * question is written for the corpus.
 *
 * The label is not in the specification. A provider who renames a field
 * almost never says so in the release that removes the old one: the note
 * pointing at the successor was written releases earlier, when the successor
 * was added, so by the time the question is asked it names a field that is
 * not a candidate. Searching all 1,553 pairs of the corpus for a note that
 * names a candidate found none, and three retirements that name nothing.
 *
 * So each question is labelled by a reader with more to go on than the
 * judge: both versions of the schema whole, every field kept as well as those
 * removed and added, the operations that carry it, and the two documents to
 * search. The readers are Claude agents, which share a family with S2, so
 * S2's agreement with them is the number most likely to flatter. A reader who cannot tell says so, and the question is left out
 * rather than guessed, since a wrong label charges a judge with an error it
 * did not make. Every label keeps its reason, so it can be argued with.
 */
import type { AlignmentQuestion, FieldShape } from "@invariant-app/proposer";
import { stringify } from "yaml";
import type { CaseTag, EvalCase } from "./corpus.ts";

/** Where a question came from: which API, and the two documents compared. */
export interface MinedOrigin {
  api: string;
  provider: string;
  from: string;
  to: string;
  /** The newer document's pinned URL, which the case's source names. */
  url: string;
}

/** A real question, before anyone has answered it. */
export interface MinedQuestion {
  id: string;
  origin: MinedOrigin;
  question: AlignmentQuestion;
  /** What a reader needs beyond the question: the schema's fields on each side. */
  context: { oldFields: string[]; newFields: string[] };
}

/** A reader's answer to a mined question. */
export interface MinedLabel {
  id: string;
  /** The candidate that replaced the removed field, null for none, or unsure. */
  successor: string | null | { unsure: true };
  rationale: string;
}

const UNIT =
  /(?:_|(?<=[a-z]))(?:ms|millis|seconds|secs|minutes|hours|days|cents|bytes|kb|mb|percent|pct)$/i;

/** Words of a name, for telling a decoy that shares one with the removed field. */
function words(name: string): Set<string> {
  return new Set(
    name
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4),
  );
}

/**
 * The families a case belongs to, by rule, so a family's precision is never
 * a matter of how its author felt about the case.
 */
export function familiesOf(
  question: AlignmentQuestion,
  successor: string | null,
): CaseTag[] {
  const tags = new Set<CaseTag>();
  const removed = question.removed;
  const chosen = question.candidates.find((candidate) => candidate.name === successor);
  if (!chosen) {
    tags.add("removal");
  } else if (chosen.type === "object" && removed.type !== "object") {
    tags.add("nesting");
  } else if (chosen.type !== removed.type) {
    tags.add("type-change");
  } else {
    tags.add("rename");
  }
  if (removed.enumValues !== undefined || chosen?.enumValues !== undefined)
    tags.add("enum");
  if (UNIT.test(removed.name) || (chosen && UNIT.test(chosen.name))) tags.add("unit");
  const own = words(removed.name);
  const others = question.candidates.filter((candidate) => candidate.name !== successor);
  if (others.some((other) => [...words(other.name)].some((word) => own.has(word)))) {
    tags.add("decoy");
  }
  if (
    question.candidates.filter((candidate) => candidate.type === removed.type).length >= 2
  ) {
    tags.add("ambiguous");
  }
  return [...tags];
}

/** A readable, stable id: the API, the schema and the removed field. */
export function caseIdOf(api: string, schema: string, removed: string): string {
  const slug = (text: string) =>
    text
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
  const host = api.split(":")[0] ?? api;
  const provider = host.split(".").at(-2) ?? host;
  return `mined_${slug(provider)}_${slug(schema)}_${slug(removed)}`.slice(0, 120);
}

/** A pair's questions, named, with the first of any id kept. */
export function mineQuestions(
  questions: readonly AlignmentQuestion[],
  origin: MinedOrigin,
  fieldsOf: (schema: string) => { oldFields: string[]; newFields: string[] },
): MinedQuestion[] {
  const seen = new Set<string>();
  const out: MinedQuestion[] = [];
  for (const question of questions) {
    const id = caseIdOf(origin.api, question.schema, question.removed.pointer);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, origin, question, context: fieldsOf(question.schema) });
  }
  return out;
}

/**
 * One question per provider, removed field and set of candidates.
 *
 * PayPal repeats one error schema per operation, so a single change to it
 * (`issues` gone, `details` added) is asked 258 times under 258 names. Counted
 * once each, one change would outweigh every other provider in the corpus.
 */
export function distinct(questions: readonly MinedQuestion[]): MinedQuestion[] {
  const seen = new Set<string>();
  return questions.filter((mined) => {
    const key = JSON.stringify([
      mined.origin.provider,
      mined.question.removed.name,
      mined.question.candidates.map((candidate) => candidate.name).sort(),
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The labelled questions as cases, leaving out every one the reader could not settle. */
export function labelled(
  questions: readonly MinedQuestion[],
  labels: readonly MinedLabel[],
): EvalCase[] {
  const byId = new Map(labels.map((label) => [label.id, label]));
  const cases: EvalCase[] = [];
  for (const mined of questions) {
    const label = byId.get(mined.id);
    if (!label || (label.successor !== null && typeof label.successor !== "string")) {
      continue;
    }
    const successor = label.successor;
    if (
      successor !== null &&
      !mined.question.candidates.some((candidate) => candidate.name === successor)
    ) {
      throw new Error(`${mined.id}: "${successor}" is not one of its candidates`);
    }
    const { origin, question } = mined;
    cases.push({
      id: mined.id,
      source: `mined:${origin.url}`,
      tags: familiesOf(question, successor),
      schema: question.schema,
      operations: question.operations.slice(0, 3),
      removed: question.removed,
      candidates: question.candidates,
      successor,
      rationale: `${origin.api} ${origin.from} to ${origin.to}. ${label.rationale}`,
    });
  }
  return cases;
}

/** A field as the corpus files write one. */
function written(shape: FieldShape): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      name: shape.name,
      type: shape.type,
      format: shape.format,
      enum: shape.enumValues,
      description: shape.description,
      required: shape.required || undefined,
      nullable: shape.nullable || undefined,
    }).filter(([, value]) => value !== undefined),
  );
}

/** Mined cases as a corpus file, with a header saying where they came from. */
export function renderMined(cases: readonly EvalCase[]): string {
  const header = [
    "# Mined from the pinned corpus's real deltas by eval/mine.mts. Generated: do",
    "# not edit by hand. The questions are the proposer's own on real pairs; the",
    "# labels, with their reasons, are in eval/mined/labels.json.",
    "",
  ].join("\n");
  const entries = cases.map((found) => ({
    id: found.id,
    source: found.source,
    tags: found.tags,
    schema: found.schema,
    operations: found.operations,
    removed: written(found.removed),
    candidates: found.candidates.map(written),
    successor: found.successor,
    rationale: found.rationale,
  }));
  return `${header}${stringify(entries, { lineWidth: 0 })}`;
}
