/**
 * What makes a `restate` true.
 *
 * A restatement translates nothing, so it is only honest where nothing needs
 * translating: every value old callers may now be sent, their contract
 * allowed, and every value they send, the new contract accepts. Both are
 * proved schema against schema by the shared containment check, and the
 * Change is refused, naming where and why, wherever either cannot be shown.
 */
import { covers, type OpenApiDocument } from "@invariant-app/contract";
import type { JsonValue } from "@invariant-app/ir";
import { SchemaOpError } from "./schema.ts";

export interface Stated {
  document: OpenApiDocument;
  schema: JsonValue;
}

export function proveRestated(
  before: Stated,
  after: Stated,
  directions: { request: boolean; response: boolean },
  place: string,
): void {
  if (directions.response) {
    const answer = covers(before, after);
    if (!answer.covered) {
      throw new SchemaOpError(
        `${place} is not the same values restated: old callers could be sent one their contract ruled out${where(answer.at)} (${answer.reason})`,
      );
    }
  }
  if (directions.request) {
    const answer = covers(after, before);
    if (!answer.covered) {
      throw new SchemaOpError(
        `${place} is not the same values restated: the new contract could refuse one old callers send${where(answer.at)} (${answer.reason})`,
      );
    }
  }
}

const where = (at: string) => (at === "" ? "" : ` at ${at}`);
