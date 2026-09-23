import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Change } from "@invariant-app/ir";
import { beforeAll, describe, expect, it } from "vitest";
import { type GoMigrationResult, migrate } from "./engine.ts";
import { buildGoPlan, type GoMigrationPlan } from "./plan.ts";
import { diffSurfaces, type SurfaceObject, surfaceIn } from "./surface.ts";

const testdata = (path: string) =>
  fileURLToPath(new URL(`../testdata/${path}`, import.meta.url));
const CONSUMER = testdata("consumer");
const SOURCE = `${CONSUMER}/secrets.go`;
const COMMENTS = `${CONSUMER}/comments.go`;

const hasGo = spawnSync("go", ["version"]).status === 0;
if (!hasGo && process.env["INVARIANT_REQUIRE_GO"]) {
  throw new Error("INVARIANT_REQUIRE_GO is set and there is no Go toolchain on PATH");
}

const RETIRED =
  "/repositories/{repository_id}/environments/{environment_name}/secrets/{secret_name}";

const CHANGES: Change[] = [
  {
    irVersion: 1,
    id: "chg_secret_name",
    summary: "`name` is now `secret_name`.",
    scopes: [{ schema: "#/components/schemas/secret" }],
    ops: [{ op: "move", from: "/name", to: "/secret_name" }],
  },
  {
    irVersion: 1,
    id: "chg_env_secret_by_id",
    summary: "Environment secrets are no longer addressed by repository ID.",
    ops: [
      {
        op: "retire",
        endpoint: { method: "delete", path: RETIRED },
        guidance:
          "use DELETE /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}",
      },
    ],
  },
];

/** The 1-based lines of one of the consumer's files each site there covers. */
const linesOf = (result: GoMigrationResult, file = SOURCE) => {
  const text = readFileSync(file, "utf8");
  const lineAt = (offset: number) => text.slice(0, offset).split("\n").length;
  return result.manual
    .filter((site) => site.file === file)
    .map((site) => ({
      from: lineAt(site.offset),
      to: lineAt(site.end ?? site.offset),
      changeId: site.changeId,
      reason: site.reason,
    }));
};

describe.skipIf(!hasGo)("migrating a Go consumer", () => {
  let before: SurfaceObject[];
  let after: SurfaceObject[];
  let plan: GoMigrationPlan;
  let result: GoMigrationResult;

  beforeAll(async () => {
    before = await surfaceIn(testdata("sdk/v1"), "example.com/sdk", [""]);
    after = await surfaceIn(testdata("sdk/v2"), "example.com/sdk/v2", [""]);
    plan = buildGoPlan(
      CHANGES,
      {
        module: { path: "example.com/sdk", version: "v1.0.0" },
        upgradeTo: { path: "example.com/sdk/v2", version: "v2.0.0" },
        types: { secret: { package: "", key: "Secret" } },
        operations: {
          [`delete ${RETIRED}`]: [{ package: "", key: "ActionsService.DeleteEnvSecret" }],
        },
      },
      { before, after },
    );
    result = await migrate({
      repoDir: CONSUMER,
      moduleDir: CONSUMER,
      packages: ["./..."],
      plan,
    });
  }, 180_000);

  it("reads each release's surface, with wire names and operations", () => {
    expect(before.find((object) => object.key === "Secret.Total")).toMatchObject({
      kind: "field",
      type: "int",
      json: "total_count",
    });
    expect(
      before.find((object) => object.key === "ActionsService.DeleteEnvSecret"),
    ).toMatchObject({
      kind: "method",
      type: "func(context.Context, int, string, string) error",
      operations: [`DELETE ${RETIRED}`],
    });
  });

  it("claims only the renames that are exact", () => {
    const diff = diffSurfaces(before, after);
    expect(
      diff.renames.map((rename) => `${rename.from.key} -> ${rename.to}`).sort(),
    ).toEqual([
      "Secret.Total -> TotalCount",
      "VariableCreateRequest -> CreateVariableRequest",
    ]);
    // A method replaced by one calling the same operation with another body.
    expect(diff.replacements).toEqual([
      {
        from: { package: "", key: "IssuesService.EditComment" },
        to: "UpdateComment",
        params: [4],
        reason: expect.stringContaining("calls the same operation"),
      },
    ]);
    // A type that lost a field is not the type that replaced it.
    expect(
      diff.changes.find((change) => change.symbol.key === "EncryptedSecret"),
    ).toMatchObject({ removed: true });
  });

  it("moves the import and renames what the plan renames", () => {
    const text = result.files.get(SOURCE) ?? "";
    expect(text).toContain('"example.com/sdk/v2"');
    expect(text).toContain("names = append(names, secret.SecretName)");
    expect(text).toContain("total += secret.TotalCount");
    expect(text).toContain('sdk.CreateVariableRequest{Name: "A", Value: "b"}');
    // The literal's `Name` is EncryptedSecret's, which is never sent: untouched.
    expect(text).toContain('Name:  "TOKEN",');
    expect(result.edits.map((edit) => edit.changeId).sort()).toEqual([
      "chg_secret_name",
      "sdk-upgrade",
      "sdk-upgrade",
      "sdk-upgrade",
      "sdk-upgrade",
    ]);
  });

  it("shows every call to a retired operation to a person", () => {
    expect(linesOf(result)).toContainEqual(
      expect.objectContaining({
        from: 18,
        to: 18,
        changeId: "chg_env_secret_by_id",
        reason: expect.stringContaining("which the provider retired; use DELETE /repos/"),
      }),
    );
  });

  it("follows what no longer compiles to everything that has to change with it", () => {
    const flagged = linesOf(result)
      .filter((site) => site.changeId === "sdk-upgrade")
      .map((site) =>
        site.from === site.to ? `${site.from}` : `${site.from}-${site.to}`,
      );
    expect(flagged.sort()).toEqual(
      [
        // The call, the wrapper that forwards the ID, its interface, the
        // wrapper behind the interface, and the function that passes it in.
        "18",
        "17",
        "12",
        "24",
        "23",
        "29",
        "28",
        // The secret no longer made that way, and the call it is passed to.
        "34-37",
        "38",
      ].sort(),
    );
  });

  it("follows a replaced method's changed parameter through every implementation", () => {
    const sites = linesOf(result, COMMENTS);
    expect(sites.map((site) => site.from).sort((a, b) => a - b)).toEqual([
      // The interface, the wrapper's signature and its call, the fake that
      // implements the same method, and the function that passes a comment in.
      11, 16, 17, 24, 30, 31,
    ]);
    expect(sites.find((site) => site.from === 17)?.reason).toContain(
      "IssuesService.EditComment is now UpdateComment",
    );
  });

  it("finds nothing else broken, and leaves the consumer's files as they were", () => {
    expect(result.diagnosticsBefore).toEqual([]);
    expect(result.goMod?.mod).toContain("example.com/sdk/v2 v2.0.0");
    expect(readFileSync(SOURCE, "utf8")).toContain('"example.com/sdk"\n');
    expect(readFileSync(`${CONSUMER}/go.mod`, "utf8")).not.toContain("v2.0.0");
  });
});
