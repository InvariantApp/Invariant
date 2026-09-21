/**
 * Folding a response value an old caller has never heard of.
 *
 * A response enum gaining a value is the largest category of real breaking
 * change there is: across 686 published version pairs it is the commonest
 * single delta, and two thirds of everything Stripe does to its callers. It
 * was called inexpressible here for a while, on the reasoning that a new value
 * has nothing to map back to. That is true of the documents and false of the
 * provider, who knows which existing value an old caller should be shown.
 *
 * The direction is deliberately asymmetric. A caller written against the old
 * contract cannot send a value that contract never named, so a fold applies to
 * responses and never to requests.
 */
import type { Change, ConvertOp } from "@invariant/ir";
import { describe, expect, it } from "vitest";
import { derive } from "./derive.ts";
import { instrsFor } from "./project.ts";
import { applyCodecToSchema } from "./schema.ts";

function change(fold?: [string, string][]): Change {
  return {
    irVersion: 1,
    id: "chg_status_vocabulary",
    summary: "The status vocabulary gained a value.",
    scopes: [{ schema: "#/components/schemas/Payment" }],
    ops: [
      {
        op: "convert",
        path: "/status",
        codec: {
          kind: "enumMap",
          pairs: [
            ["pending", "pending"],
            ["done", "done"],
          ],
          ...(fold ? { fold } : {}),
        },
      },
    ],
  };
}

const mapOf = (instrs: readonly { k: string }[]): Record<string, string> | undefined =>
  (instrs.find((instr) => instr.k === "enum") as { map?: Record<string, string> })?.map;

describe("a response value the old contract never named", () => {
  it("reaches the caller as the value the provider chose", () => {
    const { backward } = instrsFor(change([["pending_review", "pending"]]));
    expect(mapOf(backward)).toEqual({
      pending: "pending",
      done: "done",
      pending_review: "pending",
    });
  });

  it("marks which keys are folds, so the runtime can disclose them", () => {
    // Without this the runtime cannot tell a fold from a rename, and a fold is
    // the one substitution a caller has no way to detect on their own.
    const { backward } = instrsFor(change([["pending_review", "pending"]]));
    const enumInstr = backward.find((instr) => instr.k === "enum") as {
      folded?: string[];
    };
    expect(enumInstr.folded).toEqual(["pending_review"]);
  });

  it("marks nothing when there is nothing folded", () => {
    const { backward } = instrsFor(change());
    const enumInstr = backward.find((instr) => instr.k === "enum") as {
      folded?: string[];
    };
    expect(enumInstr.folded).toBeUndefined();
  });

  it("is not folded on the way in, because it cannot arrive", () => {
    const { forward } = instrsFor(change([["pending_review", "pending"]]));
    expect(mapOf(forward)).toEqual({ pending: "pending", done: "done" });
  });

  it("is declared lossy, because the caller cannot tell the cases apart", () => {
    const derived = derive(change([["pending_review", "pending"]]));
    expect(derived.runtime).toBe("declared-lossy");
    expect(derived.reasons.join(" ")).toMatch(/folds 1 new value/);
  });

  it("stays exact when nothing is folded", () => {
    expect(derive(change()).runtime).toBe("exact");
  });

  it("grows the predicted schema, so closure sees the addition explained", () => {
    // Without this the closure check reports the added value as an unexplained
    // delta, which is the very thing the fold exists to account for.
    const op = change([["pending_review", "pending"]]).ops[0] as ConvertOp;
    const grown = applyCodecToSchema(
      { type: "string", enum: ["pending", "done"] },
      op.codec,
    ) as { enum: string[] };
    expect([...grown.enum].sort()).toEqual(["done", "pending", "pending_review"]);
  });

  it("folds several new values onto whichever old value fits each", () => {
    const { backward } = instrsFor(
      change([
        ["pending_review", "pending"],
        ["manually_approved", "done"],
      ]),
    );
    expect(mapOf(backward)).toMatchObject({
      pending_review: "pending",
      manually_approved: "done",
    });
  });
});
