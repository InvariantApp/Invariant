/**
 * Refusing an oasdiff binary that is not the one pinned.
 *
 * Two hashes have to agree, and each disagreement is a different story: one
 * means upstream's own asset and checksum list do not match, the other means
 * upstream now serves something other than what this project reviewed.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PlatformBinary } from "./binaries.ts";
import { InstallError, verifyAsset } from "./install.ts";

const bytes = Buffer.from("a release asset");
const hash = createHash("sha256").update(bytes).digest("hex");

const binary = (sha256: string): PlatformBinary => ({
  package: "@invariant/oasdiff-test",
  targets: ["test-x64"],
  os: ["test"],
  cpu: ["x64"],
  asset: "oasdiff_test.tar.gz",
  sha256,
  executable: "oasdiff",
});

describe("verifying an asset", () => {
  it("accepts one that matches upstream and the pin", () => {
    expect(
      verifyAsset(binary(hash), bytes, new Map([["oasdiff_test.tar.gz", hash]])),
    ).toBe(hash);
  });

  it("refuses one upstream's own checksum list disagrees with", () => {
    expect(() =>
      verifyAsset(
        binary(hash),
        bytes,
        new Map([["oasdiff_test.tar.gz", "0".repeat(64)]]),
      ),
    ).toThrow(/upstream's checksums.txt/);
  });

  it("refuses one that is not the asset this project pinned, even if upstream agrees", () => {
    // Upstream replaced the asset and updated its checksum list to match.
    expect(() =>
      verifyAsset(
        binary("f".repeat(64)),
        bytes,
        new Map([["oasdiff_test.tar.gz", hash]]),
      ),
    ).toThrow(InstallError);
  });
});
