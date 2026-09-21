/**
 * The compiled program, replaced while the proxy runs.
 *
 * A new program ships with a new build, and where the proxy is deployed
 * beside the build, the build's rollout replaces it too. Where it is not, a
 * provider can replace the file and send `SIGHUP`, or let the file's change
 * be noticed, and requests already in flight finish on the program they
 * started with. A new program that does not load is reported and the running
 * one is kept: an unreadable file must never take down a proxy that was
 * serving correctly a moment ago.
 */
import { readFile } from "node:fs/promises";
import type { FetchHandler } from "./proxy.ts";

export interface Reloadable {
  /** Serves every request with whichever program is current when it arrives. */
  handler: FetchHandler;
  /** Reads the program again; true when a new one is now serving. Never rejects. */
  reload(reason: string): Promise<boolean>;
  /** The program text now serving. */
  readonly text: string;
}

export async function reloadable(options: {
  path: string;
  /** Builds a handler from a program's text; throws when the program does not load. */
  build: (text: string) => FetchHandler;
  log: (message: string) => void;
}): Promise<Reloadable> {
  let text = await readFile(options.path, "utf8");
  let current = options.build(text);
  let pending: Promise<boolean> | undefined;

  async function reload(reason: string): Promise<boolean> {
    let next: string;
    try {
      next = await readFile(options.path, "utf8");
    } catch (error) {
      options.log(
        `kept the running program: ${options.path} could not be read (${reason}): ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    if (next === text) return false;
    try {
      current = options.build(next);
    } catch (error) {
      options.log(
        `kept the running program: the new one does not load (${reason}): ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    text = next;
    options.log(`serving a new program (${reason})`);
    return true;
  }

  return {
    handler: (request) => current(request),
    // One at a time, so two quick changes cannot finish out of order.
    reload: (reason) => {
      const run = (pending ?? Promise.resolve(false)).then(() => reload(reason));
      pending = run;
      void run.finally(() => {
        if (pending === run) pending = undefined;
      });
      return run;
    },
    get text() {
      return text;
    },
  };
}
