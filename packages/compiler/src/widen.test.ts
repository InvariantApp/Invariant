/**
 * A union in a response that can now hold a kind of object old callers never
 * heard of, compiled and run.
 *
 * Stripe's expandable fields gain object types between versions: a payment
 * source that can now be a new kind of object, a balance transaction whose
 * source can now be one more thing. An old caller's contract has no branch
 * for it, and the old union already allows the object's id, which is exactly
 * what Stripe sends for a field the caller did not expand.
 */
import type { OpenApiDocument } from "@invariant/contract";
import { parseChange } from "@invariant/ir";
import { createRuntime } from "@invariant/runtime";
import { describe, expect, it } from "vitest";
import { chainProgram } from "./chain.ts";
import { derive } from "./derive.ts";
import { predictDocument } from "./predict.ts";

function charges(withGuest: boolean): OpenApiDocument {
  const customer = {
    anyOf: [
      { type: "string" },
      { $ref: "#/components/schemas/Customer" },
      ...(withGuest ? [{ $ref: "#/components/schemas/Guest" }] : []),
    ],
  };
  const typed = (value: string) => ({
    type: "object",
    required: ["object", "id"],
    properties: {
      object: { type: "string", enum: [value] },
      id: { type: "string" },
    },
  });
  return {
    openapi: "3.1.0",
    info: { title: "charges", version: "1" },
    paths: {
      "/charges": {
        get: {
          operationId: "listCharges",
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      data: {
                        type: "array",
                        items: { $ref: "#/components/schemas/Charge" },
                      },
                    },
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
        Charge: { type: "object", properties: { id: { type: "string" }, customer } },
        Customer: typed("customer"),
        ...(withGuest ? { Guest: typed("guest") } : {}),
      },
    },
  } as unknown as OpenApiDocument;
}

const before = charges(false);
const after = charges(true);
const change = parseChange({
  irVersion: 1,
  id: "chg_guest_customer",
  summary: "A charge's customer can be a guest.",
  scopes: [{ schema: "#/components/schemas/Charge" }],
  ops: [
    { op: "widen", path: "/customer", variant: "#/components/schemas/Guest", show: "id" },
  ],
  assertions: { loss_acknowledged: true },
});

describe("a union that gained a kind of object", () => {
  it("is predicted as the new contract has it", () => {
    const prediction = predictDocument(before, after, [change]);
    expect(prediction.issues).toEqual([]);
    const predicted = prediction.document as unknown as {
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    };
    expect(predicted.components.schemas["Guest"]).toBeDefined();
    expect(predicted.components.schemas["Charge"]?.properties?.["customer"]).toEqual(
      (after as unknown as typeof predicted).components.schemas["Charge"]?.properties?.[
        "customer"
      ],
    );
  });

  it("is a declared loss", () => {
    expect(derive(change).runtime).toBe("declared-lossy");
  });

  it("shows old callers a guest as its id, and every other value as it was", () => {
    const { program, issues } = chainProgram("charges", "v2", "sha256:2", [
      { label: "v2", parent: "v1", from: before, to: after, changes: [change] },
    ]);
    expect(issues).toEqual([]);
    const runtime = createRuntime({
      program,
      identity: [{ kind: "default", label: "v1" }],
    });
    const site = runtime.siteFor("v1", "get", "/charges");
    if (!site) throw new Error("no site");
    const answer = {
      data: [
        { id: "ch_1", customer: "cus_1" },
        { id: "ch_2", customer: { object: "customer", id: "cus_2" } },
        { id: "ch_3", customer: { object: "guest", id: "gst_3" } },
      ],
    };
    expect(
      JSON.parse(
        runtime.transformResponse(site, 200, JSON.stringify(answer), {
          contract: "v1",
          operation: "listCharges",
        }),
      ),
    ).toEqual({
      data: [
        { id: "ch_1", customer: "cus_1" },
        { id: "ch_2", customer: { object: "customer", id: "cus_2" } },
        { id: "ch_3", customer: "gst_3" },
      ],
    });
  });

  it("refuses to show null where the old union is never null", () => {
    const noId = parseChange({
      ...change,
      ops: [
        {
          op: "widen",
          path: "/customer",
          variant: "#/components/schemas/Guest",
          show: "null",
        },
      ],
    });
    const prediction = predictDocument(before, after, [noId]);
    expect(prediction.issues.map((issue) => issue.message).join()).toMatch(/never null/);
  });
});
