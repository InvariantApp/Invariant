import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contractOf, type OpenApiDocument } from "@invariant-app/contract";
import { describe, expect, it } from "vitest";
import {
  cachedSymbols,
  directoryCache,
  type GeneratedSymbols,
  keyOf,
  memoryCache,
  RulesSymbolJudge,
  SYMBOLS_ENGINE,
  type SymbolCache,
  type SymbolJudge,
} from "./index.ts";

const FIXTURE = join(import.meta.dirname, "../fixtures/stripe-node");
const document = JSON.parse(
  readFileSync(join(FIXTURE, "contract.json"), "utf8"),
) as OpenApiDocument;

/** A cache that counts what it is asked. */
function counting(inner: SymbolCache) {
  const counts = { get: 0, set: 0 };
  const cache: SymbolCache = {
    get: async (key) => {
      counts.get += 1;
      return inner.get(key);
    },
    set: async (key, value) => {
      counts.set += 1;
      await inner.set(key, value);
    },
  };
  return { cache, counts };
}

describe("cachedSymbols", () => {
  it("keys a map by package, version and the contract's digest, and makes it once", async () => {
    const { cache, counts } = counting(memoryCache());
    const first = await cachedSymbols(
      { sdk: FIXTURE, language: "typescript", contract: document },
      cache,
    );
    const second = await cachedSymbols(
      { sdk: FIXTURE, language: "typescript", contract: document },
      cache,
    );
    expect(second).toBe(first);
    expect(counts).toEqual({ get: 2, set: 1 });
    expect(first.contract).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("uses a loaded contract's own digest", async () => {
    const contract = contractOf("2025-02-24.acacia", document);
    const map = await cachedSymbols(
      { sdk: FIXTURE, language: "typescript", contract },
      memoryCache(),
    );
    expect(map.contract).toBe(contract.digest);
  });

  it("makes the map again for another judge, or for older code", async () => {
    const { cache, counts } = counting(memoryCache());
    await cachedSymbols(
      { sdk: FIXTURE, language: "typescript", contract: document },
      cache,
    );
    const other: SymbolJudge = {
      id: "other",
      fingerprint: "other/1",
      choose: async (questions) => new RulesSymbolJudge().choose(questions),
    };
    const again = await cachedSymbols(
      { sdk: FIXTURE, language: "typescript", contract: document, judge: other },
      cache,
    );
    expect(again.judge).toBe("other/1");
    expect(counts.set).toBe(2);

    const key = { package: "stripe", version: "17.7.0", contract: again.contract };
    await cache.set(key, { ...(again as GeneratedSymbols), engine: "symbols/0" });
    const current = await cachedSymbols(
      { sdk: FIXTURE, language: "typescript", contract: document, judge: other },
      cache,
    );
    expect(current.engine).toBe(SYMBOLS_ENGINE);
    expect(counts.set).toBe(4);
  });

  it("keeps each map in a directory as JSON, one file per key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "symbols-cache-"));
    const map = await cachedSymbols(
      { sdk: FIXTURE, language: "typescript", contract: document },
      directoryCache(dir),
    );
    const key = { package: map.package, version: map.version, contract: map.contract };
    expect(keyOf(key)).toBe(`stripe@17.7.0/${map.contract.slice("sha256:".length)}`);
    expect(readdirSync(join(dir, "stripe@17.7.0"))).toEqual([
      `${map.contract.slice("sha256:".length)}.json`,
    ]);
    expect(await directoryCache(dir).get(key)).toEqual(map);
  });

  it("never caches a release that records no name or version", async () => {
    const { cache, counts } = counting(memoryCache());
    await cachedSymbols(
      {
        sdk: join(import.meta.dirname, "../fixtures/stainless-go"),
        language: "go",
        contract: document,
      },
      cache,
    );
    expect(counts).toEqual({ get: 0, set: 0 });
  });
});
