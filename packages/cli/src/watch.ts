/**
 * `invariant check --watch`: the gate run again whenever a file it reads
 * changes, so a provider editing a Change sees the verdict without asking.
 *
 * Everything under the configuration's directory is watched, apart from what
 * a check or a build writes itself, and changes are gathered for a moment so
 * an editor saving in several steps is one run, not several. A run already
 * going is let finish; one more follows if anything changed meanwhile.
 */
import { watch } from "node:fs";

const IGNORED = /(^|[/\\])(node_modules|\.git|\.cache|dist|compiled)([/\\]|$)/;

export function watchChecks(
  root: string,
  run: () => Promise<number>,
  options: { settleMs?: number; log?: (line: string) => void } = {},
): Promise<number> {
  const settleMs = options.settleMs ?? 300;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  let running = false;
  let again = false;
  let timer: NodeJS.Timeout | undefined;

  const go = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await run();
    } catch (error) {
      // A broken file mid-edit is reported and watched past, never fatal.
      log(error instanceof Error ? error.message : String(error));
    }
    running = false;
    log(`watching ${root} for changes`);
    if (again) {
      again = false;
      await go();
    }
  };

  watch(root, { recursive: true }, (_event, name) => {
    if (name && IGNORED.test(String(name))) return;
    clearTimeout(timer);
    timer = setTimeout(() => void go(), settleMs);
  });
  void go();
  // Runs until interrupted.
  return new Promise<number>(() => {});
}
