/**
 * The vectors as data on disk.
 *
 * A port in another language cannot run the TypeScript that defines these, so
 * the file it reads is checked in. It is generated from the same source the
 * tests run against, and this asserts the two have not drifted: a committed
 * vector file that no longer matches the engine would certify a port against a
 * contract nobody holds.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENVELOPE_VECTORS } from "./envelope-vectors.ts";
import { CONFORMANCE_VECTORS } from "./vectors.ts";

const PATH = join(import.meta.dirname, "../../../conformance/vectors.json");

function serialise(): string {
  return `${JSON.stringify(
    {
      irVersion: 1,
      about:
        "Golden vectors for the Invariant compiled-program IR. Any engine " +
        "claiming to run this IR must produce these outputs, including the " +
        "refusals. A refusal is part of the contract: an engine that rounds " +
        "where this one rejects is not compatible.",
      vectors: CONFORMANCE_VECTORS,
      envelopes: ENVELOPE_VECTORS,
    },
    null,
    2,
  )}\n`;
}

describe("the vector file", () => {
  it("matches the vectors this engine is tested against", async () => {
    const expected = serialise();
    let actual: string;
    try {
      actual = await readFile(PATH, "utf8");
    } catch {
      await writeFile(PATH, expected, "utf8");
      throw new Error(`conformance/vectors.json was missing and has been written`);
    }

    if (actual !== expected) {
      await writeFile(PATH, expected, "utf8");
      throw new Error(
        "conformance/vectors.json was out of date and has been rewritten. " +
          "Commit it: a port certified against a stale file is certified " +
          "against nothing.",
      );
    }

    expect(actual).toBe(expected);
  });
});
