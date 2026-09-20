/**
 * Proposals are drafts. What matters is that the ops follow from the shapes
 * rather than from the judge, and that an unsure pairing says so.
 */
import { describe, expect, it } from "vitest";
import type { FieldShape } from "./candidates.ts";
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

  it("says so when a type changed in a way it cannot express", () => {
    const { ops, notes } = opsFor(field("ref", "integer"), field("ref", "string"));
    expect(ops).toEqual([]);
    expect(notes.join(" ")).toContain("does not express");
  });
});
