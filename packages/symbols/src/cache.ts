/**
 * Symbol maps kept per `(package, version, contract digest)`.
 *
 * A release's files never change and neither does a contract with a given
 * digest, so the map of one to the other is made once. What can change is
 * this code and the judge, so an entry also records the engine and the
 * judge's fingerprint, and one made by either in another state is made
 * again rather than reused: a cache keyed on the inputs alone would keep
 * serving the answers of code nobody runs any more.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type GeneratedSymbols, SYMBOLS_ENGINE } from "./types.ts";

export interface SymbolKey {
  package: string;
  version: string;
  /** The contract's digest, as `sha256:…`. */
  contract: string;
}

export interface SymbolCache {
  get(key: SymbolKey): Promise<GeneratedSymbols | undefined>;
  set(key: SymbolKey, value: GeneratedSymbols): Promise<void>;
}

/** One string for a key, safe as a file name. */
export function keyOf(key: SymbolKey): string {
  return `${encodeURIComponent(key.package)}@${encodeURIComponent(key.version)}/${encodeURIComponent(key.contract.replace(/^sha256:/, ""))}`;
}

/** Whether a cached map is one this code, with this judge, would make now. */
export function isCurrent(value: GeneratedSymbols, judge: string): boolean {
  return (
    value.engine === SYMBOLS_ENGINE && value.judge === judge && value.formatVersion === 1
  );
}

/** A cache for one process. */
export function memoryCache(): SymbolCache {
  const entries = new Map<string, GeneratedSymbols>();
  return {
    get: async (key) => entries.get(keyOf(key)),
    set: async (key, value) => {
      entries.set(keyOf(key), value);
    },
  };
}

/** A cache in a directory, one JSON file per key. */
export function directoryCache(dir: string): SymbolCache {
  const pathOf = (key: SymbolKey) => join(dir, `${keyOf(key)}.json`);
  return {
    async get(key) {
      try {
        return JSON.parse(await readFile(pathOf(key), "utf8")) as GeneratedSymbols;
      } catch {
        return undefined;
      }
    },
    async set(key, value) {
      const path = pathOf(key);
      await mkdir(join(path, ".."), { recursive: true });
      // Written aside and moved, so a reader never sees half a map.
      const partial = `${path}.${process.pid}.partial`;
      await writeFile(partial, `${JSON.stringify(value, null, 2)}\n`);
      await rename(partial, path);
    },
  };
}
