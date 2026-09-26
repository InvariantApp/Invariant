/**
 * Retroactive onboarding: a provider whose API already served earlier
 * versions puts them in front of the chain, with the Changes between them
 * drafted, and the gate then holds that history to the same standard as any
 * release.
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oasdiffAvailable } from "@invariant-app/diff";
import { afterEach, describe, expect, it } from "vitest";
import { check } from "./check.ts";
import { loadConfig } from "./config.ts";
import { HistoryError, importHistory } from "./history.ts";

const FIXTURE = new URL("../../../fixtures/provider-acme/", import.meta.url).pathname;
const hasOasdiff = await oasdiffAvailable();

let scratch: string | undefined;
afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/** A provider that adopted Invariant at 2026-01-15, with nothing pending. */
async function adopted(): Promise<string> {
  scratch = await mkdtemp(join(tmpdir(), "invariant-history-"));
  await mkdir(join(scratch, "openapi"), { recursive: true });
  await cp(
    join(FIXTURE, "openapi/2026-01-15.json"),
    join(scratch, "openapi/2026-01-15.json"),
  );
  await writeFile(
    join(scratch, "invariant.yaml"),
    [
      "api: acme-payments",
      "spec:",
      "  current: openapi/2026-01-15.json",
      '  currentLabel: "2026-01-15"',
      "  # What production serves today.",
      "  released:",
      '    "2026-01-15": openapi/2026-01-15.json',
      "",
    ].join("\n"),
  );
  return scratch;
}

/** The 2026-01-15 document as it was earlier, edited. */
async function earlier(
  root: string,
  name: string,
  edit: (
    schemas: Record<string, { properties: Record<string, unknown>; required?: string[] }>,
  ) => void,
): Promise<string> {
  const document = JSON.parse(
    await readFile(join(root, "openapi/2026-01-15.json"), "utf8"),
  );
  edit(document.components.schemas);
  const path = join(root, `${name}.json`);
  await writeFile(path, JSON.stringify(document), "utf8");
  return path;
}

describe.skipIf(!hasOasdiff)("importing history", () => {
  it("puts earlier contracts in front of the chain, and the gate checks them", async () => {
    const root = await adopted();
    // An earlier release had no description, so moving to the next one only
    // added it: nothing to draft, nothing to explain.
    const spec = await earlier(root, "v1", (schemas) => {
      delete schemas["Charge"]?.properties["description"];
      schemas["Charge"] = {
        ...(schemas["Charge"] as { properties: Record<string, unknown> }),
        required: ["id", "object", "amount", "currency", "source", "status", "created"],
      };
      delete schemas["ChargeCreateParams"]?.properties["description"];
    });
    const config = await loadConfig(join(root, "invariant.yaml"));
    const result = await importHistory(config, [{ label: "2025-06-01", spec }]);

    expect(result.added).toEqual(["2025-06-01"]);
    expect(result.steps).toMatchObject([{ from: "2025-06-01", to: "2026-01-15" }]);
    const yaml = await readFile(join(root, "invariant.yaml"), "utf8");
    // Edited as a document: the provider's comment is still there.
    expect(yaml).toContain("# What production serves today.");
    expect(yaml).toContain('"2025-06-01": invariant/contracts/2025-06-01.openapi.json');
    expect(
      await readFile(join(root, "invariant/released/2026-01-15/order.yaml"), "utf8"),
    ).toContain('parent: "2025-06-01"');

    const report = await check(await loadConfig(join(root, "invariant.yaml")));
    expect(report.steps.map((step) => `${step.from} -> ${step.to}`)).toEqual([
      "2025-06-01 -> 2026-01-15",
      "2026-01-15 -> 2026-01-15",
    ]);
    expect(report.steps[0]?.unexplained).toEqual([]);
    expect(report.result).not.toBe("block");
  });

  it("drafts what an earlier contract had and a later one dropped, as a decision to answer", async () => {
    const root = await adopted();
    const spec = await earlier(root, "v1", (schemas) => {
      const charge = schemas["Charge"] as {
        properties: Record<string, unknown>;
        required: string[];
      };
      charge.properties["livemode"] = { type: "boolean" };
      charge.required = [...charge.required, "livemode"];
    });
    const config = await loadConfig(join(root, "invariant.yaml"));
    const result = await importHistory(config, [{ label: "2025-06-01", spec }]);

    const drafts = result.steps[0]?.drafts ?? [];
    expect(
      drafts.some((draft) => draft.needsAnswer && draft.text.includes("livemode")),
    ).toBe(true);
    // A draft with its answer still open is refused, so history cannot slip
    // in unexplained.
    const report = await check(await loadConfig(join(root, "invariant.yaml")));
    expect(report.result).toBe("block");
  });

  it("refuses history that would not sort before what is already released", async () => {
    const root = await adopted();
    const spec = await earlier(root, "v1", () => {});
    const config = await loadConfig(join(root, "invariant.yaml"));
    await expect(importHistory(config, [{ label: "v1", spec }])).rejects.toThrow(
      /sorts after 2026-01-15/,
    );
    await expect(
      importHistory(config, [
        { label: "2025-06-01", spec },
        { label: "2025-01-01", spec },
      ]),
    ).rejects.toThrow(HistoryError);
  });
});
