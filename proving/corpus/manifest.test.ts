/**
 * The manifest is the denominator of every corpus number, so what makes it
 * trustworthy is checked on every commit rather than assumed.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MANIFEST, type Manifest } from "./manifest.mts";

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;

describe("the pinned corpus manifest", () => {
  it("names every pair differently, so a result can be traced to one pair", () => {
    const keys = manifest.pairs.map(
      (pair) => `${pair.api} ${pair.from.label} -> ${pair.to.label}`,
    );
    const repeated = keys.filter((key, index) => keys.indexOf(key) !== index);
    expect(repeated).toEqual([]);
  });

  it("pins every file by a hash and by a URL that cannot move", () => {
    const loose = manifest.pairs
      .flatMap((pair) => [pair.from, pair.to])
      .filter(
        (file) =>
          !/^[0-9a-f]{64}$/.test(file.sha256) ||
          (file.url.startsWith("https://raw.githubusercontent.com/") &&
            !/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\//.test(
              file.url,
            )),
      )
      .map((file) => file.url);
    expect(loose).toEqual([]);
  });

  it("compares two different documents in every pair", () => {
    expect(manifest.pairs.filter((pair) => pair.from.sha256 === pair.to.sha256)).toEqual(
      [],
    );
  });
});
