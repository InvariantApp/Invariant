import type { AlignmentQuestion, FieldShape } from "@invariant-app/proposer";
import { describe, expect, it } from "vitest";
import { caseIdOf, familiesOf, labelled, mineQuestions } from "./mine.ts";

const field = (name: string, extra: Partial<FieldShape> = {}): FieldShape => ({
  name,
  pointer: `/${name}`,
  type: "string",
  format: undefined,
  enumValues: undefined,
  description: undefined,
  required: false,
  nullable: false,
  ...extra,
});

const question = (removed: FieldShape, candidates: FieldShape[]): AlignmentQuestion => ({
  kind: "alignment",
  schema: "Charge",
  operations: ["GET /charges/{id}"],
  removed,
  candidates,
});

const origin = {
  api: "stripe.com:api",
  provider: "stripe.com",
  from: "a",
  to: "b",
  url: "https://example.test/b.json",
};
const fields = () => ({
  oldFields: ["amount", "source"],
  newFields: ["amount", "payment_method"],
});

describe("families, by rule", () => {
  it("names a removal beside a decoy that shares a word", () => {
    expect(
      familiesOf(
        question(field("banner_text"), [field("banner_color", { type: "integer" })]),
        null,
      ),
    ).toEqual(["removal", "decoy"]);
  });

  it("names a value moved into an object as nesting", () => {
    expect(
      familiesOf(
        question(field("city"), [field("address", { type: "object" })]),
        "address",
      ),
    ).toEqual(["nesting"]);
  });

  it("names a unit and a type change", () => {
    expect(
      familiesOf(
        question(field("timeout_ms", { type: "integer" }), [
          field("timeout", { type: "string" }),
        ]),
        "timeout",
      ),
    ).toEqual(["type-change", "unit"]);
  });

  it("names two candidates of the removed field's type ambiguous", () => {
    expect(
      familiesOf(
        question(field("owner"), [field("maintainer"), field("author")]),
        "author",
      ),
    ).toEqual(["rename", "ambiguous"]);
  });
});

describe("mined questions", () => {
  it("are named by provider, schema and removed field, once each", () => {
    expect(caseIdOf("stripe.com:api", "PaymentIntent", "/charges/data")).toBe(
      "mined_stripe_payment_intent_charges_data",
    );
    const asked = question(field("source"), [field("payment_method")]);
    const mined = mineQuestions([asked, asked], origin, fields);
    expect(mined).toHaveLength(1);
    expect(mined[0]).toMatchObject({
      id: "mined_stripe_charge_source",
      context: fields(),
    });
  });

  it("become cases where the reader settled them, and not where they could not", () => {
    const mined = mineQuestions(
      [
        question(field("source"), [field("payment_method")]),
        question(field("amount"), [field("payment_method")]),
      ],
      origin,
      fields,
    );
    const cases = labelled(mined, [
      {
        id: "mined_stripe_charge_source",
        successor: "payment_method",
        rationale: "Moved.",
      },
      {
        id: "mined_stripe_charge_amount",
        successor: { unsure: true },
        rationale: "Unclear.",
      },
    ]);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      source: "mined:https://example.test/b.json",
      successor: "payment_method",
      tags: ["rename"],
      rationale: "stripe.com:api a to b. Moved.",
    });
  });

  it("refuse a label naming a field that is not on offer", () => {
    const mined = mineQuestions(
      [question(field("source"), [field("payment_method")])],
      origin,
      fields,
    );
    expect(() =>
      labelled(mined, [
        { id: "mined_stripe_charge_source", successor: "payment_intent", rationale: "" },
      ]),
    ).toThrow(/not one of its candidates/);
  });
});
