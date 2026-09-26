/**
 * Who decides when several SDK types are equally good for one schema.
 *
 * The proposer's `Judge` answers one question, which added field replaced a
 * removed one, and its answers are calibrated against a labelled corpus. The
 * question here is different, which of these declarations is this schema's
 * type, so it has an interface of its own in the same shape: an id, a
 * fingerprint that covers everything that could change an answer, and a
 * batch method. A judge only ranks candidates the matcher enumerated; it
 * never proposes a type the SDK does not declare.
 *
 * The default judge is rules. It never calls a model, and it abstains
 * whenever its one rule does not separate the candidates, which leaves the
 * schema unmapped rather than guessed at.
 */
import { depth } from "./names.ts";

/** What a generator appends to a type's name for its request-side twin. */
const VARIANT = /^(?:Param|Params|TypedDict)$/;

export interface TieCandidate {
  qualified: string;
  file: string;
  /** Wire names of its fields, where known. */
  fields?: string[];
  /** Share of fields in common with the schema, where both are known. */
  overlap?: number;
}

export interface TieQuestion {
  schema: string;
  properties: string[];
  /**
   * The strategy the tie came from: several declarations with the name a
   * convention spells, or several with the same fields.
   */
  stage: "metadata" | "name" | "structure";
  candidates: TieCandidate[];
}

export interface TieAnswer {
  /** The chosen candidate's qualified name, or null when the judge declines. */
  choice: string | null;
  /** 0 to 1. */
  confidence: number;
  /** Why, for the entry's evidence. */
  reason: string;
}

export interface SymbolJudge {
  readonly id: string;
  /** Everything about this judge that decides what it answers; part of a cached map's validity. */
  readonly fingerprint: string;
  choose(questions: readonly TieQuestion[]): Promise<TieAnswer[]>;
}

/**
 * Two rules. A type beats its own variants, whose names extend its name.
 * Then a tie between types of the same name goes to the one declared least
 * deep, as `anthropic.types.Message` over a `Message` three packages further
 * in: a generator puts a schema's own type at the top and the types it only
 * needs internally below it. A tie between types that merely have the same
 * fields is not separated by depth, and is declined.
 */
export class RulesSymbolJudge implements SymbolJudge {
  readonly id = "rules";
  readonly fingerprint =
    "rules/1: a type over its variants; name ties to the least nested declaration";

  async choose(questions: readonly TieQuestion[]): Promise<TieAnswer[]> {
    return questions.map((question) => {
      // A type and its request-side twins, as Speakeasy's
      // `ChatCompletionRequest` and `ChatCompletionRequestTypedDict`, share
      // their fields; the type is the one the others add a suffix to.
      const names = question.candidates.map((each) => ({
        each,
        name: each.qualified.split(".").at(-1) ?? each.qualified,
      }));
      const base = names.filter(({ name }) =>
        names.every(
          (other) =>
            other.name === name ||
            (other.name.startsWith(name) && VARIANT.test(other.name.slice(name.length))),
        ),
      );
      if (base.length === 1 && question.candidates.length > 1) {
        return {
          choice: (base[0] as { each: TieCandidate }).each.qualified,
          confidence: 0.7,
          reason: `the others are its variants (${names
            .filter((entry) => entry !== base[0])
            .map((entry) => entry.name)
            .join(", ")})`,
        };
      }
      if (question.stage === "structure") {
        return {
          choice: null,
          confidence: 0,
          reason: `${question.candidates.length} types share its fields equally`,
        };
      }
      const least = Math.min(...question.candidates.map((each) => depth(each.qualified)));
      const shallowest = question.candidates.filter(
        (each) => depth(each.qualified) === least,
      );
      if (shallowest.length !== 1) {
        return {
          choice: null,
          confidence: 0,
          reason: `${shallowest.length} equally nested types have its name`,
        };
      }
      return {
        choice: (shallowest[0] as TieCandidate).qualified,
        // The more there were, the less the rule says.
        confidence: question.candidates.length > 2 ? 0.4 : 0.6,
        reason: `the least nested of ${question.candidates.length} types with its name`,
      };
    });
  }
}
