/**
 * The conformance suite, read by the Go pack.
 *
 * Every scenario in `conformance/migration/scenarios.json` is migrated from
 * its Go fixture on its own, a package of the module beside the SDK's two
 * releases, and judged by the harness every pack shares. A scenario the pack
 * does not yet meet is recorded in the manifest as a gap; its test then
 * asserts the gap is still there, so closing one fails here until the
 * manifest says so.
 *
 * The release moved to keeps the module path, so no import is moved, and the
 * check against it is left out: what does not compile after the edits is
 * the pack's widest net, which its own tests cover, and here would only say
 * again what each scenario's own site already says.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
  changesOf,
  expectConformance,
  loadFixture,
  loadManifest,
  ROOT,
  type Scenario,
} from "../../../conformance/migration/harness.ts";
import { migrate } from "./engine.ts";
import { buildGoPlan, type GoSymbolMap } from "./plan.ts";
import { type SurfaceObject, surfaceIn } from "./surface.ts";

const hasGo = spawnSync("go", ["version"]).status === 0;
if (!hasGo && process.env["INVARIANT_REQUIRE_GO"]) {
  throw new Error("INVARIANT_REQUIRE_GO is set and there is no Go toolchain on PATH");
}

const GO = join(ROOT, "go");
const MODULE = join(GO, "scenarios");
const manifest = loadManifest();

/** Where each of the SDK's styles declares the contract's schemas. */
const TYPES: Record<Scenario["sdk"], GoSymbolMap["types"]> = {
  handwritten: {
    customer: { package: "", key: "Customer" },
    customer_create_params: { package: "", key: "CustomerCreateParams" },
    address: { package: "", key: "Address" },
    card: { package: "", key: "Card" },
    merchant: { package: "", key: "Merchant" },
  },
  generated: {
    customer: { package: "gen", key: "Customer" },
    customer_create_params: { package: "gen", key: "CustomerCreateParams" },
    address: { package: "gen", key: "Address" },
    card: { package: "gen", key: "Card" },
  },
  "own-names": { customer: { package: "", key: "Person" } },
};

describe.skipIf(!hasGo)("the Go pack's conformance", () => {
  let surfaces: { before: SurfaceObject[]; after: SurfaceObject[] };

  beforeAll(async () => {
    surfaces = {
      before: await surfaceIn(join(GO, "sdk", "v1"), "example.com/sdk", ["", "gen"]),
      after: await surfaceIn(join(GO, "sdk", "v2"), "example.com/sdk", ["", "gen"]),
    };
  }, 180_000);

  for (const scenario of manifest.scenarios) {
    it(`${scenario.id}: ${scenario.situation}`, async () => {
      const fixture = loadFixture("go", scenario);
      const plan = buildGoPlan(
        changesOf(manifest, scenario),
        {
          module: { path: "example.com/sdk", version: "v1.0.0" },
          upgradeTo: { path: "example.com/sdk", version: "v2.0.0" },
          types: TYPES[scenario.sdk],
          tags: { property: "object", schemas: { customer: "customer" } },
          helpers: {
            toMinor: { package: "", key: "ToMinorUnits" },
            fromMinor: { package: "", key: "FromMinorUnits" },
          },
        },
        surfaces,
      );
      const result = await migrate({
        repoDir: MODULE,
        moduleDir: MODULE,
        packages: [`./${scenario.id}/...`],
        plan,
        verify: false,
      });
      expectConformance(fixture, result);
    }, 60_000);
  }
});
