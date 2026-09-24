import type { Change } from "@invariant-app/ir";
import { describe, expect, it } from "vitest";
import { buildPlan } from "./plan.ts";

const symbols = {
  package: "acme",
  upgradeTo: { package: "acme", version: "2.0.0" },
  types: {},
  accessors: [],
};

describe("values a field no longer takes", () => {
  it("are each old value an enumMap renames, and each value a dropValues leaves out, whatever the scope", () => {
    const changes = [
      {
        irVersion: 1,
        id: "chg_model",
        summary: "`legacy-1` is now `current-1`.",
        scopes: [{ operation: "createCompletion", location: "body" }],
        ops: [
          {
            op: "convert",
            path: "/model",
            codec: {
              kind: "enumMap",
              pairs: [
                ["legacy-1", "current-1"],
                ["same", "same"],
              ],
            },
          },
        ],
      },
      {
        irVersion: 1,
        id: "chg_methods",
        summary: "`sofort` is no longer a payment method.",
        scopes: [{ schema: "#/components/schemas/payment_intent" }],
        ops: [
          {
            op: "convert",
            path: "/payment_method_types/*",
            codec: { kind: "dropValues", values: ["sofort"] },
          },
        ],
      },
    ] as Change[];
    expect(buildPlan(changes, symbols).retiredValues).toEqual([
      { field: "model", value: "legacy-1", to: "current-1", changeId: "chg_model" },
      { field: "payment_method_types", value: "sofort", changeId: "chg_methods" },
    ]);
  });
});
