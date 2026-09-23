/**
 * What the lens laws do and do not catch, stated as tests.
 *
 * The negative cases matter as much as the positive one. A verification layer
 * that is believed to catch more than it does is worse than one whose limits
 * are written down, because the belief is what stops anyone building the layer
 * that would actually catch it.
 */
import { predictDocument } from "@invariant-app/compiler";
import type { OpenApiDocument } from "@invariant-app/contract";
import type { Change } from "@invariant-app/ir";
import { describe, expect, it } from "vitest";
import { checkLaws } from "./laws.ts";

/** A pair of contracts small enough to reason about by hand. */
function contracts(): { old: OpenApiDocument; head: OpenApiDocument } {
  const base: OpenApiDocument = {
    openapi: "3.1.0",
    info: { title: "money", version: "1" },
    // The schema has to reach the wire somewhere. A Change is scoped to a
    // schema, but everything downstream is keyed by the operations that schema
    // serves, so a contract with no paths would exercise nothing real.
    paths: {
      "/v1/payments": {
        post: {
          operationId: "payments.create",
          requestBody: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Payment" },
              },
            },
          },
          responses: {
            "200": {
              description: "the payment",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Payment" },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Payment: {
          type: "object",
          required: ["id", "amount", "status"],
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            amount: { type: "number", multipleOf: 0.01 },
            status: { type: "string", enum: ["succeeded", "failed", "pending"] },
          },
        },
      },
    },
  };
  return { old: base, head: structuredClone(base) };
}

const MONEY: Change = {
  irVersion: 1,
  id: "chg_minor_units",
  summary: "Money crosses the wire in minor units.",
  scopes: [{ schema: "#/components/schemas/Payment" }],
  ops: [
    { op: "move", from: "/amount", to: "/amount_cents" },
    {
      op: "convert",
      path: "/amount_cents",
      codec: { kind: "scale10", exponent: 2, onInexact: "reject" },
    },
  ],
};

function laws(old: OpenApiDocument, head: OpenApiDocument, changes: Change[]) {
  const predicted = predictDocument(old, head, changes);
  return checkLaws(old, predicted.document, changes, { runs: 300, seed: 7 });
}

describe("the lens laws", () => {
  it("hold for a rename plus a unit conversion", () => {
    const { old, head } = contracts();
    const report = laws(old, head, [MONEY]);

    expect(report.failures).toEqual([]);
    // One pass produces two records, because two different properties were
    // established: that nothing was refused, and that the round trips hold.
    expect(report.evidence.map((entry) => entry.kind)).toEqual([
      "E3-totality",
      "E4-laws",
    ]);
    expect(report.evidence.every((entry) => entry.result === "pass")).toBe(true);
  });

  it("catch a conversion that refuses a value the contract allows", () => {
    const { old, head } = contracts();
    // The contract says amounts carry two decimal places. Scaling by ten
    // leaves the second one behind, and the codec refuses rather than round.
    const report = laws(old, head, [
      {
        ...MONEY,
        ops: [
          { op: "move", from: "/amount", to: "/amount_cents" },
          {
            op: "convert",
            path: "/amount_cents",
            codec: { kind: "scale10", exponent: 1, onInexact: "reject" },
          },
        ],
      },
    ]);

    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.failures[0]?.detail).toMatch(/refused a value the contract allows/);
  });

  /**
   * A constant is invisible to a schema comparison.
   *
   * Closure compares the predicted specification with the real one. A restore
   * value lives in the Change, not in either specification, so no amount of
   * comparing them can tell whether it is a value the old contract allows.
   * Running it is the only way to find out, and an old consumer receiving a
   * status it has never heard of is exactly the breakage this product exists
   * to prevent.
   */
  it("catch a restore constant the old contract does not allow", () => {
    const { old, head } = contracts();
    const report = laws(old, head, [
      {
        irVersion: 1,
        id: "chg_status_dropped",
        summary: "Status left the payload.",
        scopes: [{ schema: "#/components/schemas/Payment" }],
        ops: [{ op: "remove", path: "/status", restore: "done" }],
        assertions: { loss_acknowledged: true },
      },
    ]);

    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.failures[0]?.detail).toMatch(
      /backward produced a value the old contract does not allow/,
    );
    expect(report.failures[0]?.detail).toMatch(/"done" is not one of/);
  });

  /** The same blind spot in the other direction: a default nobody validated. */
  it("catch a default the new contract does not allow", () => {
    const { old, head } = contracts();
    const withMethod = structuredClone(head);
    const schema = (
      withMethod["components"] as Record<
        string,
        Record<string, Record<string, Record<string, unknown>>>
      >
    )["schemas"]?.["Payment"] as Record<string, unknown>;
    (schema["properties"] as Record<string, unknown>)["capture_method"] = {
      type: "string",
      enum: ["automatic", "manual"],
    };
    schema["required"] = [...(schema["required"] as string[]), "capture_method"];

    const report = laws(old, withMethod, [
      {
        irVersion: 1,
        id: "chg_capture",
        summary: "Capture method became explicit.",
        scopes: [{ schema: "#/components/schemas/Payment" }],
        ops: [{ op: "add", path: "/capture_method", value: "auto" }],
        assertions: { loss_acknowledged: true },
      },
    ]);

    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.failures[0]?.detail).toMatch(/"auto" is not one of/);
  });

  /**
   * A field added to a schema only responses carry is taken out of old
   * callers' responses, and the proposer drafts it with a null value because
   * no request ever needs one. Qdrant 1.17's `uuid` on SegmentInfo was drafted
   * exactly so, at full confidence, and the gate then refused it for what the
   * forward half did to a request that cannot exist.
   */
  it("check only the directions a schema travels", () => {
    const { old, head } = contracts();
    for (const contract of [old, head]) {
      const create = (contract["paths"] as Record<string, Record<string, unknown>>)[
        "/v1/payments"
      ]?.["post"] as Record<string, unknown>;
      delete create["requestBody"];
    }
    const schema = (
      head["components"] as Record<
        string,
        Record<string, Record<string, Record<string, unknown>>>
      >
    )["schemas"]?.["Payment"] as Record<string, unknown>;
    (schema["properties"] as Record<string, unknown>)["uuid"] = { type: "string" };
    schema["required"] = [...(schema["required"] as string[]), "uuid"];

    const report = laws(old, head, [
      {
        irVersion: 1,
        id: "chg_payment_uuid_added",
        summary: "`uuid` is new and required on Payment.",
        scopes: [{ schema: "#/components/schemas/Payment" }],
        ops: [{ op: "add", path: "/uuid", value: null }],
      },
    ]);

    expect(report.failures).toEqual([]);
    expect(report.evidence.find((entry) => entry.kind === "E4-laws")?.summary).toMatch(
      /from the new contract to the old/,
    );
  });

  /**
   * A vocabulary with a name of its own is drafted as a Change to that schema
   * at its root, and its values are strings: no body to hold them. Run as a
   * whole body, the fold Qdrant 1.17's `UpdateStatus` was given looked as if
   * it had never run, and every such decision, once answered, was refused.
   */
  it("hold for a fold on a vocabulary that is a schema of its own", () => {
    const { old, head } = contracts();
    for (const [contract, values] of [
      [old, ["succeeded", "failed", "pending"]],
      [head, ["succeeded", "failed", "pending", "disputed"]],
    ] as const) {
      const schemas = (
        contract["components"] as Record<string, Record<string, Record<string, unknown>>>
      )["schemas"] as Record<string, Record<string, unknown>>;
      schemas["Status"] = { type: "string", enum: [...values] };
      (schemas["Payment"]?.["properties"] as Record<string, unknown>)["status"] = {
        $ref: "#/components/schemas/Status",
      };
    }

    const report = laws(old, head, [
      {
        irVersion: 1,
        id: "chg_status_vocabulary",
        summary: "`Status` can answer with values old callers never saw.",
        scopes: [{ schema: "#/components/schemas/Status" }],
        ops: [
          {
            op: "convert",
            path: "",
            codec: {
              kind: "enumMap",
              pairs: [
                ["succeeded", "succeeded"],
                ["failed", "failed"],
                ["pending", "pending"],
              ],
              fold: [["disputed", "failed"]],
            },
          },
        ],
        assertions: { loss_acknowledged: true },
      },
    ]);

    expect(report.failures).toEqual([]);
  });

  it("catch a value map that does not cover the vocabulary", () => {
    const { old, head } = contracts();
    const report = laws(old, head, [
      {
        irVersion: 1,
        id: "chg_status",
        summary: "Status vocabulary changed.",
        scopes: [{ schema: "#/components/schemas/Payment" }],
        ops: [
          {
            op: "convert",
            path: "/status",
            // `pending` is left out, so a payment in that state cannot be
            // expressed at all.
            codec: {
              kind: "enumMap",
              pairs: [
                ["succeeded", "paid"],
                ["failed", "failed"],
              ],
            },
          },
        ],
      },
    ]);

    expect(report.failures.length).toBeGreaterThan(0);
  });

  /**
   * The limit, kept as a passing test.
   *
   * Two values traded places. The round trip is still the identity, because
   * undoing a swapped bijection restores the original exactly, and the set of
   * values the new contract allows is unchanged. Neither the laws nor closure
   * can see it. Only running the real provider and comparing what it returns
   * can, which is why the differential check is not optional.
   */
  it("do NOT catch a value map whose pairs are swapped", () => {
    const { old, head } = contracts();
    const report = laws(old, head, [
      {
        irVersion: 1,
        id: "chg_status",
        summary: "Status vocabulary changed.",
        scopes: [{ schema: "#/components/schemas/Payment" }],
        ops: [
          {
            op: "convert",
            path: "/status",
            codec: {
              kind: "enumMap",
              pairs: [
                ["succeeded", "processing"],
                ["failed", "failed"],
                ["pending", "paid"],
              ],
            },
          },
        ],
      },
    ]);

    expect(report.failures).toEqual([]);
  });
});
