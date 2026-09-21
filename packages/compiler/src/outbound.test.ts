/**
 * What the provider sends of its own accord, a webhook or a callback, served
 * to a subscriber on an old contract the way a response is served to a
 * caller: compiled from the same Changes, run by the same instructions.
 */
import { findSchemaSites, type OpenApiDocument } from "@invariant/contract";
import { type Change, parseChange } from "@invariant/ir";
import { createRuntime, UnsupportedContractError } from "@invariant/runtime";
import { describe, expect, it } from "vitest";
import { chainProgram } from "./chain.ts";
import { predictDocument } from "./predict.ts";

type Invoice = Record<string, unknown>;

function billing(invoice: Invoice): OpenApiDocument {
  const body = {
    content: { "application/json": { schema: { $ref: "#/components/schemas/Invoice" } } },
  };
  return {
    openapi: "3.1.0",
    info: { title: "billing", version: "1" },
    paths: {
      "/subscriptions": {
        post: {
          operationId: "createSubscription",
          responses: { "201": { description: "made" } },
          callbacks: {
            onRenewal: {
              "{$request.body#/callbackUrl}": {
                post: { requestBody: body, responses: { "200": { description: "ok" } } },
              },
            },
          },
        },
      },
    },
    webhooks: {
      "invoice.paid": {
        post: { requestBody: body, responses: { "200": { description: "ok" } } },
      },
    },
    components: { schemas: { Invoice: { type: "object", properties: invoice } } },
  } as unknown as OpenApiDocument;
}

const status = (values: string[]) => ({ type: "string", enum: values });
const V1 = billing({
  amount: { type: "number", multipleOf: 0.01 },
  status: status(["paid", "open"]),
});
const V2 = billing({
  status: status(["paid", "open"]),
  amount_cents: { type: "integer" },
});
const V3 = billing({
  amount_cents: { type: "integer" },
  state: status(["paid", "open"]),
});

const CENTS: Change = parseChange({
  irVersion: 1,
  id: "chg_invoice_cents",
  summary: "Invoices carry minor units.",
  scopes: [{ schema: "#/components/schemas/Invoice" }],
  ops: [
    { op: "move", from: "/amount", to: "/amount_cents" },
    {
      op: "convert",
      path: "/amount_cents",
      codec: { kind: "scale10", exponent: 2, onInexact: "reject" },
    },
  ],
});
const STATE: Change = parseChange({
  irVersion: 1,
  id: "chg_invoice_state",
  summary: "An invoice's status is its state.",
  scopes: [{ schema: "#/components/schemas/Invoice" }],
  ops: [{ op: "move", from: "/status", to: "/state" }],
});

function runtimeFor() {
  const { program, issues } = chainProgram("billing", "v3", "sha256:3", [
    {
      label: "v2",
      parent: "v1",
      from: V1,
      to: predictDocument(V1, V2, [CENTS]).document,
      changes: [CENTS],
    },
    {
      label: "v3",
      parent: "v2",
      from: V2,
      to: predictDocument(V2, V3, [STATE]).document,
      changes: [STATE],
    },
  ]);
  expect(issues).toEqual([]);
  return {
    program,
    runtime: createRuntime({ program, identity: [{ kind: "default", label: "v1" }] }),
  };
}

const PAID = JSON.stringify({ amount_cents: 1999, state: "paid" });

describe("what the provider sends of its own accord", () => {
  it("is where a schema reaches the wire, for a webhook and a callback alike", () => {
    const sites = findSchemaSites(V1, "#/components/schemas/Invoice");
    expect(sites.unsupported).toEqual([]);
    expect(
      sites.sites.map((site) => `${site.direction} ${site.method} ${site.path}`).sort(),
    ).toEqual([
      "outbound post callback:createSubscription/onRenewal",
      "outbound post webhook:invoice.paid",
    ]);
  });

  it("is predicted, as the rest of the schema is", () => {
    const prediction = predictDocument(V1, V2, [CENTS]);
    expect(prediction.issues).toEqual([]);
    expect(JSON.stringify(prediction.document)).toBe(JSON.stringify(V2));
  });

  it("is sent to a subscriber in the shape their contract describes, latest step undone first", () => {
    const { runtime } = runtimeFor();
    for (const event of [
      "webhook:invoice.paid",
      "callback:createSubscription/onRenewal",
    ]) {
      expect(JSON.parse(runtime.adaptOutbound("v1", event, PAID).body)).toEqual({
        amount: 19.99,
        status: "paid",
      });
      expect(JSON.parse(runtime.adaptOutbound("v2", event, PAID).body)).toEqual({
        amount_cents: 1999,
        status: "paid",
      });
    }
  });

  it("is sent as it is to a subscriber on the current contract, and for an event nothing changed", () => {
    const { runtime } = runtimeFor();
    expect(runtime.adaptOutbound("v3", "webhook:invoice.paid", PAID).body).toBe(PAID);
    expect(runtime.adaptOutbound("v1", "webhook:customer.created", PAID).body).toBe(PAID);
  });

  it("is refused, not sent in a shape nobody promised, where the contract is switched off", () => {
    const { program } = runtimeFor();
    const runtime = createRuntime({
      program,
      identity: [{ kind: "default", label: "v1" }],
      flags: () => ({ disabledContracts: ["v1"] }),
    });
    expect(() => runtime.adaptOutbound("v1", "webhook:invoice.paid", PAID)).toThrow(
      UnsupportedContractError,
    );
  });
});
