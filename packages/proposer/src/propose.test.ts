/**
 * Proposals are drafts. What matters is that the ops follow from the shapes
 * rather than from the judge, and that an unsure pairing says so.
 */
import { describe, expect, it } from "vitest";
import { type FieldShape, schemaDeltas } from "./candidates.ts";
import { questionsFor } from "./judge.ts";
import { opsFor } from "./propose.ts";

function field(name: string, type: string, extra: Partial<FieldShape> = {}): FieldShape {
  return {
    name,
    pointer: `/${name}`,
    type,
    format: undefined,
    enumValues: undefined,
    description: undefined,
    required: true,
    nullable: false,
    ...extra,
  };
}

describe("deriving ops from the shapes", () => {
  it("reads the scale factor off the declared types, not off a judge", () => {
    const { ops } = opsFor(field("amount", "number"), field("amount_cents", "integer"));
    expect(ops).toEqual([
      { op: "move", from: "/amount", to: "/amount_cents" },
      {
        op: "convert",
        path: "/amount_cents",
        codec: { kind: "scale10", exponent: 2, onInexact: "reject" },
      },
    ]);
  });

  it("uses the suffix to pick the exponent", () => {
    const { ops } = opsFor(field("duration", "number"), field("duration_ms", "integer"));
    expect(ops[1]).toMatchObject({ codec: { exponent: 3 } });
  });

  it("emits a plain rename when nothing else changed", () => {
    const { ops } = opsFor(field("created", "integer"), field("created_at", "integer"));
    expect(ops).toEqual([{ op: "move", from: "/created", to: "/created_at" }]);
  });

  it("pairs an enum only when exactly one value moved", () => {
    const { ops } = opsFor(
      field("status", "string", { enumValues: ["succeeded", "failed"] }),
      field("status", "string", { enumValues: ["paid", "failed"] }),
    );
    expect(ops).toEqual([
      {
        op: "convert",
        path: "/status",
        codec: {
          kind: "enumMap",
          pairs: [
            ["failed", "failed"],
            ["succeeded", "paid"],
          ],
        },
      },
    ]);
  });

  it("refuses to guess when several enum values moved at once", () => {
    const { ops, notes } = opsFor(
      field("status", "string", { enumValues: ["a", "b", "c"] }),
      field("status", "string", { enumValues: ["x", "y", "c"] }),
    );
    // Which old value became which new one is not in the shapes, so no codec
    // is invented. The note says so in words a reviewer can act on.
    expect(ops).toEqual([]);
    expect(notes.join(" ")).toContain("Pair them up by hand");
  });

  /**
   * This used to assert that a scalar type change produced no ops, which
   * pinned a gap rather than a property: `cast` has always existed and this
   * emitted a note instead of using it. Running real APIs made the cost
   * visible. Aligning a renamed field explained the removal and left the type
   * difference behind as a fresh unexplained delta, so asking the model made
   * the totals worse rather than better.
   */
  it("converts a scalar type change rather than describing it", () => {
    const { ops, notes } = opsFor(field("ref", "integer"), field("ref", "string"));

    expect(ops).toEqual([
      {
        op: "convert",
        path: "/ref",
        codec: { kind: "cast", from: "integer", to: "string" },
      },
    ]);
    // A cast is not free of judgement, so the note says what to check.
    expect(notes.join(" ")).toContain("survives the conversion");
  });

  it("says so when a type changed in a way no codec expresses", () => {
    // Nothing converts an object into an array. This is a reshaping, and the
    // right answer is to say so rather than to invent a codec for it.
    const { ops, notes } = opsFor(field("payload", "object"), field("payload", "array"));

    expect(ops).toEqual([]);
    expect(notes.join(" ")).toContain("reshaping rather than a re-encoding");
  });
});

describe("the candidates a judge is offered", () => {
  const document = (schemas: Record<string, unknown>) =>
    ({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {},
      components: { schemas },
    }) as never;

  it("offers the fields inside a new wrapper, through the schemas it names", () => {
    const before = document({
      Filter: {
        type: "object",
        properties: { scope: { type: "string" }, view: { type: "string" } },
      },
    });
    const after = document({
      Filter: {
        type: "object",
        properties: { data: { $ref: "#/components/schemas/FilterData" } },
      },
      FilterData: {
        type: "object",
        properties: {
          id: { type: "string" },
          attributes: { $ref: "#/components/schemas/FilterAttributes" },
        },
      },
      FilterAttributes: {
        type: "object",
        properties: { scope: { type: "string" }, view: { type: "string" } },
      },
    });
    const questions = schemaDeltas(before, after).flatMap((delta) => questionsFor(delta));
    expect(questions.map((question) => question.removed.name)).toEqual(["scope", "view"]);
    expect(
      questions[0]?.candidates.map((candidate) => [candidate.name, candidate.pointer]),
    ).toEqual([
      ["data", "/data"],
      ["data.id", "/data/id"],
      ["data.attributes", "/data/attributes"],
      ["data.attributes.scope", "/data/attributes/scope"],
      ["data.attributes.view", "/data/attributes/view"],
    ]);
  });

  it("offers a large wrapper only as deep as a whole level stays within reason", () => {
    const restrictions = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `rule${index}`,
        {
          type: "object",
          properties: { operation: { type: "string" }, value: { type: "string" } },
        },
      ]),
    );
    const before = document({
      Rule: { type: "object", properties: { rule3: { type: "string" } } },
    });
    const after = document({
      Rule: {
        type: "object",
        properties: { restrictions: { type: "object", properties: restrictions } },
      },
    });
    const [question] = schemaDeltas(before, after).flatMap((delta) =>
      questionsFor(delta),
    );
    expect(question?.candidates).toHaveLength(21);
    expect(question?.candidates.map((candidate) => candidate.name)).toContain(
      "restrictions.rule3",
    );
  });
});
