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
import { decisionChange } from "./decisions.ts";
import { CHOOSE_ONE, foldDecisions } from "./vocabulary.ts";

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

  it("drafts the change with the answer left open and the likeliest one beside it", () => {
    const [decision] = foldDecisions([grown]);
    if (!decision) throw new Error("no decision");
    const op = decisionChange(decision).ops[0];
    expect(op).toMatchObject({ op: "convert", path: "/status" });
    // Existing values map to themselves, so the schema still type-checks, and
    // the new one waits for a person rather than taking the suggestion.
    expect(op?.op === "convert" && op.codec).toEqual({
      kind: "enumMap",
      pairs: [
        ["pending", "pending"],
        ["done", "done"],
      ],
      fold: [["pending_review", CHOOSE_ONE]],
    });
    // The new value shares a name part with `pending`, so that is suggested.
    expect(decision.suggested.fold).toEqual([["pending_review", "pending"]]);
  });

  it("prefers a catch-all when the names share nothing more specific, as Plaid's errors", () => {
    const [decision] = foldDecisions([
      delta(
        field("error_type", ["INVALID_REQUEST", "API_ERROR", "ITEM_ERROR"]),
        field("error_type", [
          "INVALID_REQUEST",
          "API_ERROR",
          "ITEM_ERROR",
          "CRA_MONITORING_ERROR",
        ]),
      ),
    ]);
    expect(decision?.suggested.fold).toEqual([["CRA_MONITORING_ERROR", "API_ERROR"]]);
  });

  it("says nothing when the vocabulary did not grow", () => {
    expect(
      foldDecisions([delta(field("s", ["a", "b"]), field("s", ["a", "b"]))]),
    ).toEqual([]);
  });

  it("leaves one value out and one in to the rename draft", () => {
    // Drafted there as a rename for a person to confirm; asking again here
    // would ask twice.
    expect(
      foldDecisions([delta(field("s", ["a", "b"]), field("s", ["a", "c"]))]),
    ).toEqual([]);
  });

  it("asks once when values were both lost and gained, pairing and folding", () => {
    const [decision] = foldDecisions([
      delta(
        field("status", ["open", "in_review", "void"]),
        field("status", ["open", "review_pending", "canceled", "disputed"]),
      ),
    ]);
    expect(decision?.lost).toEqual(["in_review", "void"]);
    expect(decision?.suggested.pairs).toContainEqual(["in_review", "review_pending"]);
    // A gained value a lost one became is its new name, not a fold.
    expect(decision?.suggested.fold.map(([value]) => value)).not.toContain(
      "review_pending",
    );
  });

  it("ignores fields that are not enums at all", () => {
    expect(foldDecisions([delta(field("note"), field("note"))])).toEqual([]);
  });

  it("asks once per field, with every new value listed", () => {
    const [decision] = foldDecisions([
      delta(field("s", ["a"]), field("s", ["a", "b", "c"])),
    ]);
    expect(decision?.gained).toEqual(["b", "c"]);
    // Nothing about `b` or `c` resembles `a`, so nothing is suggested.
    expect(decision?.suggested.fold).toEqual([
      ["b", CHOOSE_ONE],
      ["c", CHOOSE_ONE],
    ]);
  });
});

describe("a suggestion", () => {
  it("is not made where the names share nothing, and never onto a value that means something", () => {
    const [decision] = foldDecisions([
      delta(
        field("status", ["succeeded", "failed", "pending"]),
        field("status", ["paid", "failed", "processing"]),
      ),
    ]);
    expect(decision?.suggested.pairs).toEqual([
      ["succeeded", "CHOOSE_ONE"],
      ["pending", "CHOOSE_ONE"],
    ]);
    // `processing` is not a failure, whatever the ranking would have liked.
    expect(decision?.suggested.fold).toEqual([
      ["paid", "CHOOSE_ONE"],
      ["processing", "CHOOSE_ONE"],
    ]);
  });
});
