import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { watchChecks } from "./watch.ts";

const until = async (condition: () => boolean) => {
  for (let tries = 0; tries < 100 && !condition(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe("checking on every change", () => {
  it("runs once at the start, once per burst of edits, and ignores its own output", async () => {
    const root = mkdtempSync(join(tmpdir(), "invariant-watch-"));
    mkdirSync(join(root, "invariant", "compiled"), { recursive: true });
    let runs = 0;
    void watchChecks(
      root,
      async () => {
        runs += 1;
        return 0;
      },
      { settleMs: 50, log: () => {} },
    );
    await until(() => runs === 1);
    expect(runs).toBe(1);

    // An editor saving in several steps is one run.
    writeFileSync(join(root, "change.yaml"), "a");
    writeFileSync(join(root, "change.yaml"), "ab");
    writeFileSync(join(root, "change.yaml"), "abc");
    await until(() => runs === 2);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(runs).toBe(2);

    // What a compile writes does not start another.
    writeFileSync(join(root, "invariant", "compiled", "program.json"), "{}");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(runs).toBe(2);
  });
});
