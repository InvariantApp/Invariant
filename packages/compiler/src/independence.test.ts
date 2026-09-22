import type { Change } from "@invariant-app/ir";
import { describe, expect, it } from "vitest";
import { findInterference } from "./independence.ts";

function change(id: string, schema: string, ops: Change["ops"]): Change {
  return {
    irVersion: 1,
    id,
    summary: id,
    scopes: [{ schema: `#/components/schemas/${schema}` }],
    ops,
  };
}

describe("order independence", () => {
  it("accepts Changes that touch different fields", () => {
    expect(
      findInterference([
        change("chg_a", "Payment", [
          { op: "move", from: "/amount", to: "/amount_cents" },
        ]),
        change("chg_b", "Payment", [
          { op: "add", path: "/capture_method", value: "automatic" },
        ]),
      ]),
    ).toEqual([]);
  });

  it("accepts Changes that touch the same field name in different schemas", () => {
    expect(
      findInterference([
        change("chg_a", "Payment", [
          { op: "move", from: "/amount", to: "/amount_cents" },
        ]),
        change("chg_b", "Refund", [{ op: "move", from: "/amount", to: "/total" }]),
      ]),
    ).toEqual([]);
  });

  it("reports two Changes that write the same field", () => {
    const issues = findInterference([
      change("chg_a", "Payment", [{ op: "move", from: "/amount", to: "/amount_cents" }]),
      change("chg_b", "Payment", [{ op: "move", from: "/amount", to: "/total" }]),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("chg_a");
    expect(issues[0]?.message).toContain("order changes the result");
  });

  it("reports a Change that moves a field another Change reaches inside of", () => {
    const issues = findInterference([
      change("chg_a", "Payment", [
        { op: "move", from: "/source", to: "/payment_method/token" },
      ]),
      change("chg_b", "Payment", [
        {
          op: "convert",
          path: "/payment_method/token",
          codec: { kind: "cast", from: "string", to: "string" },
        },
      ]),
    ]);
    expect(issues).not.toEqual([]);
  });

  it("treats a wildcard as covering every element it stands for", () => {
    const issues = findInterference([
      change("chg_a", "List", [
        { op: "move", from: "/data/*/amount", to: "/data/*/total" },
      ]),
      change("chg_b", "List", [{ op: "remove", path: "/data/*/amount", restore: 0 }]),
    ]);
    expect(issues).not.toEqual([]);
  });
});
