/**
 * A Change to one variant of a union, compiled and run.
 *
 * Adyen's payment methods are fifty schemas in one `oneOf`, each fixing
 * `type` to values of its own. A Change to the card variant has to reach
 * card values and nothing else, in a request and in a response list, and
 * when it also renames the card's `type`, the way back has to recognise the
 * card by the name it now has.
 */
import type { OpenApiDocument } from "@invariant-app/contract";
import { parseChange } from "@invariant-app/ir";
import { createRuntime } from "@invariant-app/runtime";
import { describe, expect, it } from "vitest";
import { chainProgram } from "./chain.ts";
import { predictDocument } from "./predict.ts";

const typed = (value: string, properties: Record<string, unknown>) => ({
  type: "object",
  required: ["type"],
  properties: { type: { type: "string", enum: [value] }, ...properties },
});

function payments(card: Record<string, unknown>, cardType: string): OpenApiDocument {
  const union = {
    oneOf: [
      { $ref: "#/components/schemas/CardDetails" },
      { $ref: "#/components/schemas/IdealDetails" },
    ],
  };
  return {
    openapi: "3.0.3",
    info: { title: "checkout", version: "1" },
    paths: {
      "/payments": {
        post: {
          operationId: "payments",
          requestBody: {
            content: {
              "application/json": {
                schema: { type: "object", properties: { paymentMethod: union } },
              },
            },
          },
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { methods: { type: "array", items: union } },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        CardDetails: typed(cardType, card),
        IdealDetails: typed("ideal", { number: { type: "string" } }),
      },
    },
  } as unknown as OpenApiDocument;
}

describe("a Change to one variant of a union", () => {
  const before = payments({ number: { type: "string" } }, "scheme");
  const after = payments({ card_number: { type: "string" } }, "card");
  const change = parseChange({
    irVersion: 1,
    id: "chg_card",
    summary: "The card number field is card_number, and the card type is card.",
    scopes: [{ schema: "#/components/schemas/CardDetails" }],
    ops: [
      { op: "move", from: "/number", to: "/card_number" },
      {
        op: "convert",
        path: "/type",
        codec: { kind: "enumMap", pairs: [["scheme", "card"]] },
      },
    ],
  });

  it("is predicted on the variant alone", () => {
    const prediction = predictDocument(before, after, [change]);
    expect(prediction.issues).toEqual([]);
    expect(JSON.stringify(prediction.document)).toBe(JSON.stringify(after));
  });

  it("reaches that variant's values and no other, both ways", () => {
    const { program, issues } = chainProgram("checkout", "v2", "sha256:2", [
      { label: "v2", parent: "v1", from: before, to: after, changes: [change] },
    ]);
    expect(issues).toEqual([]);
    const runtime = createRuntime({
      program,
      identity: [{ kind: "default", label: "v1" }],
    });
    const site = runtime.siteFor("v1", "post", "/payments");
    if (!site) throw new Error("no site");
    const context = { contract: "v1", operation: "payments" };

    const card = runtime.transformRequest(
      site,
      JSON.stringify({ paymentMethod: { type: "scheme", number: "4111" } }),
      context,
    );
    expect(JSON.parse(card)).toEqual({
      paymentMethod: { type: "card", card_number: "4111" },
    });
    const ideal = runtime.transformRequest(
      site,
      JSON.stringify({ paymentMethod: { type: "ideal", number: "NL01" } }),
      context,
    );
    expect(JSON.parse(ideal)).toEqual({
      paymentMethod: { type: "ideal", number: "NL01" },
    });

    const listed = runtime.transformResponse(
      site,
      200,
      JSON.stringify({
        methods: [
          { type: "card", card_number: "4111" },
          { type: "ideal", number: "NL01" },
        ],
      }),
      context,
    );
    expect(JSON.parse(listed)).toEqual({
      methods: [
        { type: "scheme", number: "4111" },
        { type: "ideal", number: "NL01" },
      ],
    });
  });
});
