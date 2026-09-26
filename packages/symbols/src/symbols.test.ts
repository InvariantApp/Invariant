/**
 * The symbol map of each fixture release, a hand-trimmed copy of a real one
 * (`fixtures/README.md`), against the contract it speaks.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenApiDocument } from "@invariant-app/contract";
import { describe, expect, it } from "vitest";
import {
  type GeneratedSymbols,
  generateSymbols,
  goSymbolsOf,
  type Language,
  symbolMapOf,
} from "./index.ts";

const FIXTURES = join(import.meta.dirname, "../fixtures");

const contract = (name: string): OpenApiDocument =>
  JSON.parse(
    readFileSync(join(FIXTURES, name, "contract.json"), "utf8"),
  ) as OpenApiDocument;

async function mapOf(
  fixture: string,
  language: Language,
  contractOf = fixture,
  module?: string,
): Promise<GeneratedSymbols> {
  return generateSymbols({
    sdk: join(FIXTURES, fixture),
    language,
    contract: contract(contractOf),
    ...(module ? { module } : {}),
  });
}

describe("stripe-node before 22", () => {
  it("names each schema through `namespace Stripe`, and trusts the tag over the name", async () => {
    const map = await mapOf("stripe-node", "typescript");
    expect(map.generators).toEqual(["stripe"]);
    expect(map.package).toBe("stripe");
    expect(map.version).toBe("17.7.0");
    expect(symbolMapOf(map).types).toEqual({
      "checkout.session": "Stripe.Checkout.Session",
      payment_pages_checkout_session_automatic_tax:
        "Stripe.Checkout.Session.AutomaticTax",
      customer: "Stripe.Customer",
      deleted_customer: "Stripe.DeletedCustomer",
      // stripe-node's `LineItem` is a checkout session's; its `object` says so.
      line_item: "Stripe.InvoiceLineItem",
      item: "Stripe.LineItem",
    });
    expect(map.types["line_item"]).toMatchObject({ via: "metadata", confidence: 0.95 });
    expect(map.types["customer"]?.evidence).toContain("its name agrees");
    expect(map.types["payment_pages_checkout_session_automatic_tax"]?.via).toBe("name");
    expect(map.unmatched["address"]).toBeDefined();
  });

  it("reads each operation's method from the resource files as data", async () => {
    const map = await mapOf("stripe-node", "typescript");
    expect(symbolMapOf(map).operations).toEqual({
      "get /v1/invoices/upcoming": {
        type: "Stripe.InvoicesResource",
        method: "retrieveUpcoming",
      },
      "post /v1/checkout/sessions": {
        type: "Stripe.Checkout.SessionsResource",
        method: "create",
      },
      "get /v1/checkout/sessions/{session}": {
        type: "Stripe.Checkout.SessionsResource",
        method: "retrieve",
      },
    });
    expect(map.operations["get /v1/invoices/upcoming"]).toMatchObject({
      via: "metadata",
      confidence: 1,
    });
  });
});

describe("stripe-node from 22", () => {
  it("names a module's types through their directory, whatever `namespace Stripe` still declares", async () => {
    const map = await mapOf("stripe-node-22", "typescript", "stripe-node");
    expect(symbolMapOf(map).types).toMatchObject({
      "checkout.session": "Checkout.Session",
      customer: "Customer",
    });
    expect(map.types["checkout.session"]?.via).toBe("metadata");
    // Its methods are code now, and read as code.
    expect(symbolMapOf(map).operations).toEqual({
      "get /v1/customers/{customer}": { type: "CustomerResource", method: "retrieve" },
      "delete /v1/customers/{customer}": { type: "CustomerResource", method: "del" },
      "post /v1/checkout/sessions": {
        type: "Checkout.SessionResource",
        method: "create",
      },
    });
    expect(map.operations["delete /v1/customers/{customer}"]).toMatchObject({
      type: "CustomerResource",
      method: "del",
      via: "structure",
    });
  });
});

describe("stripe-python", () => {
  it("names each class by the shortest path the package re-exports it through", async () => {
    const map = await mapOf("stripe-python", "python", "stripe-python", "stripe");
    expect(map.generators).toEqual(["stripe"]);
    expect(symbolMapOf(map).types).toEqual({
      subscription: "stripe.Subscription",
      subscription_automatic_tax: "stripe.Subscription.AutomaticTax",
      connect_account_reference: "stripe.Subscription.AutomaticTax.Liability",
      "checkout.session": "stripe.checkout.Session",
      payment_pages_checkout_session_automatic_tax:
        "stripe.checkout.Session.AutomaticTax",
      line_item: "stripe.InvoiceLineItem",
      item: "stripe.LineItem",
    });
  });

  it("gives an operation to the public method, not the class-method variant behind it", async () => {
    const map = await mapOf("stripe-python", "python", "stripe-python", "stripe");
    expect(symbolMapOf(map).operations).toEqual({
      "delete /v1/subscriptions/{subscription_exposed_id}": {
        type: "stripe.Subscription",
        method: "cancel",
      },
    });
  });
});

describe("Stainless", () => {
  it("Python: by name, a request type by its Param twin, a union by its alias", async () => {
    const map = await mapOf(
      "stainless-python",
      "python",
      "stainless-python",
      "anthropic",
    );
    expect(map.generators).toEqual(["stainless"]);
    expect(map.package).toBe("anthropic");
    expect(map.version).toBe("0.79.0");
    expect(symbolMapOf(map).types).toEqual({
      Message: "anthropic.types.Message",
      BetaMessage: "anthropic.types.beta.BetaMessage",
      Tool: "anthropic.types.ToolParam",
      ContentBlock: "anthropic.types.ContentBlock",
      // Stainless renames these two; the fields and which side carries each
      // find them.
      RequestTextBlock: "anthropic.types.TextBlockParam",
      ResponseTextBlock: "anthropic.types.TextBlock",
    });
    expect(map.types["RequestTextBlock"]?.evidence).toContain(
      "only requests carry the schema",
    );
  });

  it("Python: operations from each method's own request, the sync class over its async twin", async () => {
    const map = await mapOf(
      "stainless-python",
      "python",
      "stainless-python",
      "anthropic",
    );
    expect(symbolMapOf(map).operations).toEqual({
      "post /v1/messages/batches": {
        type: "anthropic.resources.Batches",
        method: "create",
      },
      "get /v1/messages/batches/{message_batch_id}": {
        type: "anthropic.resources.Batches",
        method: "retrieve",
      },
    });
  });

  it("TypeScript: reads a `.d.ts` once however many twins it has", async () => {
    const map = await mapOf("stainless-typescript", "typescript", "stainless-python");
    expect(map.generators).toEqual(["stainless"]);
    expect(symbolMapOf(map).types).toMatchObject({
      Message: "Message",
      Tool: "Tool",
      ContentBlock: "ContentBlock",
      RequestTextBlock: "TextBlockParam",
      ResponseTextBlock: "TextBlock",
      MessageBatch: "MessageBatch",
    });
    expect(symbolMapOf(map).operations).toEqual({
      "post /v1/messages": { type: "Messages", method: "create" },
      "post /v1/messages/batches": { type: "Batches", method: "create" },
      "get /v1/messages/batches/{message_batch_id}": {
        type: "Batches",
        method: "retrieve",
      },
    });
  });

  it("Go: struct tags give the wire names, and api.md pairs each method with its endpoint", async () => {
    const map = await mapOf("stainless-go", "go", "stainless-python");
    expect(map.generators).toEqual(["stainless"]);
    expect(goSymbolsOf(map).types).toMatchObject({
      Message: { package: "", key: "Message" },
      MessageBatch: { package: "", key: "MessageBatch" },
    });
    expect(goSymbolsOf(map).operations).toEqual({
      "post /v1/messages": [{ package: "", key: "MessageService.New" }],
      "post /v1/messages/batches": [{ package: "", key: "MessageBatchService.New" }],
      "get /v1/messages/batches/{message_batch_id}": [
        { package: "", key: "MessageBatchService.Get" },
      ],
    });
    expect(map.operations["post /v1/messages"]?.via).toBe("metadata");
  });
});

describe("openapi-typescript", () => {
  it('records every schema\'s type as `components["schemas"]`', async () => {
    const map = await mapOf("openapi-typescript", "typescript");
    expect(map.generators).toEqual(["openapi-typescript"]);
    expect(symbolMapOf(map).types).toEqual({
      "simple-user": 'components["schemas"]["simple-user"]',
      "alert-url": 'components["schemas"]["alert-url"]',
      "minimal-repository": 'components["schemas"]["minimal-repository"]',
    });
    expect(map.types["simple-user"]).toMatchObject({ via: "metadata", confidence: 1 });
  });
});

describe("openapi-generator", () => {
  it("Python: a camelCase schema key PascalCased, wire names from `__properties`", async () => {
    const map = await mapOf(
      "openapi-generator-python",
      "python",
      "openapi-generator-python",
      "ory_client",
    );
    expect(map.generators).toEqual(["openapi-generator"]);
    expect(symbolMapOf(map).types).toEqual({
      jsonPatch: "ory_client.JsonPatch",
      uiNodeAnchorAttributes: "ory_client.UiNodeAnchorAttributes",
    });
    expect(map.types["jsonPatch"]?.overlap).toBe(1);
  });

  it("Python: the README's table confirms the method a private helper's request belongs to", async () => {
    const map = await mapOf(
      "openapi-generator-python",
      "python",
      "openapi-generator-python",
      "ory_client",
    );
    expect(symbolMapOf(map).operations).toEqual({
      "delete /admin/identities/{id}": {
        type: "ory_client.IdentityApi",
        method: "delete_identity",
      },
    });
    expect(map.operations["delete /admin/identities/{id}"]?.via).toBe("metadata");
  });

  it("TypeScript (axios): the class method, through the functional and parameter layers", async () => {
    const map = await mapOf(
      "openapi-generator-typescript",
      "typescript",
      "openapi-generator-python",
    );
    expect(map.generators).toEqual(["openapi-generator"]);
    expect(symbolMapOf(map).types).toMatchObject({
      jsonPatch: "JsonPatch",
      uiNodeAnchorAttributes: "UiNodeAnchorAttributes",
    });
    expect(symbolMapOf(map).operations).toEqual({
      "delete /admin/identities/{id}": { type: "IdentityApi", method: "deleteIdentity" },
    });
  });

  it("Go: the request builder a consumer names, not the `Execute` that sends it", async () => {
    const map = await mapOf("openapi-generator-go", "go", "openapi-generator-python");
    expect(map.generators).toEqual(["openapi-generator"]);
    expect(goSymbolsOf(map).types).toMatchObject({
      jsonPatch: { package: "", key: "JsonPatch" },
    });
    expect(map.types["jsonPatch"]?.overlap).toBe(1);
    expect(goSymbolsOf(map).operations).toEqual({
      "delete /admin/identities/{id}": [
        { package: "", key: "IdentityAPIService.DeleteIdentity" },
      ],
    });
  });
});

describe("Speakeasy", () => {
  it("Python: lazy exports name the models, and the operation id finds the method", async () => {
    const map = await mapOf(
      "speakeasy-python",
      "python",
      "speakeasy-python",
      "mistralai",
    );
    expect(map.generators).toEqual(["speakeasy"]);
    expect(symbolMapOf(map).types).toMatchObject({
      UsageInfo: "mistralai.client.models.UsageInfo",
      ChatCompletionResponse: "mistralai.client.models.ChatCompletionResponse",
    });
    expect(map.operations["post /v1/chat/completions"]).toMatchObject({
      type: "mistralai.client.chat.Chat",
      method: "complete",
      via: "metadata",
    });
  });

  it("TypeScript: the SDK method that calls the function holding the request", async () => {
    const map = await mapOf("speakeasy-typescript", "typescript", "speakeasy-python");
    expect(map.generators).toEqual(["speakeasy"]);
    expect(symbolMapOf(map).types).toMatchObject({ UsageInfo: "UsageInfo" });
    expect(map.operations["post /v1/chat/completions"]).toMatchObject({
      type: "Chat",
      method: "complete",
      via: "metadata",
    });
  });
});

describe("Fern", () => {
  it("Python: `x-fern-type-name` names the type, and the wrapper beats the raw client", async () => {
    const map = await mapOf("fern-python", "python", "fern-python", "cohere");
    expect(map.generators).toEqual(["fern"]);
    expect(map.types["AssistantMessageV2"]).toMatchObject({
      symbol: "cohere.AssistantMessage",
      via: "metadata",
    });
    expect(map.operations["post /v2/chat"]).toMatchObject({
      type: "cohere.v2.client.V2Client",
      method: "chat",
      via: "metadata",
    });
  });

  it("TypeScript: the public method over the private one holding the request", async () => {
    const map = await mapOf("fern-typescript", "typescript", "fern-python");
    expect(map.generators).toEqual(["fern"]);
    expect(map.types["AssistantMessageV2"]).toMatchObject({
      symbol: "AssistantMessage",
      via: "metadata",
    });
    expect(symbolMapOf(map).operations).toEqual({
      "post /v2/chat": { type: "V2Client", method: "chat" },
    });
  });
});
