/**
 * A list whose order the API does not promise, compared as a set: two runs
 * that returned the same things in another order agree, and a thing that went
 * missing is still missed.
 */
import { describe, expect, it } from "vitest";
import { inDeclaredOrder, volatilePaths } from "./differential.ts";
import { parseScenario } from "./scenarios.ts";

const run = (items: { id: string; name: string }[]) => [
  { id: "list", status: 200, headers: {}, body: { data: items } },
];

describe("a list declared unordered", () => {
  const scenario = parseScenario(
    [
      "name: list tags",
      'contract: "2026-01-01"',
      "steps:",
      "  - id: list",
      "    request: { method: get, path: /v1/tags }",
      "unordered:",
      "  - step: list",
      "    pointer: /data",
      "    by: /name",
    ].join("\n"),
    "tags.yaml",
  );

  it("is read from the scenario", () => {
    expect(scenario.unordered).toEqual([{ step: "list", pointer: "/data", by: "/name" }]);
  });

  it("calibrates the same whatever order the items came in, by the key it names", () => {
    const declared = scenario.unordered ?? [];
    const first = run([
      { id: "t_9", name: "b" },
      { id: "t_4", name: "a" },
    ]);
    const second = run([
      { id: "t_7", name: "a" },
      { id: "t_2", name: "b" },
    ]);
    // In the order sent, every name looks volatile, and would go unchecked.
    expect([...volatilePaths(first, second)]).toContain("list/data/0/name");
    // Sorted by name, only the generated ids vary.
    expect(
      [
        ...volatilePaths(
          inDeclaredOrder(first, declared),
          inDeclaredOrder(second, declared),
        ),
      ].sort(),
    ).toEqual(["list/data/0/id", "list/data/1/id"]);
  });
});
