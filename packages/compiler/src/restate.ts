/**
 * What makes a `restate` true.
 *
 * A restatement translates nothing, so it is only honest where nothing needs
 * translating: every value old callers may now be sent, their contract
 * allowed, and every value they send, the new contract accepts. Both are
 * proved schema against schema by the shared containment check, and the
 * Change is refused, naming where and why, wherever either cannot be shown.
 */
import {
  covers,
  keepsNames,
  type OpenApiDocument,
  referencesAlike,
} from "@invariant-app/contract";
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
  /**
   * Both statements as they are written, references kept. Names are compared
   * on these, so a schema that holds itself is cut off at the same place on
   * both sides, and the references are what the written place will name.
   */
  written: { before: JsonValue; after: JsonValue } = {
    before: before.schema,
    after: after.schema,
  },
): void {
  const alike = referencesAlike(before.document, {
    document: after.document,
    schema: written.after,
  });
  if (!alike.covered) {
    throw new SchemaOpError(
      `${place} is not the same values restated: it refers to ${alike.at}, and ${alike.reason}`,
    );
  }
  const named = keepsNames(
    { document: before.document, schema: written.before },
    { document: after.document, schema: written.after },
  );
  if (!named.covered) {
    throw new SchemaOpError(
      `${place} is not the same values restated: ${named.at} ${named.reason}`,
    );
  }
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
