/**
 * Where the kill switch reads from.
 *
 * The runtime deliberately has no file or network access, so it asks for flags
 * through a function and this supplies one. That separation is what keeps the
 * request path free of anything that can block, and it is also what lets a
 * provider point the switch at whatever they already operate.
 *
 * Two rules decide everything here, and both exist because this is the thing
 * a provider reaches for when something is already wrong.
 *
 * It never throws. A malformed file, a deleted file, a disk that has gone away
 * - none of them may take down a request path. The last good answer is kept and
 * returned instead, because the alternative is that a typo in a flags file
 * becomes an outage.
 *
 * It never caches beyond a bound. "Takes effect without a deploy" means a file
 * changing is the whole propagation story, so the file is re-read once the
 * bound has passed rather than held for the life of the process.
 */
import { readFileSync, statSync } from "node:fs";
import type { RuntimeFlags } from "@invariant/runtime";

import { parseFlags } from "./parse.ts";

export { parseFlags } from "./parse.ts";
export {
  combineFlags,
  type RemoteFlagsOptions,
  type RemoteFlagsSource,
  remoteFlags,
} from "./remote.ts";

export interface FlagsOptions {
  /** JSON file holding the flags. Absent is normal and means nothing is off. */
  path?: string;
  /** Environment variable holding the same JSON, which wins over the file. */
  env?: string;
  /** How long an answer is reused before the source is consulted again. */
  ttlMs?: number;
  /** Called when a source could not be read, for the provider's own logging. */
  onError?: (message: string) => void;
}

const DEFAULT_TTL_MS = 5_000;

export interface FlagsSource {
  /** What the runtime calls. Never throws. */
  read: () => RuntimeFlags;
  /** Whether the last read came from a source or from the last good answer. */
  stale: () => boolean;
}

export function flagsFrom(options: FlagsOptions = {}): FlagsSource {
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  const note = options.onError ?? (() => {});

  // Nothing switched off is the correct answer before anything has been read.
  // Defaulting to "everything off" would mean a missing file takes every old
  // integration down, which is the opposite of what a safety mechanism is for.
  let lastGood: RuntimeFlags = {};
  let checkedAt = 0;
  let wasStale = false;
  let seenMtime = -1;

  const read = (): RuntimeFlags => {
    const now = Date.now();
    if (now - checkedAt < ttl) return lastGood;
    checkedAt = now;

    const raw = options.env ? process.env[options.env] : undefined;
    if (raw !== undefined && raw !== "") {
      try {
        const parsed = parseFlags(raw);
        if (parsed) {
          lastGood = parsed;
          wasStale = false;
          return lastGood;
        }
        note(`${options.env} is not an object, so the last known flags are kept`);
      } catch (error) {
        note(
          `${options.env} could not be read: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      wasStale = true;
      return lastGood;
    }

    if (!options.path) {
      lastGood = {};
      wasStale = false;
      return lastGood;
    }

    try {
      const stat = statSync(options.path);
      // Unchanged files are not re-parsed, so the common case costs one stat.
      if (stat.mtimeMs === seenMtime) {
        wasStale = false;
        return lastGood;
      }
      const parsed = parseFlags(readFileSync(options.path, "utf8"));
      if (!parsed) {
        note(`${options.path} is not an object, so the last known flags are kept`);
        wasStale = true;
        return lastGood;
      }
      seenMtime = stat.mtimeMs;
      lastGood = parsed;
      wasStale = false;
      return lastGood;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // No file is the ordinary state of a provider who has never needed the
        // switch, not a failure.
        seenMtime = -1;
        lastGood = {};
        wasStale = false;
        return lastGood;
      }
      note(
        `${options.path} could not be read: ${error instanceof Error ? error.message : String(error)}. ` +
          "The last known flags are being served.",
      );
      wasStale = true;
      return lastGood;
    }
  };

  return { read, stale: () => wasStale };
}
