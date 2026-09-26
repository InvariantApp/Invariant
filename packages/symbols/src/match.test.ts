import type { OpenApiDocument } from "@invariant-app/contract";
import { describe, expect, it } from "vitest";
import {
  type Declaration,
  matchTypes,
  RulesSymbolJudge,
  type SymbolJudge,
  schemaShapes,
  type TieQuestion,
} from "./index.ts";

const object = (
  qualified: string,
  fields: string[],
  more: Partial<Declaration> = {},
): Declaration => ({
  qualified,
  name: qualified.split(".").at(-1) as string,
  kind: "object",
  fields,
  file: "types.d.ts",
  ...more,
});

const contract = (
  schemas: Record<string, unknown>,
  paths: Record<string, unknown> = {},
) => ({ openapi: "3.1.0", paths, components: { schemas } }) as unknown as OpenApiDocument;

const props = (...names: string[]) =>
  Object.fromEntries(names.map((name) => [name, { type: "string" }]));

async function match(
  document: OpenApiDocument,
  declarations: Declaration[],
  options: { language?: "typescript" | "python" | "go"; judge?: SymbolJudge } = {},
) {
  const language = options.language ?? "typescript";
  return matchTypes(schemaShapes(document, language), declarations, {
    language,
    judge: options.judge ?? new RulesSymbolJudge(),
  });
}

describe("matchTypes", () => {
  it("rules out a type whose pinned field disagrees with the schema's, whatever its name", async () => {
    const { types } = await match(
      contract({
        line_item: {
          type: "object",
          properties: {
            ...props("id", "amount"),
            object: { type: "string", enum: ["line_item"] },
          },
        },
      }),
      [
        object("LineItem", ["id", "amount", "object"], { constants: { object: "item" } }),
        object("InvoiceLineItem", ["id", "amount", "object"], {
          constants: { object: "line_item" },
        }),
      ],
    );
    expect(types["line_item"]).toMatchObject({
      symbol: "InvoiceLineItem",
      via: "metadata",
    });
  });

  it("lets a union of the schema's variants implement it, never another alias", async () => {
    const tagged = (name: string, type: string) =>
      object(name, ["id", "object", "type"], {
        constants: { object: "event", type },
        extends: ["EventBase"],
      });
    const { types, unmatched } = await match(
      contract({
        event: {
          type: "object",
          properties: {
            ...props("id", "type"),
            object: { type: "string", enum: ["event"] },
          },
        },
        Plain: { type: "object", properties: props("a", "b") },
      }),
      [
        tagged("ChargeEvent", "charge"),
        tagged("RefundEvent", "refund"),
        {
          qualified: "Event",
          name: "Event",
          kind: "alias",
          variants: ["ChargeEvent", "RefundEvent"],
          fields: ["id", "object", "type"],
          constants: { object: "event" },
          file: "types.d.ts",
        },
        { qualified: "Plain", name: "Plain", kind: "alias", file: "types.d.ts" },
      ],
    );
    expect(types["event"]).toMatchObject({ symbol: "Event", via: "metadata" });
    expect(types["Plain"]).toBeUndefined();
    expect(unmatched["Plain"]).toBeDefined();
  });

  it("lets the fields overrule a converted name that shares under half of them", async () => {
    const { types } = await match(
      contract({
        line_item: {
          type: "object",
          properties: props("id", "amount", "invoice", "period"),
        },
      }),
      [
        object("LineItem", ["id", "amount_discount", "amount_total", "price"]),
        object("InvoiceLineItem", ["id", "amount", "invoice", "period"]),
      ],
      { language: "go" },
    );
    expect(types["line_item"]).toMatchObject({
      symbol: "InvoiceLineItem",
      via: "structure",
    });
    expect(types["line_item"]?.evidence).toContain("over LineItem");
  });

  it("finds a schema only through its fields, at the threshold and uniquely", async () => {
    const document = contract({
      Renamed: { type: "object", properties: props("a", "b", "c", "d", "e") },
      TooFew: { type: "object", properties: props("a", "x", "y", "z", "w") },
    });
    const { types, unmatched } = await match(document, [
      object("Something", ["a", "b", "c", "d"]),
      object("Other", ["q"]),
    ]);
    expect(types["Renamed"]).toMatchObject({
      symbol: "Something",
      via: "structure",
      overlap: 0.8,
    });
    expect(unmatched["TooFew"]).toContain("none has its fields");
  });

  it("gives no schema a type whose fields fit schemas pinned to different values", async () => {
    const deleted = (object: string) => ({
      type: "object",
      properties: {
        ...props("id", "deleted"),
        object: { type: "string", enum: [object] },
      },
    });
    const { types, unmatched } = await match(
      contract({
        deleted_customer: deleted("customer"),
        deleted_coupon: deleted("coupon"),
      }),
      [object("PaymentSource", ["deleted", "id", "object"])],
      { language: "go" },
    );
    expect(types).toEqual({});
    expect(unmatched["deleted_customer"]).toContain("pin its values differently");
  });

  it("compares fields loosely, so a camelCase SDK matches a snake_case contract", async () => {
    const { types } = await match(
      contract({
        UsageStats: {
          type: "object",
          properties: props("prompt_tokens", "total_tokens"),
        },
      }),
      [object("TokenCount", ["promptTokens", "totalTokens"])],
    );
    expect(types["UsageStats"]?.symbol).toBe("TokenCount");
  });

  it("prefers the request twin for a schema only requests carry, the response one otherwise", async () => {
    const document = contract(
      {
        RequestTextBlock: { type: "object", properties: props("text", "type") },
        ResponseTextBlock: { type: "object", properties: props("text", "type") },
        CreateParams: {
          type: "object",
          properties: {
            blocks: {
              type: "array",
              items: { $ref: "#/components/schemas/RequestTextBlock" },
            },
          },
        },
      },
      {
        "/v1/messages": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/CreateParams" },
                },
              },
            },
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/ResponseTextBlock" },
                  },
                },
              },
            },
          },
        },
      },
    );
    const { types } = await match(document, [
      object("TextBlock", ["text", "type"]),
      object("TextBlockParam", ["text", "type"], { input: true }),
    ]);
    expect(types["RequestTextBlock"]?.symbol).toBe("TextBlockParam");
    expect(types["ResponseTextBlock"]?.symbol).toBe("TextBlock");
  });

  it("never names a schema only responses carry by a request suffix", async () => {
    const document = contract(
      {
        invoice: {
          type: "object",
          properties: {
            period: { $ref: "#/components/schemas/invoice_line_item_period" },
          },
        },
        invoice_line_item_period: { type: "object", properties: props("end", "start") },
      },
      {
        "/v1/invoices": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/invoice" },
                  },
                },
              },
            },
          },
        },
      },
    );
    const { types } = await match(
      document,
      [object("InvoiceLineItemPeriodParams", ["end", "start"], { input: true })],
      { language: "go" },
    );
    expect(types["invoice_line_item_period"]).toBeUndefined();
  });

  it("takes the base two tied types extend", async () => {
    const { types } = await match(
      contract({
        CreateMessageParams: {
          type: "object",
          properties: props("model", "messages", "stream"),
        },
      }),
      [
        object("MessageCreateParamsBase", ["model", "messages"]),
        object("MessageCreateParamsStreaming", ["model", "messages", "stream"], {
          extends: ["MessageCreateParamsBase"],
        }),
        object("MessageCreateParamsNonStreaming", ["model", "messages", "stream"], {
          extends: ["MessageCreateParamsBase"],
        }),
      ],
    );
    expect(types["CreateMessageParams"]?.symbol).toBe("MessageCreateParamsBase");
  });

  it("names a schema only one placed type holds by the type nested under the property", async () => {
    const document = contract({
      subscription: {
        type: "object",
        properties: {
          ...props("id"),
          automatic_tax: { $ref: "#/components/schemas/subscription_automatic_tax" },
        },
      },
      subscription_automatic_tax: {
        type: "object",
        properties: props("enabled", "liability"),
      },
    });
    const { types } = await match(
      document,
      [
        object("stripe.Subscription", ["id", "automatic_tax"]),
        object("stripe.Subscription.AutomaticTax", ["enabled", "liability"], {
          parent: "stripe.Subscription",
        }),
      ],
      { language: "python" },
    );
    expect(types["subscription_automatic_tax"]).toMatchObject({
      symbol: "stripe.Subscription.AutomaticTax",
      via: "name",
    });
  });

  it("uses a generator's extension on the schema as the type's name", async () => {
    const { types } = await match(
      contract({
        AssistantMessageV2: {
          type: "object",
          properties: props("content"),
          "x-fern-type-name": "AssistantMessage",
        },
      }),
      [object("cohere.AssistantMessage", ["content"])],
      { language: "python" },
    );
    expect(types["AssistantMessageV2"]).toMatchObject({
      symbol: "cohere.AssistantMessage",
      via: "metadata",
    });
  });

  it("counts a suffix only where it picks out one type", async () => {
    const { types } = await match(
      contract({ UsageResponse: { type: "object", properties: props("x", "y") } }),
      [object("a.Usage", ["p"]), object("b.Usage", ["q"])],
    );
    expect(types["UsageResponse"]).toBeUndefined();
  });

  it("asks the judge about a tie it cannot break, and leaves the schema out when it declines", async () => {
    const asked: TieQuestion[] = [];
    const judge: SymbolJudge = {
      id: "test",
      fingerprint: "test",
      async choose(questions) {
        asked.push(...questions);
        return questions.map(() => ({
          choice: null,
          confidence: 0,
          reason: "cannot tell",
        }));
      },
    };
    const { types, unmatched } = await match(
      contract({ Error: { type: "object", properties: props("code", "message") } }),
      [
        object("a.x.Error", ["code", "message"]),
        object("b.y.Error", ["code", "message"]),
      ],
      { judge },
    );
    expect(types["Error"]).toBeUndefined();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ schema: "Error", stage: "name" });
    expect(unmatched["Error"]).toContain("the test judge chose none: cannot tell");
  });
});

describe("RulesSymbolJudge", () => {
  const judge = new RulesSymbolJudge();

  it("takes the least nested of types with one name, and says less the more there were", async () => {
    const [two, three] = await judge.choose([
      {
        schema: "Message",
        properties: [],
        stage: "name",
        candidates: [
          { qualified: "sdk.types.Message", file: "a" },
          { qualified: "sdk.types.beta.x.Message", file: "b" },
        ],
      },
      {
        schema: "Message",
        properties: [],
        stage: "name",
        candidates: [
          { qualified: "sdk.types.Message", file: "a" },
          { qualified: "sdk.types.beta.x.Message", file: "b" },
          { qualified: "sdk.types.beta.y.Message", file: "c" },
        ],
      },
    ]);
    expect(two).toMatchObject({ choice: "sdk.types.Message", confidence: 0.6 });
    expect(three).toMatchObject({ choice: "sdk.types.Message", confidence: 0.4 });
  });

  it("takes a type over its request-side twins, and declines a tie on fields alone", async () => {
    const [variants, fields] = await judge.choose([
      {
        schema: "ChatCompletionRequest",
        properties: [],
        stage: "structure",
        candidates: [
          { qualified: "m.ChatCompletionRequest", file: "a" },
          { qualified: "m.ChatCompletionRequestTypedDict", file: "a" },
        ],
      },
      {
        schema: "Usage",
        properties: [],
        stage: "structure",
        candidates: [
          { qualified: "a.Usage", file: "a" },
          { qualified: "a.UsageDuration", file: "b" },
        ],
      },
    ]);
    expect(variants?.choice).toBe("m.ChatCompletionRequest");
    expect(fields?.choice).toBeNull();
  });
});
