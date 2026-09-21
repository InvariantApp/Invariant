/**
 * Counters written to a local file, one JSON object per line.
 *
 * For a provider who would rather keep everything in their own logging
 * pipeline, and for `invariant release`, whose runtime evidence (E9) reads
 * outcome lines from exactly this format. The file is rotated by size, so a
 * long-running service cannot fill a disk with it.
 */
import { appendFile, rename, rm, stat } from "node:fs/promises";
import type { Batch, Sink } from "./index.ts";

export interface JsonlOptions {
  /** Rotated once it would grow past this. Default 10 MB. */
  maxBytes?: number;
  /** Rotated files kept beside it, as `<path>.1` to `<path>.<keep>`. Default 5. */
  keep?: number;
}

export function jsonlSink(path: string, options: JsonlOptions = {}): Sink {
  const maxBytes = options.maxBytes ?? 10_000_000;
  const keep = options.keep ?? 5;

  async function sizeOf(file: string): Promise<number> {
    try {
      return (await stat(file)).size;
    } catch {
      return 0;
    }
  }

  async function rotate(): Promise<void> {
    await rm(`${path}.${keep}`, { force: true });
    for (let index = keep - 1; index >= 1; index -= 1) {
      await rename(`${path}.${index}`, `${path}.${index + 1}`).catch(() => {});
    }
    await rename(path, `${path}.1`).catch(() => {});
  }

  return {
    name: `jsonl ${path}`,
    async write(batch: Batch) {
      const lines = [
        ...batch.usage.map((row) => JSON.stringify({ kind: "usage", ...row })),
        ...batch.outcomes.map((row) => JSON.stringify({ kind: "outcome", ...row })),
      ];
      if (lines.length === 0) return;
      const text = `${lines.join("\n")}\n`;
      if ((await sizeOf(path)) + Buffer.byteLength(text) > maxBytes) await rotate();
      await appendFile(path, text, "utf8");
    },
  };
}
