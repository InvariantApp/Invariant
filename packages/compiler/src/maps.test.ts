/**
 * A Change inside every value of a map, compiled and run.
 *
 * A price keyed by currency, limits keyed by resource, metadata keyed by
 * whatever the caller chose: the keys are data, and every value has the same
 * shape. A field renamed in that shape is renamed in every value, whatever
 * the keys are.
 */
import type { OpenApiDocument } from "@invariant-app/contract";
import { parseChange } from "@invariant-app/ir";
import { propose, RulesJudge } from "@invariant-app/proposer";
import { createRuntime } from "@invariant-app/runtime";
import { describe, expect, it } from "vitest";
import { chainProgram } from "./chain.ts";
import { predictDocument } from "./predict.ts";

function prices(amount: string): OpenApiDocument {
  const price = { $ref: "#/components/schemas/Price" };
  return {
    openapi: "3.1.0",
    info: { title: "prices", version: "1" },
    paths: {
      "/prices": {
        post: {
          operationId: "createPrice",
          requestBody: { content: { "application/json": { schema: price } } },
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: price } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Price: {
          type: "object",
          properties: {
            id: { type: "string" },
            currency_options: {
              type: "object",
              additionalProperties: {
                type: "object",
                properties: { [amount]: { type: "integer" } },
              },
            },
          },
        },
      },
    },
  } as unknown as OpenApiDocument;
}

const before = prices("amount");
const after = prices("unit_amount");
const change = parseChange({
  irVersion: 1,
  id: "chg_currency_amount",
  summary: "Each currency's amount is its unit_amount.",
  scopes: [{ schema: "#/components/schemas/Price" }],
  ops: [
    {
      op: "move",
      from: "/currency_options/{}/amount",
      to: "/currency_options/{}/unit_amount",
    },
  ],
});

describe("a Change inside every value of a map", () => {
  it("is predicted as the new contract has it", () => {
    const prediction = predictDocument(before, after, [change]);
    expect(prediction.issues).toEqual([]);
    expect(JSON.stringify(prediction.document)).toBe(JSON.stringify(after));
  });

  it("reaches every value, whatever its key, both ways", () => {
    const { program, issues } = chainProgram("prices", "v2", "sha256:2", [
      { label: "v2", parent: "v1", from: before, to: after, changes: [change] },
    ]);
    expect(issues).toEqual([]);
    const runtime = createRuntime({
      program,
      identity: [{ kind: "default", label: "v1" }],
    });
    const site = runtime.siteFor("v1", "post", "/prices");
    if (!site) throw new Error("no site");
    const context = { contract: "v1", operation: "createPrice" };
    const sent = { currency_options: { usd: { amount: 500 }, eur: { amount: 450 } } };
    expect(
      JSON.parse(runtime.transformRequest(site, JSON.stringify(sent), context)),
    ).toEqual({
      currency_options: { usd: { unit_amount: 500 }, eur: { unit_amount: 450 } },
    });
    const answer = { id: "price_1", currency_options: { jpy: { unit_amount: 700 } } };
    expect(
      JSON.parse(runtime.transformResponse(site, 200, JSON.stringify(answer), context)),
    ).toEqual({ id: "price_1", currency_options: { jpy: { amount: 700 } } });
  });

  it("is drafted by the proposer, inside the map as anywhere else", async () => {
    // A spelling change, which the rules judge settles without a model.
    const outcome = await propose(prices("unitAmount"), prices("unit_amount"), {
      judge: new RulesJudge(),
    });
    const ops = outcome.proposals.flatMap((proposal) => proposal.change.ops);
    expect(ops).toContainEqual({
      op: "move",
      from: "/currency_options/{}/unitAmount",
      to: "/currency_options/{}/unit_amount",
    });
  });
});
