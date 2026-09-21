/**
 * One oasdiff version, everywhere it is written down.
 *
 * The published action, CI and the error text once named three different
 * releases, and the action's was the one CI had abandoned for giving different
 * answers on different runs. This reads every file that names a version and
 * fails if any of them disagrees with the constant.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareVersions, OASDIFF_VERSION, unusableVersion } from "./version.ts";

const ROOT = join(import.meta.dirname, "../../..");

/**
 * Files that name a release in an install command. CI is not among them: it
 * fetches the binary through scripts/fetch-oasdiff.mts, which reads the
 * constant itself.
 */
const PINNED_IN = ["action.yml", "docs/quickstart.md", "README.md"];

describe("the pinned oasdiff release", () => {
  for (const file of PINNED_IN) {
    it(`is the one ${file} installs`, async () => {
      const text = await readFile(join(ROOT, file), "utf8");
      const named = [...text.matchAll(/oasdiff(?:\/oasdiff)?@([\w.-]+)/g)].map(
        (match) => match[1],
      );
      expect(
        named.length,
        `${file} should say which release it installs`,
      ).toBeGreaterThan(0);
      for (const version of named) expect(version).toBe(OASDIFF_VERSION);
    });
  }
});

describe("the startup check", () => {
  it("refuses a release older than the pin", () => {
    expect(unusableVersion("oasdiff version v1.32.1")).toContain("older than");
  });

  it("accepts the pin and anything newer", () => {
    expect(unusableVersion(`oasdiff version ${OASDIFF_VERSION}`)).toBeUndefined();
    expect(unusableVersion("oasdiff version v1.33.0")).toBeUndefined();
    expect(unusableVersion("oasdiff version v1.40.2")).toBeUndefined();
  });

  it("accepts a build that cannot say which release it is", () => {
    // `go install` builds report "main". Refusing them would refuse the very
    // install command this project recommends.
    expect(unusableVersion("oasdiff version main")).toBeUndefined();
  });

  it("orders a release after its own pre-releases", () => {
    expect(compareVersions("v1.33.0-rc.1", "v1.33.0")).toBeLessThan(0);
    expect(compareVersions("v1.33.0-rc.2", "v1.33.0-rc.10")).toBeLessThan(0);
    expect(compareVersions("v1.33.0", "v1.32.9")).toBeGreaterThan(0);
  });
});
