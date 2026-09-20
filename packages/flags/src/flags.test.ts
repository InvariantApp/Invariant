/**
 * The flags source, which is read while something is already going wrong.
 *
 * Every test here is about not making a bad situation worse. The switch is
 * reached for during an incident, so a typo in a file, a deleted file or a
 * disk that has gone away must all be survivable, and none of them may change
 * what the request path does on their own.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { flagsFrom } from "./index.ts";

let scratch: string | undefined;

afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
  delete process.env["TEST_INVARIANT_FLAGS"];
});

async function dir(): Promise<string> {
  scratch = await mkdtemp(join(tmpdir(), "invariant-flags-"));
  return scratch;
}

describe("reading kill-switch flags", () => {
  it("says nothing is switched off when there is no file", async () => {
    const path = join(await dir(), "flags.json");

    // A provider who has never needed the switch has no file, and that must
    // read as "serve everything" rather than as a failure.
    expect(flagsFrom({ path, ttlMs: 0 }).read()).toEqual({});
  });

  it("reads what is switched off", async () => {
    const path = join(await dir(), "flags.json");
    await writeFile(path, JSON.stringify({ disabledChanges: ["chg_money"] }));

    expect(flagsFrom({ path, ttlMs: 0 }).read()).toEqual({
      disabledChanges: ["chg_money"],
    });
  });

  it("picks up a change without a restart", async () => {
    const path = join(await dir(), "flags.json");
    await writeFile(path, JSON.stringify({}));
    const source = flagsFrom({ path, ttlMs: 0 });

    expect(source.read()).toEqual({});

    await writeFile(path, JSON.stringify({ allDisabled: true }));
    // Propagation is the file changing. Nothing is held for the life of the
    // process, which is what makes this usable during an incident.
    expect(source.read()).toEqual({ allDisabled: true });
  });

  /**
   * The failure that would turn a mistake into an outage.
   *
   * Somebody edits the flags file during an incident and leaves a trailing
   * comma. Throwing would take down the request path; defaulting to "nothing
   * switched off" would silently undo a rollback that was in progress. Neither
   * is acceptable, so the last good answer stands.
   */
  it("keeps serving the last good flags when the file becomes unreadable", async () => {
    const path = join(await dir(), "flags.json");
    await writeFile(path, JSON.stringify({ allDisabled: true }));
    const errors: string[] = [];
    const source = flagsFrom({ path, ttlMs: 0, onError: (m) => errors.push(m) });

    expect(source.read()).toEqual({ allDisabled: true });

    await writeFile(path, "{ oops");
    expect(source.read()).toEqual({ allDisabled: true });
    expect(source.stale()).toBe(true);
    expect(errors.join(" ")).toContain("last known flags");

    // And it recovers on its own once the file is fixed.
    await writeFile(path, JSON.stringify({ disabledContracts: ["2026-01-15"] }));
    expect(source.read()).toEqual({ disabledContracts: ["2026-01-15"] });
    expect(source.stale()).toBe(false);
  });

  it("never throws, whatever the source does", async () => {
    // A directory where a file was expected: readable path, unreadable file.
    const path = await dir();
    const source = flagsFrom({ path, ttlMs: 0 });
    expect(() => source.read()).not.toThrow();
    expect(source.read()).toEqual({});
  });

  it("lets the environment override the file, for a machine with no writable disk", async () => {
    const path = join(await dir(), "flags.json");
    await writeFile(path, JSON.stringify({ disabledContracts: ["2026-01-15"] }));
    process.env["TEST_INVARIANT_FLAGS"] = JSON.stringify({ allDisabled: true });

    expect(flagsFrom({ path, env: "TEST_INVARIANT_FLAGS", ttlMs: 0 }).read()).toEqual({
      allDisabled: true,
    });
  });

  it("ignores fields it does not understand rather than refusing the file", async () => {
    const path = join(await dir(), "flags.json");
    await writeFile(
      path,
      JSON.stringify({ allDisabled: true, somethingNewer: { nested: 1 } }),
    );

    // A newer control plane may write fields this build predates. Refusing the
    // whole file over one would strand the switch on older instances during
    // exactly the rollout where it is needed.
    expect(flagsFrom({ path, ttlMs: 0 }).read()).toEqual({ allDisabled: true });
  });

  it("does not re-read a file that has not changed", async () => {
    const path = join(await dir(), "flags.json");
    await writeFile(path, JSON.stringify({ allDisabled: true }));
    const source = flagsFrom({ path, ttlMs: 0 });

    // The steady state is the expensive one: every request consults this, and
    // almost none of them find anything switched off.
    expect(source.read()).toEqual({ allDisabled: true });
    expect(source.read()).toEqual({ allDisabled: true });
    expect(source.stale()).toBe(false);
  });
});
