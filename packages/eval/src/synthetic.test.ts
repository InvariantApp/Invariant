/**
 * Made-up answers have to be answers a provider could have given, or the
 * "with decisions" number measures the answers rather than the reach.
 */
import type { Change } from "@invariant-app/ir";
import { CHOOSE_ONE, type FieldShape, foldDecisions } from "@invariant-app/proposer";
import { describe, expect, it } from "vitest";
import { syntheticAnswer } from "./synthetic.ts";

function field(values: string[]): FieldShape {
  return {
    name: "status",
    pointer: "/status",
    type: "string",
    format: undefined,
    enumValues: values,
    description: undefined,
    required: true,
    nullable: false,
  };
}

function answer(old: string[], next: string[]) {
  const [decision] = foldDecisions([
    {
      schema: "#/components/schemas/Payment",
      newSchema: "#/components/schemas/Payment",
      removed: [],
      added: [],
      altered: [{ old: field(old), new: field(next) }],
      operations: ["payments.create"],
    },
  ]);
  if (!decision) throw new Error("no decision");
  const change = syntheticAnswer(decision);
  const op = change.ops[0] as Extract<Change["ops"][number], { op: "convert" }>;
  if (op.codec.kind !== "enumMap") throw new Error("not an enum map");
  return { change, codec: op.codec };
}

describe("a synthetic answer", () => {
  it("takes the suggestion where there is one", () => {
    const { codec } = answer(["pending", "done"], ["pending", "done", "pending_review"]);
    expect(codec.fold).toEqual([["pending_review", "pending"]]);
  });

  it("folds onto a value the old contract names where nothing is suggested", () => {
    const { codec } = answer(["a"], ["a", "b", "c"]);
    expect(codec.fold).toEqual([
      ["b", "a"],
      ["c", "a"],
    ]);
  });

  it("gives a lost value a new name, and does not also fold that name", () => {
    const { codec } = answer(
      ["succeeded", "failed", "pending"],
      ["paid", "failed", "processing"],
    );
    const renamedTo = codec.pairs.filter(([from, to]) => from !== to).map(([, to]) => to);
    expect(renamedTo.sort()).toEqual(["paid", "processing"]);
    expect(codec.fold ?? []).toEqual([]);
  });

  it("merges a lost value into a kept one when nothing new is left to be its name", () => {
    const { codec } = answer(
      ["open", "void", "stale", "closed"],
      ["open", "closed", "archived"],
    );
    const lost = codec.pairs.filter(([from]) => from === "void" || from === "stale");
    expect(lost.map(([, to]) => to).sort()).toEqual(["archived", "open"]);
    expect(codec.fold ?? []).toEqual([]);
  });

  it("leaves no placeholder anywhere, and says it was made up", () => {
    const { change } = answer(
      ["open", "in_review", "void"],
      ["open", "review_pending", "canceled", "disputed"],
    );
    expect(JSON.stringify(change)).not.toContain(CHOOSE_ONE);
    expect(change.id).toMatch(/_synthetic$/);
    expect(change.id.length).toBeLessThanOrEqual(128);
  });
});
