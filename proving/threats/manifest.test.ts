/**
 * The threat-model record is only worth what it can be held to. Every row of
 * DESIGN 11.1 is in it once, nothing is in it that DESIGN does not say, and
 * every test it names exists, in the file it names, under the title it gives.
 * A row claimed without a test, or a test renamed out from under its row,
 * fails here.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./harness.ts";
import { summarize, type ThreatManifest } from "./summary.ts";

const manifest = JSON.parse(
  readFileSync(join(ROOT, "proving/threats/manifest.json"), "utf8"),
) as ThreatManifest;

/** The first cell of every row of the table under "### 11.1 Threat model". */
function designRows(): string[] {
  const design = readFileSync(join(ROOT, "docs/DESIGN.md"), "utf8");
  const start = design.indexOf("### 11.1 Threat model");
  const end = design.indexOf("### 11.2", start);
  expect(start).toBeGreaterThan(-1);
  return design
    .slice(start, end)
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| Threat |"))
    .map((line) => (line.split("|")[1] ?? "").trim());
}

const references = [
  ...manifest.rows.flatMap((row) => row.tests ?? []),
  ...manifest.attacks.flatMap((attack) => attack.tests),
];

describe("the threat-model record", () => {
  it("has every row of DESIGN 11.1 once, and nothing else", () => {
    const rows = designRows();
    expect(rows.length).toBeGreaterThanOrEqual(12);
    expect(manifest.rows.map((row) => row.threat)).toEqual(rows);
  });

  it("names tests for every row it covers, and says where the rest lives", () => {
    for (const row of manifest.rows) {
      if (row.status === "out of scope") {
        expect(row.elsewhere, row.threat).toBeTruthy();
        expect(row.tests ?? [], row.threat).toEqual([]);
        continue;
      }
      expect(row.tests?.length, row.threat).toBeGreaterThan(0);
      expect(row.here, row.threat).toBeTruthy();
      if (row.status === "partly covered") {
        expect(Boolean(row.elsewhere) || (row.gaps?.length ?? 0) > 0, row.threat).toBe(
          true,
        );
      } else {
        expect(row.gaps ?? [], row.threat).toEqual([]);
      }
    }
  });

  it.each(references.map((reference) => [reference.file, reference]))(
    "names only tests that exist: %s",
    (_file, reference) => {
      const path = join(ROOT, reference.file);
      expect(existsSync(path), reference.file).toBe(true);
      const text = readFileSync(path, "utf8");
      for (const title of reference.titles) {
        expect(text.includes(title), `${reference.file}: ${title}`).toBe(true);
      }
    },
  );

  it("names every attack M10.1 lists for this repository", () => {
    expect(manifest.attacks.map((attack) => attack.attack)).toEqual([
      "Bundle tampering: signature, digest, predicate",
      "Replayed and stale webhooks",
      "Sponsored-link replay",
      "SSRF through the proxy's upstream configuration",
      "SSRF through a specification's $refs",
      "Request smuggling and header injection through the proxy",
      "Prototype pollution",
      "Transformation bombs",
      "Path traversal in migration workdirs",
      "Prompt injection",
    ]);
    expect(manifest.outOfScope.join("\n")).toMatch(/Cross-tenant probes/);
    expect(manifest.outOfScope.join("\n")).toMatch(/Token scope escapes/);
  });

  it("summarizes the way the scoreboard reads it", () => {
    const summary = summarize(manifest);
    expect(summary.rows).toBe(manifest.rows.length);
    expect(summary.covered + summary.partly + summary.outOfScope).toBe(summary.rows);
  });
});
