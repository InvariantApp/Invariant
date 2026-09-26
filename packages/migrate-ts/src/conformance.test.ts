/**
 * The conformance suite, read by the TypeScript pack.
 *
 * Every scenario in `conformance/migration/scenarios.json` is migrated from
 * its TypeScript fixture on its own, against the SDK beside the fixtures, and
 * judged by the harness every pack shares. A scenario the pack does not yet
 * meet is recorded in the manifest as a gap; its test then asserts the gap
 * is still there, so closing one fails here until the manifest says so.
 */
import { join } from "node:path";
import type { SymbolMap } from "@invariant-app/migrate-core";
import { buildPlan } from "@invariant-app/migrate-core";
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

const SDK = join(ROOT, "typescript", "sdk");
const manifest = loadManifest();

/** How each of the SDK's styles names the contract's schemas. */
const TYPES: Record<Scenario["sdk"], Record<string, string>> = {
  handwritten: {
    customer: "Customer",
    customer_create_params: "CustomerCreateParams",
    address: "Address",
    card: "Card",
    merchant: "Merchant",
  },
  generated: {
    customer: "components.schemas.customer",
    customer_create_params: "components.schemas.customer_create_params",
    address: "components.schemas.address",
    card: "components.schemas.card",
  },
  "own-names": { customer: "CustomerInstance" },
};

function symbolsFor(scenario: Scenario): SymbolMap {
  const types = TYPES[scenario.sdk];
  return {
    package: "acme",
    // The same package at a new version, keeping its type names, so nothing
    // but what the Changes say is edited.
    upgradeTo: { package: "acme", version: "2.0.0", types },
    types,
    accessors: [],
    helpers: { toMinor: "toMinorUnits", fromMinor: "fromMinorUnits" },
    tags: { property: "object", schemas: { customer: "customer" } },
  };
}

describe("the TypeScript pack's conformance", () => {
  for (const scenario of manifest.scenarios) {
    it(`${scenario.id}: ${scenario.situation}`, async () => {
      const fixture = loadFixture("typescript", scenario);
      const result = await migrate({
        repoDir: fixture.dir,
        generated: [`${SDK}/`],
        sources: fixture.files,
        resolution: {
          baseUrl: SDK,
          paths: { acme: ["index.d.ts"], "acme/*": ["*"] },
        },
        plan: buildPlan(changesOf(manifest, scenario), symbolsFor(scenario)),
      });
      expectConformance(fixture, result);
    });
  }
});
