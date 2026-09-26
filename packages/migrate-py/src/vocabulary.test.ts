/**
 * A value of a type the SDK shares between fields is renamed only where it
 * certainly comes from the field whose values the Change renamed.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Change } from "@invariant-app/ir";
import { buildPlan } from "@invariant-app/migrate-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROOT } from "../../../conformance/migration/harness.ts";
import { migrate } from "./index.ts";

const SITE = join(ROOT, "python", "site");

const renamed: Change = {
  irVersion: 1,
  id: "chg_status",
  summary: "The status `active` is now `enabled`.",
  scopes: [{ schema: "#/components/schemas/customer" }],
  ops: [
    {
      op: "convert",
      path: "/status",
      codec: { kind: "enumMap", pairs: [["active", "enabled"]] },
    },
  ],
};

describe("a value of a type the SDK shares", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "invariant-vocabulary-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is shown where a helper is also handed something that is not the field", async () => {
    const file = join(dir, "main.py");
    await writeFile(
      file,
      [
        "import acme",
        "",
        "",
        "def is_live(status: acme.CustomerStatus) -> bool:",
        '    return status == "active"',
        "",
        "",
        "def check(customer: acme.Customer) -> list[bool]:",
        '    return [is_live(customer.status), is_live("inactive")]',
        "",
      ].join("\n"),
    );
    const types = { customer: "acme.Customer" };
    const result = await migrate({
      repoDir: dir,
      sources: [file],
      packages: [SITE],
      plan: buildPlan([renamed], {
        package: "acme",
        upgradeTo: { package: "acme", version: "2.0.0", types },
        types,
        accessors: [],
      }),
    });
    expect(result.files.get(file)).toBeUndefined();
    expect(result.manual.map((site) => site.line)).toEqual([5]);
  }, 60_000);
});
