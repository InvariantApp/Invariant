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
import { download, InstallError, verifyAsset } from "./install.ts";

const bytes = Buffer.from("a release asset");
const hash = createHash("sha256").update(bytes).digest("hex");

const binary = (sha256: string): PlatformBinary => ({
  package: "@invariant-app/oasdiff-test",
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

describe("downloading an asset", () => {
  const answers = (...steps: (number | Error)[]) => {
    const calls: string[] = [];
    const fetch = (async (url: string) => {
      calls.push(url);
      const step = steps.shift();
      if (step instanceof Error) throw step;
      return new Response(step === 200 ? "bytes" : "nope", { status: step ?? 599 });
    }) as unknown as typeof globalThis.fetch;
    return { fetch, calls };
  };
  const waits: number[] = [];
  const pause = async (ms: number) => {
    waits.push(ms);
  };

  it("retries a server error and a dropped connection, then succeeds", async () => {
    waits.length = 0;
    const { fetch, calls } = answers(500, new TypeError("fetch failed"), 200);
    const bytes = await download("checksums.txt", { fetch, pause });
    expect(bytes.toString()).toBe("bytes");
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([1_000, 3_000]);
  });

  it("gives up after four attempts and says how many", async () => {
    const { fetch, calls } = answers(502, 503, 429, 500);
    await expect(download("checksums.txt", { fetch, pause })).rejects.toThrow(
      "500 fetching checksums.txt after 4 attempts",
    );
    expect(calls).toHaveLength(4);
  });

  it("does not retry an asset that is not there", async () => {
    const { fetch, calls } = answers(404);
    await expect(download("missing.tar.gz", { fetch, pause })).rejects.toThrow(
      /^404 fetching missing.tar.gz$/,
    );
    expect(calls).toHaveLength(1);
  });
});
