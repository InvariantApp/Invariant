/**
 * Conformance against the fixture's current build.
 *
 * The negative test is the one that matters. A specification that has drifted
 * from the code makes every other check in the system confident about the
 * wrong document, so it has to be caught here or it is not caught anywhere.
 */
import { join } from "node:path";
import { createAcmeApp } from "@fixtures/provider-acme";
import { loadContract } from "@invariant-app/contract";
import { isJsonObject, type JsonObject } from "@invariant-app/ir";
import type { Target } from "@invariant-app/verifier";
import { checkConformance, loadScenarios, type Scenario } from "@invariant-app/verifier";
import { describe, expect, it } from "vitest";

const FIXTURE = join(import.meta.dirname, "../fixtures/provider-acme");

function headTarget(): Promise<Target> {
  const app = createAcmeApp({ build: "head" });
  return Promise.resolve({
    fetch: async (request: Request) => app.fetch(request),
    close: async () => {},
  });
}

async function headScenarios(): Promise<Scenario[]> {
  const all = await loadScenarios(join(FIXTURE, "invariant/scenarios"));
  return all.filter((scenario) => scenario.contract === "head");
}

describe("conformance", () => {
  it("finds the current build matches its own specification", async () => {
    const head = await loadContract(join(FIXTURE, "openapi/head.json"), "head");
    const report = await checkConformance(
      head.document,
      "head",
      await headScenarios(),
      headTarget,
    );

    expect(report.failures).toEqual([]);
    expect(report.unknownOperations).toEqual([]);
    expect(report.evidence.every((entry) => entry.result === "pass")).toBe(true);
  });

  it("catches a specification that has drifted from the code", async () => {
    const head = await loadContract(join(FIXTURE, "openapi/head.json"), "head");

    // Someone renamed the field in the specification and not in the handler,
    // which is the ordinary way a contract goes stale. Every diff taken
    // against this document from now on would be describing an API that does
    // not exist.
    const drifted = structuredClone(head.document);
    const schemas = (drifted["components"] as JsonObject)["schemas"] as JsonObject;
    const payment = schemas["Payment"] as JsonObject;
    const properties = payment["properties"] as JsonObject;
    expect(isJsonObject(properties["amount_cents"])).toBe(true);
    properties["amount_minor"] = properties["amount_cents"] as JsonObject;
    delete properties["amount_cents"];
    payment["required"] = (payment["required"] as string[]).map((name) =>
      name === "amount_cents" ? "amount_minor" : name,
    );

    const report = await checkConformance(
      drifted,
      "head",
      await headScenarios(),
      headTarget,
    );

    expect(report.failures.length).toBeGreaterThan(0);
    const messages = report.failures.flatMap((failure) =>
      failure.violations.map((violation) => violation.message),
    );
    expect(messages.some((message) => message.includes("amount_minor"))).toBe(true);
  });
});
