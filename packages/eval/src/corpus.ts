/**
 * The labelled corpus.
 *
 * Every case is one removed field, the candidates that replaced it or did not,
 * and the answer a careful person would give. The point of the file format is
 * that a case is cheap to add: any production disagreement, or any proposal a
 * provider edited before merging, becomes a new case with two minutes of work.
 *
 * Tags matter as much as the labels. Aggregate accuracy on easy renames tells
 * you nothing about whether a judge can be trusted on the ambiguous ones, so
 * every metric is reported per tag as well as overall.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AlignmentQuestion, FieldShape } from "@invariant/proposer";
import { parse as parseYaml } from "yaml";

export type CaseTag =
  | "rename"
  | "unit"
  | "nesting"
  | "enum"
  | "type-change"
  | "split-merge"
  | "removal"
  | "ambiguous"
  | "adversarial"
  | "decoy";

export interface EvalCase {
  id: string;
  /**
   * Where this case came from.
   *
   * `mined:<url>` for a change a real provider actually shipped, absent for one
   * written for this corpus. Kept because the two measure different things: a
   * corpus somebody wrote measures the questions they thought to ask, and only
   * the mined half can say anything about the work as it really arrives. The
   * report separates them rather than quoting one number.
   */
  source?: string;
  tags: CaseTag[];
  schema: string;
  operations: string[];
  removed: FieldShape;
  candidates: FieldShape[];
  context?: string;
  /** The candidate that replaced it, or null when nothing did. */
  successor: string | null;
  /** Why, in a sentence, so a disagreement can be argued with. */
  rationale: string;
}

export class CorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorpusError";
  }
}

function field(raw: unknown, where: string): FieldShape {
  if (typeof raw !== "object" || raw === null) {
    throw new CorpusError(`${where} must be an object`);
  }
  const value = raw as Record<string, unknown>;
  const name = value["name"];
  if (typeof name !== "string") throw new CorpusError(`${where}.name must be a string`);

  return {
    name,
    pointer: `/${name}`,
    type: typeof value["type"] === "string" ? value["type"] : undefined,
    format: typeof value["format"] === "string" ? value["format"] : undefined,
    enumValues: Array.isArray(value["enum"])
      ? (value["enum"] as unknown[]).filter((v): v is string => typeof v === "string")
      : undefined,
    description:
      typeof value["description"] === "string" ? value["description"] : undefined,
    required: value["required"] === true,
    nullable: value["nullable"] === true,
  };
}

function parseCase(raw: unknown, file: string): EvalCase {
  if (typeof raw !== "object" || raw === null) {
    throw new CorpusError(`${file} is not a mapping`);
  }
  const value = raw as Record<string, unknown>;

  const id = value["id"];
  if (typeof id !== "string") throw new CorpusError(`${file} needs a string id`);

  const candidates = Array.isArray(value["candidates"])
    ? value["candidates"].map((entry, index) =>
        field(entry, `${file}.candidates[${index}]`),
      )
    : [];

  const successor = value["successor"];
  if (successor !== null && typeof successor !== "string") {
    throw new CorpusError(`${file}.successor must be a candidate name or null`);
  }
  if (
    successor !== null &&
    !candidates.some((candidate) => candidate.name === successor)
  ) {
    // A label naming a field that is not on offer would make the case
    // unanswerable, and would quietly depress every judge's score.
    throw new CorpusError(
      `${file}.successor "${successor}" is not one of the candidates`,
    );
  }

  return {
    id,
    ...(typeof value["source"] === "string" ? { source: value["source"] } : {}),
    tags: Array.isArray(value["tags"]) ? (value["tags"] as CaseTag[]) : [],
    schema: typeof value["schema"] === "string" ? value["schema"] : "Unknown",
    operations: Array.isArray(value["operations"])
      ? (value["operations"] as string[])
      : [],
    removed: field(value["removed"], `${file}.removed`),
    candidates,
    ...(typeof value["context"] === "string" ? { context: value["context"] } : {}),
    successor,
    rationale: typeof value["rationale"] === "string" ? value["rationale"] : "",
  };
}

export async function loadCorpus(dir: string): Promise<EvalCase[]> {
  const files = (await readdir(dir)).filter((name) => name.endsWith(".yaml")).sort();
  const cases: EvalCase[] = [];
  const seen = new Set<string>();

  for (const name of files) {
    const parsed: unknown = parseYaml(await readFile(join(dir, name), "utf8"));
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of entries) {
      const parsedCase = parseCase(entry, name);
      if (seen.has(parsedCase.id)) {
        throw new CorpusError(`Duplicate case id "${parsedCase.id}" in ${name}`);
      }
      seen.add(parsedCase.id);
      cases.push(parsedCase);
    }
  }

  return cases;
}

export function questionOf(testCase: EvalCase): AlignmentQuestion {
  return {
    kind: "alignment",
    schema: testCase.schema,
    operations: testCase.operations,
    removed: testCase.removed,
    candidates: testCase.candidates,
    ...(testCase.context === undefined ? {} : { context: testCase.context }),
  };
}
