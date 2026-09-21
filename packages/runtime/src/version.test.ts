import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "./version.ts";

describe("the runtime's version", () => {
  it("is the one it is published as", () => {
    // Written by scripts/sync-versions.mts after `changeset version`. If this
    // fails, run it: a runtime that misstates its version accepts programs it
    // cannot run, or refuses ones it can.
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(VERSION).toBe(manifest.version);
  });

  it("is the one the Go engine states", () => {
    const go = readFileSync(
      new URL("../../../engines/go/invariant/version.go", import.meta.url),
      "utf8",
    );
    expect(go).toContain(`const Version = ${JSON.stringify(VERSION)}`);
  });
});
