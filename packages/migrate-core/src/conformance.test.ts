/**
 * The conformance suite itself: its manifest, and a fixture for every
 * scenario in every language a pack reads.
 *
 * Each pack's own test runs the scenarios through that pack. This checks what
 * none of them can on its own: that the Changes are valid IR, that every
 * scenario applies Changes the manifest holds and says what it expects, that
 * a recorded gap is a gap in a language there is a pack for, and that no
 * language is missing a fixture, or keeps one for a scenario that is gone.
 * A fourth language starts here, as a list of what it has yet to write.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseChange } from "@invariant-app/ir";
import { describe, expect, it } from "vitest";
import {
  LANGUAGES,
  loadFixture,
  loadManifest,
  ROOT,
} from "../../../conformance/migration/harness.ts";

const manifest = loadManifest();

describe("the conformance manifest", () => {
  it("holds valid Changes, each applied by some scenario", () => {
    for (const change of manifest.changes) expect(parseChange(change)).toEqual(change);
    const applied = new Set(manifest.scenarios.flatMap((scenario) => scenario.changes));
    expect(
      manifest.changes.map((change) => change.id).filter((id) => !applied.has(id)),
    ).toEqual([]);
  });

  it("says, for every scenario, which Changes it applies and what must happen", () => {
    const ids = manifest.scenarios.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    const changes = new Set(manifest.changes.map((change) => change.id));
    for (const scenario of manifest.scenarios) {
      expect(scenario.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(scenario.situation).toMatch(/^[A-Z].*\.$/);
      expect(scenario.changes.length).toBeGreaterThan(0);
      expect(scenario.changes.filter((id) => !changes.has(id))).toEqual([]);
      expect(["edit", "flag", "none"]).toContain(scenario.expect);
      // A flag is expected somewhere in particular, and only a flag is.
      expect(scenario.place !== undefined).toBe(scenario.expect === "flag");
      for (const [language, gap] of Object.entries(scenario.gaps ?? {})) {
        expect(LANGUAGES).toContain(language);
        expect(["edit", "flag", "none", "edit+flag"]).toContain(gap.observed);
        expect(gap.reason).toMatch(/^[A-Z].*\.$/);
      }
    }
  });

  for (const language of LANGUAGES) {
    it(`has a ${language} fixture for every scenario, and none for anything else`, () => {
      for (const scenario of manifest.scenarios) loadFixture(language, scenario);
      const dir = join(ROOT, language, "scenarios");
      const written = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      const ids = new Set(manifest.scenarios.map((scenario) => scenario.id));
      expect(written.filter((name) => !ids.has(name))).toEqual([]);
      expect(existsSync(dir)).toBe(true);
    });
  }
});
