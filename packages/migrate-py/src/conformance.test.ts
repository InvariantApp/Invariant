/**
 * The conformance suite, read by the Python pack.
 *
 * Every scenario in `conformance/migration/scenarios.json` is migrated from
 * its Python fixture on its own, against the SDK installed beside the
 * fixtures as a `site-packages` directory, and judged by the harness every
 * pack shares. A scenario the pack does not yet meet is recorded in the
 * manifest as a gap; its test then asserts the gap is still there, so
 * closing one fails here until the manifest says so.
 */
import { join } from "node:path";
import { buildPlan, type SymbolMap } from "@invariant-app/migrate-core";
import { describe, it } from "vitest";
import {
  changesOf,
  expectConformance,
  loadFixture,
  loadManifest,
  ROOT,
  type Scenario,
} from "../../../conformance/migration/harness.ts";
import { migrate } from "./index.ts";

const SITE = join(ROOT, "python", "site");
const manifest = loadManifest();

/** How each of the SDK's styles names the contract's schemas. */
const TYPES: Record<Scenario["sdk"], Record<string, string>> = {
  handwritten: {
    customer: "acme.Customer",
    customer_create_params: "acme.CustomerCreateParams",
    address: "acme.Address",
    card: "acme.Card",
    merchant: "acme.Merchant",
  },
  generated: {
    customer: "acme.generated.models.Customer",
    customer_create_params: "acme.generated.models.CustomerCreateParams",
    address: "acme.generated.models.Address",
    card: "acme.generated.models.Card",
  },
  "own-names": { customer: "acme.Person" },
};

function symbolsFor(scenario: Scenario): SymbolMap {
  const types = TYPES[scenario.sdk];
  return {
    package: "acme",
    upgradeTo: { package: "acme", version: "2.0.0", types },
    types,
    accessors: [],
    helpers: { toMinor: "to_minor_units", fromMinor: "from_minor_units" },
    tags: { property: "object", schemas: { customer: "customer" } },
  };
}

describe("the Python pack's conformance", () => {
  for (const scenario of manifest.scenarios) {
    it(`${scenario.id}: ${scenario.situation}`, async () => {
      const fixture = loadFixture("python", scenario);
      const result = await migrate({
        repoDir: fixture.dir,
        sources: fixture.files,
        packages: [SITE],
        plan: buildPlan(changesOf(manifest, scenario), symbolsFor(scenario)),
      });
      expectConformance(fixture, result);
    }, 60_000);
  }
});
