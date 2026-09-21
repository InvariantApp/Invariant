/**
 * Flags from the control plane, kept through an outage and a restart.
 *
 * The runtime reads flags synchronously on every request, so this never makes
 * it wait: a poll runs in the background with the tag of what is held, and
 * the usual answer is that nothing changed. What was last read is written to
 * disk, and read back on start, so a kill switch flipped during an incident
 * is still on after the service restarts, even if the control plane is the
 * thing that is down.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ControlPlaneClient } from "@invariant/client";
import type { RuntimeFlags } from "@invariant/runtime";
import type { FlagsSource } from "./index.ts";
import { parseFlags } from "./parse.ts";

export interface RemoteFlagsOptions {
  client: Pick<ControlPlaneClient, "getFlags">;
  /**
   * Where the last flags read are kept, so they survive a restart. Without
   * it a restart during an outage starts with nothing switched off.
   */
  cachePath?: string;
  /** How often to ask. Default 15 seconds, so a switch takes effect within that. */
  pollMs?: number;
  onError?: (message: string) => void;
}

export interface RemoteFlagsSource extends FlagsSource {
  /** Ask now rather than at the next poll. Never rejects. */
  refresh(): Promise<void>;
  /** Stop polling. */
  close(): void;
}

interface Cached {
  etag: string;
  flags: unknown;
}

export function remoteFlags(options: RemoteFlagsOptions): RemoteFlagsSource {
  const note = options.onError ?? (() => {});
  let current: RuntimeFlags = {};
  let etag: string | undefined;
  let stale = true;

  if (options.cachePath) {
    try {
      const cached = JSON.parse(readFileSync(options.cachePath, "utf8")) as Cached;
      const flags = parseFlags(JSON.stringify(cached.flags));
      if (flags && typeof cached.etag === "string") {
        current = flags;
        etag = cached.etag;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        note(
          `${options.cachePath} could not be read, so nothing is switched off until the control plane answers: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  function keep(next: Cached): void {
    if (!options.cachePath) return;
    try {
      mkdirSync(dirname(options.cachePath), { recursive: true });
      // Written beside and moved into place, so a crash mid-write never
      // leaves a half file to be read on the next start.
      const temporary = `${options.cachePath}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(next));
      renameSync(temporary, options.cachePath);
    } catch (error) {
      note(
        `${options.cachePath} could not be written, so these flags will not survive a restart: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  let inFlight: Promise<void> | undefined;
  async function refresh(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const answer = await options.client.getFlags(etag);
        stale = false;
        if (!answer.changed) return;
        const flags = parseFlags(JSON.stringify(answer.state.flags));
        if (!flags) {
          note(
            "the control plane sent flags that are not an object; the last ones are kept",
          );
          stale = true;
          return;
        }
        current = flags;
        etag = answer.etag;
        keep({ etag: answer.etag, flags: answer.state.flags });
      } catch (error) {
        stale = true;
        note(
          `flags could not be read from the control plane, so the last ones are kept: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  void refresh();
  const timer = setInterval(() => void refresh(), options.pollMs ?? 15_000);
  timer.unref?.();

  return {
    read: () => current,
    stale: () => stale,
    refresh,
    close: () => clearInterval(timer),
  };
}

/**
 * Several sources read as one, where a switch off in any of them is off.
 *
 * A provider can hold the remote flags and a local file at once, the file for
 * the moment the control plane is the thing that broke. Taking the union is
 * the only safe reading of a kill switch: no source can switch back on what
 * another switched off.
 */
export function combineFlags(...sources: FlagsSource[]): FlagsSource {
  // Read on every request, so the union is only rebuilt when a source's
  // answer changed.
  let seen: RuntimeFlags[] = [];
  let union: RuntimeFlags = {};
  return {
    read: () => {
      const read = sources.map((source) => source.read());
      if (
        read.length === seen.length &&
        read.every((flags, index) => flags === seen[index])
      ) {
        return union;
      }
      seen = read;
      const contracts = new Set(read.flatMap((flags) => flags.disabledContracts ?? []));
      const changes = new Set(read.flatMap((flags) => flags.disabledChanges ?? []));
      union = {
        ...(read.some((flags) => flags.allDisabled) ? { allDisabled: true } : {}),
        ...(contracts.size > 0 ? { disabledContracts: [...contracts] } : {}),
        ...(changes.size > 0 ? { disabledChanges: [...changes] } : {}),
      };
      return union;
    },
    stale: () => sources.some((source) => source.stale()),
  };
}
