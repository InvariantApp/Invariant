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
import type { OpenApiDocument } from "@invariant-app/contract";
import { parseChange } from "@invariant-app/ir";
import { createRuntime } from "@invariant-app/runtime";
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

  it("widens a union written behind a reference, for this use of it alone", () => {
    // Intercom writes `event_details: {$ref: event_details, nullable: true}`,
    // and the named union is what gains a branch. OpenAPI 3.0 ignores a
    // keyword beside a reference, the differ included, so the field is never
    // null and old callers are shown it left out.
    const parts = (withCall: boolean): OpenApiDocument =>
      ({
        openapi: "3.0.3",
        info: { title: "parts", version: "1" },
        paths: {
          "/parts": {
            get: {
              operationId: "getPart",
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/Part" },
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            Part: {
              type: "object",
              properties: {
                event_details: {
                  $ref: "#/components/schemas/EventDetails",
                  nullable: true,
                },
              },
            },
            EventDetails: {
              anyOf: [
                { $ref: "#/components/schemas/Snoozed" },
                ...(withCall ? [{ $ref: "#/components/schemas/CallSummary" }] : []),
              ],
            },
            Snoozed: { type: "object", properties: { until: { type: "integer" } } },
            ...(withCall
              ? {
                  CallSummary: {
                    type: "object",
                    properties: { text: { type: "string" } },
                  },
                }
              : {}),
          },
        },
      }) as unknown as OpenApiDocument;
    const call = parseChange({
      irVersion: 1,
      id: "chg_part_event_details",
      summary: "An event can be a call summary.",
      scopes: [{ schema: "#/components/schemas/Part" }],
      ops: [
        {
          op: "widen",
          path: "/event_details",
          variant: "#/components/schemas/CallSummary",
          show: "absent",
        },
      ],
      assertions: { loss_acknowledged: true },
    });
    const prediction = predictDocument(parts(false), parts(true), [call]);
    expect(prediction.issues).toEqual([]);
    const schemas = (
      prediction.document as unknown as {
        components: { schemas: Record<string, { anyOf?: unknown[] }> };
      }
    ).components.schemas;
    // The named union other schemas may share is left as it was.
    expect(schemas["EventDetails"]?.anyOf).toHaveLength(1);
  });

  it("leaves an item old callers cannot read out of the list", () => {
    const listed = (withGuest: boolean): OpenApiDocument => {
      const document = charges(withGuest) as unknown as {
        components: { schemas: Record<string, unknown> };
      };
      document.components.schemas["Charge"] = {
        type: "object",
        properties: {
          id: { type: "string" },
          owners: {
            type: "array",
            items: {
              anyOf: [
                { $ref: "#/components/schemas/Customer" },
                ...(withGuest ? [{ $ref: "#/components/schemas/Guest" }] : []),
              ],
            },
          },
        },
      };
      return document as unknown as OpenApiDocument;
    };
    const dropped = parseChange({
      ...change,
      ops: [
        {
          op: "widen",
          path: "/owners/*",
          variant: "#/components/schemas/Guest",
          show: "absent",
        },
      ],
    });
    const { program, issues } = chainProgram("charges", "v2", "sha256:2", [
      {
        label: "v2",
        parent: "v1",
        from: listed(false),
        to: listed(true),
        changes: [dropped],
      },
    ]);
    expect(issues).toEqual([]);
    const runtime = createRuntime({
      program,
      identity: [{ kind: "default", label: "v1" }],
    });
    const site = runtime.siteFor("v1", "get", "/charges");
    if (!site) throw new Error("no site");
    const owners = [
      { object: "guest", id: "gst_1" },
      { object: "customer", id: "cus_2" },
      { object: "guest", id: "gst_3" },
    ];
    expect(
      JSON.parse(
        runtime.transformResponse(
          site,
          200,
          JSON.stringify({ data: [{ id: "ch_1", owners }] }),
          {
            contract: "v1",
            operation: "listCharges",
          },
        ),
      ),
    ).toEqual({ data: [{ id: "ch_1", owners: [{ object: "customer", id: "cus_2" }] }] });
  });
});
