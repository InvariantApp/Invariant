import { parseChange } from "@invariant/ir";
import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import type { MigrationPlan } from "./plan.ts";
import { matchesTemplate, migrateRawCallSites } from "./raw.ts";

describe("tying a raw call's path to an operation", () => {
  it("matches a custom method whose parameter shares its segment", () => {
    expect(matchesTemplate("/v1/{name}:cancel", ["", "v1", "op-7:cancel"])).toBe(true);
    expect(matchesTemplate("/v1/{name}:cancel", ["", "v1", "op-7:get"])).toBe(false);
    // A segment built from a variable might be the custom method.
    expect(matchesTemplate("/v1/{name}:cancel", ["", "v1", undefined])).toBe(true);
  });

  it("keeps a fixed segment from matching a different fixed segment", () => {
    expect(matchesTemplate("/v1/things/{id}", ["", "v1", "things", "a"])).toBe(true);
    expect(matchesTemplate("/v1/things/{id}", ["", "v1", "other", "a"])).toBe(false);
    expect(matchesTemplate("/v1/things", ["", "v1", undefined])).toBe(false);
  });
});

describe("a value whose encoding changed", () => {
  it("is flagged where it is sent and where it is read, never moved and left as it was", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      "/repo/src/events.ts",
      [
        "export async function record(at: number) {",
        '  const response = await fetch("/v1/events", {',
        '    method: "POST",',
        "    body: JSON.stringify({ created: at }),",
        "  });",
        "  const event = (await response.json()) as Record<string, unknown>;",
        '  return event["created"] as number;',
        "}",
      ].join("\n"),
    );
    const change = parseChange({
      irVersion: 1,
      id: "chg_created_text",
      summary: "Times are text.",
      scopes: [{ schema: "#/components/schemas/Event" }],
      ops: [
        {
          op: "convert",
          path: "/created",
          codec: { kind: "dateFormat", from: "epoch-s", to: "rfc3339" },
        },
      ],
    });
    const result = migrateRawCallSites(
      project,
      {
        symbols: {
          package: "events",
          upgradeTo: { package: "events", version: "2.0.0" },
          types: {},
          accessors: [],
        },
        targets: [],
        typeRenames: [],
        accessorRenames: [],
        changes: [change],
      } as MigrationPlan,
      { repoDir: "/repo", generated: [] },
      {
        operations: [{ method: "post", path: "/v1/events", operationId: "createEvent" }],
      },
    );
    const flagged = result.manual.map((entry) => entry.reason);
    expect(flagged).toHaveLength(2);
    for (const reason of flagged) {
      expect(reason).toContain("`created` is now written as rfc3339 instead of epoch-s");
    }
    expect(result.edits).toEqual([]);
  });
});
