/**
 * The commonest breaking change in the wild, and what we now say about it.
 *
 * A response enum gaining a value is the largest single category across 686
 * published version pairs and two thirds of everything Stripe does to its
 * callers. It was reported here as inexpressible, which was wrong: `enumMap`
 * takes a `fold`. What is genuinely not derivable is which existing value a
 * caller should be shown instead, so the job of this code is to name that
 * decision precisely rather than to guess it or to call it impossible.
 */
import { describe, expect, it } from "vitest";
import type { FieldShape, SchemaDelta } from "./candidates.ts";
import { foldDecisions } from "./vocabulary.ts";

function field(name: string, values?: string[]): FieldShape {
  return {
    name,
    pointer: `/${name}`,
    type: "string",
    format: undefined,
    enumValues: values,
    description: undefined,
    required: true,
    nullable: false,
  };
}

function delta(old: FieldShape, next: FieldShape): SchemaDelta {
  return {
    schema: "#/components/schemas/Payment",
    newSchema: "#/components/schemas/Payment",
    removed: [],
    added: [],
    altered: [{ old, new: next }],
    operations: ["payments.create"],
  };
}

describe("a response vocabulary that grew", () => {
  const grown = delta(
    field("status", ["pending", "done"]),
    field("status", ["pending", "done", "pending_review"]),
  );

  it("names the values a caller has never heard of", () => {
    const [decision] = foldDecisions([grown]);
    expect(decision?.gained).toEqual(["pending_review"]);
    expect(decision?.choices).toEqual(["pending", "done"]);
  });

  it("says why it is a decision and not an oversight", () => {
    const [decision] = foldDecisions([grown]);
    expect(decision?.why).toMatch(/decision about meaning/);
    expect(decision?.why).toMatch(/pending_review/);
  });

  it("writes the change out so that deciding is editing one word", () => {
    const [decision] = foldDecisions([grown]);
    expect(decision?.scaffold).toContain("kind: enumMap");
    // Existing values map to themselves, so the schema still type-checks.
    expect(decision?.scaffold).toContain("- [pending, pending]");
    expect(decision?.scaffold).toContain("- [done, done]");
    // And the new value is the only thing left to answer.
    expect(decision?.scaffold).toContain("- [pending_review, CHOOSE_ONE]");
    expect(decision?.scaffold).toContain("one of: pending, done");
  });

  it("says nothing when the vocabulary did not grow", () => {
    expect(
      foldDecisions([delta(field("s", ["a", "b"]), field("s", ["a", "b"]))]),
    ).toEqual([]);
  });

  it("stays out of the way when values were also lost", () => {
    // Values leaving have to be mapped somewhere, which is the alignment
    // question. Asking both at once would get a worse answer to each.
    expect(
      foldDecisions([delta(field("s", ["a", "b"]), field("s", ["a", "c"]))]),
    ).toEqual([]);
  });

  it("ignores fields that are not enums at all", () => {
    expect(foldDecisions([delta(field("note"), field("note"))])).toEqual([]);
  });

  it("asks once per field, with every new value listed", () => {
    const [decision] = foldDecisions([
      delta(field("s", ["a"]), field("s", ["a", "b", "c"])),
    ]);
    expect(decision?.gained).toEqual(["b", "c"]);
    expect(decision?.scaffold).toContain("- [b, CHOOSE_ONE]");
    expect(decision?.scaffold).toContain("- [c, CHOOSE_ONE]");
  });
});
