/**
 * The escape hatch, and why it has to be one.
 *
 * The IR is deliberately small, and a small language has a ceiling. Splitting
 * one field into two, changing when a side effect happens, reshaping a
 * discriminated union: none of these can be a `move` or a `convert`, and
 * pretending otherwise would be the one failure this project cannot afford.
 *
 * So there is a second answer, and it is the one every system that has really
 * solved this arrived at: the provider writes the branch, in their own code,
 * and the runtime only says which side of it a caller belongs on. What is
 * tested here is that the saying is trustworthy.
 */
import { describe, expect, it, vi } from "vitest";
import { createRuntime, UnknownBehaviorError, type UsageEvent } from "./index.ts";

/**
 * Two historical contracts. The older one predates both changes; the newer one
 * predates only the later change, which is the case a flat list would get
 * wrong.
 */
function program(): unknown {
  return {
    irVersion: 2,
    api: "acme-payments",
    currentLabel: "2026-09-20",
    current: "sha256:head",
    contracts: {
      "2026-01-15": {
        label: "2026-01-15",
        routes: [],
        sites: {},
        behaviors: ["chg_capture_is_deferred", "chg_refunds_are_asynchronous"],
      },
      "2026-03-01": {
        label: "2026-03-01",
        routes: [],
        sites: {},
        behaviors: ["chg_refunds_are_asynchronous"],
      },
    },
  };
}

const identity = [{ kind: "default" as const, label: "2026-01-15" }];

describe("branching on contract age", () => {
  it("puts each caller on the side of the change they belong on", () => {
    const inv = createRuntime({ program: program(), identity });

    expect(inv.before("chg_capture_is_deferred", { contract: "2026-01-15" })).toBe(true);

    // The change landed before this contract, so this caller already has the
    // new behaviour and must not be given the old one.
    expect(inv.before("chg_capture_is_deferred", { contract: "2026-03-01" })).toBe(false);

    // The later change is still ahead of both.
    for (const contract of ["2026-01-15", "2026-03-01"]) {
      expect(inv.before("chg_refunds_are_asynchronous", { contract })).toBe(true);
    }
  });

  it("says no for a caller on the current contract", () => {
    const inv = createRuntime({ program: program(), identity });
    expect(inv.before("chg_capture_is_deferred", { contract: "2026-09-20" })).toBe(false);
  });

  /**
   * The failure that would otherwise be silent and permanent.
   *
   * A misspelled flag answering `false` means every old caller quietly gets
   * the new behaviour, which is the exact outcome the flag was written to
   * prevent, and nothing anywhere would report it.
   */
  it("refuses a flag no Change declares", () => {
    const inv = createRuntime({ program: program(), identity });

    expect(() =>
      inv.before("chg_capture_is_defered", { contract: "2026-01-15" }),
    ).toThrow(UnknownBehaviorError);
    // The message has to carry the real names, or the typo is still a hunt.
    expect(() => inv.before("chg_nonsense", { contract: "2026-01-15" })).toThrow(
      /chg_capture_is_deferred, chg_refunds_are_asynchronous/,
    );
  });

  it("lists what a provider may ask about", () => {
    expect(createRuntime({ program: program(), identity }).behaviors).toEqual([
      "chg_capture_is_deferred",
      "chg_refunds_are_asynchronous",
    ]);
  });

  /**
   * A behaviour branch is a Change like any other, and the whole point of
   * counting is that it can eventually be deleted. Without this, provider code
   * accumulates branches nobody can ever prove are dead.
   */
  it("counts a branch that was actually taken", () => {
    const onUsage = vi.fn();
    const inv = createRuntime({ program: program(), identity, onUsage });

    inv.before("chg_capture_is_deferred", {
      contract: "2026-01-15",
      operation: "post /v1/payments",
      consumer: "sha256:abcd",
    });

    expect(onUsage).toHaveBeenCalledTimes(1);
    const event = onUsage.mock.calls[0]?.[0] as UsageEvent;
    expect(event.contract).toBe("2026-01-15");
    expect(event.consumer).toBe("sha256:abcd");
    expect([...event.changes]).toEqual([["chg_capture_is_deferred", 1]]);
  });

  it("counts nothing when the branch was not taken", () => {
    const onUsage = vi.fn();
    const inv = createRuntime({ program: program(), identity, onUsage });

    inv.before("chg_capture_is_deferred", { contract: "2026-09-20" });

    // A caller on the current contract exercises no compatibility at all, and
    // recording one would keep a retired contract looking alive forever.
    expect(onUsage).not.toHaveBeenCalled();
  });
});
