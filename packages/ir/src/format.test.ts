import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  NEXT,
  nextRelease,
  compareVersions,
  FEATURE_SINCE,
  featuresOf,
  minRuntimeFor,
  PRODUCT_VERSION,
  PROGRAM_VERSION,
} from "./format.ts";
import type { CompiledProgram } from "./program.ts";

const program = (extra: Partial<CompiledProgram> = {}) => ({
  irVersion: PROGRAM_VERSION as typeof PROGRAM_VERSION,
  api: "t",
  current: "sha256:0",
  currentLabel: "new",
  contracts: {
    old: {
      label: "old",
      routes: [],
      sites: {
        "post /x": {
          request: [
            {
              k: "within" as const,
              path: "/items/*",
              block: [
                { k: "case" as const, path: "/s", from: "snake", to: "camel", c: "c" },
              ],
              c: "c",
            },
          ],
        },
      },
      behaviors: [],
      retired: [],
    },
  },
  ...extra,
});

describe("the program format", () => {
  it("is what the package is published as", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(PRODUCT_VERSION).toBe(manifest.version);
  });

  it("finds what a program uses, however deeply it is nested", () => {
    expect([...featuresOf(program() as never)].sort()).toEqual(["case", "within"]);
  });

  it("never asks for a runtime newer than the release that compiled it", () => {
    // A runtime of the same release has to run everything its compiler emits.
    // One not yet released asks for the release after this one, which this
    // release's own runtime is built to accept.
    for (const [feature, since] of Object.entries(FEATURE_SINCE)) {
      if (since === NEXT) continue;
      expect(compareVersions(since, PRODUCT_VERSION), feature).toBeLessThanOrEqual(0);
    }
  });

  it("asks for the newest runtime any feature it uses needs", () => {
    expect(minRuntimeFor(program() as never)).toBe("0.1.0");
  });

  it("asks for the release after this one where a feature is not yet released", () => {
    expect(nextRelease("0.1.0")).toBe("0.1.1-next");
    // Every published runtime refuses it, and any later release runs it.
    expect(compareVersions(nextRelease("0.1.0"), "0.1.0")).toBe(1);
    expect(compareVersions(nextRelease("0.1.0"), "0.1.1")).toBe(-1);
    expect(compareVersions(nextRelease("0.1.0"), "0.2.0")).toBe(-1);
  });

  it("orders versions as releases are ordered", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
  });
});
