/**
 * L3: every id the pinned differ can report is in the catalogue.
 *
 * Asked of the binary itself, so a new oasdiff release that adds a check
 * fails here until someone decides what it means for a provider.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { catalogueEntry, isUnclassified } from "./catalogue.ts";
import { oasdiffBinary } from "./oasdiff.ts";
import { BREAKING_INFO_IDS, BREAKING_WARN_IDS } from "./policy.ts";

const run = promisify(execFile);

interface Check {
  id: string;
  level: "error" | "warning" | "info";
}

async function checks(): Promise<Check[] | undefined> {
  try {
    const { stdout } = await run(
      oasdiffBinary(),
      ["checks", "changelog", "--format", "json"],
      {
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return JSON.parse(stdout) as Check[];
  } catch {
    return undefined;
  }
}

const listed = await checks();

describe.skipIf(!listed)("the catalogue, against the pinned differ", () => {
  it("classifies every breaking check the binary knows", () => {
    const breaking = (listed ?? []).filter(
      (check) => catalogueEntry(check.id, check.level).class !== "non-breaking",
    );
    expect(breaking.length).toBeGreaterThan(300);
    expect(
      breaking.filter((check) => isUnclassified(check.id)).map((check) => check.id),
    ).toEqual([]);
  });

  it("gives every break a sentence, and calls non-breaking only what the gate lets pass", () => {
    for (const check of listed ?? []) {
      const entry = catalogueEntry(check.id, check.level);
      expect(entry.sentence.length, check.id).toBeGreaterThan(20);
      const gateBlocks =
        check.level === "error" ||
        BREAKING_WARN_IDS.has(check.id) ||
        BREAKING_INFO_IDS.has(check.id);
      expect(entry.class === "non-breaking", check.id).toBe(!gateBlocks);
    }
    // The pinned exceptions are ids the binary really prints.
    const ids = new Set((listed ?? []).map((check) => check.id));
    for (const id of [...BREAKING_WARN_IDS, ...BREAKING_INFO_IDS]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it("names an op wherever it says the runtime serves the break", () => {
    for (const check of listed ?? []) {
      const entry = catalogueEntry(check.id, check.level);
      if (entry.served === "yes") expect(entry.op, check.id).toBeDefined();
      if (entry.class === "behavior-only")
        expect(entry.served, check.id).toBe("not applicable");
    }
  });
});

describe("the catalogue's own rules", () => {
  it("decides by the most specific rule first", () => {
    expect(catalogueEntry("request-parameter-deprecated-sunset-missing").class).toBe(
      "process",
    );
    expect(catalogueEntry("api-path-removed-without-deprecation").op).toBe("retire");
    expect(catalogueEntry("request-property-max-length-decreased").class).toBe(
      "behavior-only",
    );
    expect(catalogueEntry("response-property-enum-value-added").served).toBe("yes");
    expect(catalogueEntry("response-header-max-unset").sentence).toContain(
      "declared loss",
    );
    expect(catalogueEntry("new-required-request-property-with-default").class).toBe(
      "adaptable",
    );
  });
});
