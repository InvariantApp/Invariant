/**
 * The lens laws on the value codecs that refuse rather than round.
 *
 * Each of them is exact or refuses, and the laws are what find out whether
 * the refusals ever fire on a value the contract allows. When they would, the
 * gate says so and the provider chooses: declare the loss, or keep the
 * refusal and know which callers meet it.
 */
import { predictDocument } from "@invariant-app/compiler";
import type { OpenApiDocument } from "@invariant-app/contract";
import { type Change, parseChange } from "@invariant-app/ir";
import { describe, expect, it } from "vitest";
import { checkLaws } from "./laws.ts";

/** One schema, used both ways, so each law runs in each direction. */
function contract(properties: Record<string, unknown>): OpenApiDocument {
  const event = { $ref: "#/components/schemas/Event" };
  return {
    openapi: "3.1.0",
    info: { title: "events", version: "1" },
    paths: {
      "/events": {
        post: {
          operationId: "createEvent",
          requestBody: { content: { "application/json": { schema: event } } },
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: event } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Event: { type: "object", additionalProperties: false, properties },
      },
    },
  } as unknown as OpenApiDocument;
}

function laws(old: OpenApiDocument, ops: unknown[]) {
  const change = parseChange({
    irVersion: 1,
    id: "chg_codec",
    summary: "a codec",
    scopes: [{ schema: "#/components/schemas/Event" }],
    ops,
  }) as Change;
  const predicted = predictDocument(old, old, [change]);
  expect(predicted.issues).toEqual([]);
  return checkLaws(old, predicted.document, [change], { runs: 200, seed: 11 });
}

const CREATED = contract({ created: { type: "integer" } });
const EMAIL = contract({ email: { type: "string" } });

describe("the lens laws on value codecs", () => {
  it("find the response a whole-second contract cannot hold", () => {
    // The new contract's times may carry milliseconds; the old one counts
    // whole seconds, and refusing is the only exact answer.
    const report = laws(CREATED, [
      {
        op: "convert",
        path: "/created",
        codec: { kind: "dateFormat", from: "epoch-s", to: "rfc3339" },
      },
    ]);
    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.failures[0]?.detail).toMatch(/fraction of a second/);
  });

  it("hold once the provider declares the truncation", () => {
    const report = laws(CREATED, [
      {
        op: "convert",
        path: "/created",
        codec: {
          kind: "dateFormat",
          from: "epoch-s",
          to: "rfc3339",
          onInexact: "truncate",
        },
      },
    ]);
    expect(report.failures).toEqual([]);
  });

  it("hold for a case change over a closed set of values", () => {
    const report = laws(
      contract({
        status: { type: "string", enum: ["in_progress", "past_due", "done"] },
      }),
      [
        {
          op: "convert",
          path: "/status",
          codec: { kind: "stringCase", from: "snake", to: "screaming" },
        },
      ],
    );
    expect(report.failures).toEqual([]);
  });

  it("find the list an old caller has room for only one of", () => {
    const report = laws(EMAIL, [
      { op: "convert", path: "/email", codec: { kind: "wrapArray" } },
    ]);
    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.failures[0]?.detail).toMatch(/only one can be shown/);
  });

  it("hold once the provider declares that the first item stands for the list", () => {
    const report = laws(EMAIL, [
      { op: "convert", path: "/email", codec: { kind: "wrapArray", pick: "first" } },
    ]);
    expect(report.failures).toEqual([]);
  });
});
