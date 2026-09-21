/**
 * The kill switch from the control plane: it takes effect without a deploy,
 * it survives the control plane going away, and it survives a restart while
 * the control plane is away.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneError, type FlagsState } from "@invariant/client";
import {
  createRuntime,
  type RuntimeFlags,
  UnsupportedContractError,
} from "@invariant/runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { combineFlags, type RemoteFlagsSource, remoteFlags } from "./remote.ts";

/** A control plane that answers with whatever flags it is holding. */
function controlPlane(initial: FlagsState["flags"] = {}) {
  let flags = initial;
  let version = 1;
  let up = true;
  const polls: (string | undefined)[] = [];
  return {
    polls,
    set(next: FlagsState["flags"]) {
      flags = next;
      version += 1;
    },
    down() {
      up = false;
    },
    client: {
      async getFlags(held?: string) {
        polls.push(held);
        if (!up) {
          throw new ControlPlaneError("could not be reached", {
            status: 0,
            code: "unreachable",
          });
        }
        const etag = `"v${version}"`;
        if (held === etag) return { changed: false as const };
        return { changed: true as const, etag, state: { flags, updatedAt: version } };
      },
    },
  };
}

let dir: string;
let sources: RemoteFlagsSource[] = [];
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "invariant-flags-remote-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
afterEach(() => {
  for (const source of sources) source.close();
  sources = [];
});
const remote = (options: Parameters<typeof remoteFlags>[0]) => {
  const source = remoteFlags(options);
  sources.push(source);
  return source;
};

describe("flags from the control plane", () => {
  it("are what the control plane says, once it has answered", async () => {
    const plane = controlPlane({ disabledContracts: ["2026-01-15"] });
    const source = remote({ client: plane.client });
    await source.refresh();
    expect(source.read()).toEqual({ disabledContracts: ["2026-01-15"] });
    expect(source.stale()).toBe(false);
  });

  it("are polled with the tag of what is held, and change without a restart", async () => {
    const plane = controlPlane();
    const source = remote({ client: plane.client });
    await source.refresh();
    await source.refresh();
    plane.set({ disabledChanges: ["chg_money"] });
    await source.refresh();
    expect(plane.polls.slice(-2)).toEqual(['"v1"', '"v1"']);
    expect(source.read()).toEqual({ disabledChanges: ["chg_money"] });
  });

  it("are kept when the control plane goes away, and say they may be stale", async () => {
    const errors: string[] = [];
    const plane = controlPlane({ allDisabled: true });
    const source = remote({ client: plane.client, onError: (m) => errors.push(m) });
    await source.refresh();
    plane.down();
    await source.refresh();
    expect(source.read()).toEqual({ allDisabled: true });
    expect(source.stale()).toBe(true);
    expect(errors.join()).toMatch(/the last ones are kept/);
  });

  it("survive a restart while the control plane is away", async () => {
    const cachePath = join(dir, "restart", "flags.json");
    const plane = controlPlane({ disabledContracts: ["2026-01-15"] });
    const before = remote({ client: plane.client, cachePath });
    await before.refresh();
    before.close();

    plane.down();
    const after = remote({ client: plane.client, cachePath });
    // Before any answer: the switch flipped during the incident is still on.
    expect(after.read()).toEqual({ disabledContracts: ["2026-01-15"] });
    await after.refresh();
    expect(after.read()).toEqual({ disabledContracts: ["2026-01-15"] });
  });

  it("start from nothing switched off when the kept copy is unreadable, and say so", async () => {
    const cachePath = join(dir, "corrupt.json");
    await writeFile(cachePath, "{ half a file");
    const errors: string[] = [];
    const plane = controlPlane();
    plane.down();
    const source = remote({
      client: plane.client,
      cachePath,
      onError: (m) => errors.push(m),
    });
    expect(source.read()).toEqual({});
    expect(errors[0]).toMatch(/could not be read, so nothing is switched off/);
  });

  it("keep the tag with the copy, so a restart does not fetch what it already has", async () => {
    const cachePath = join(dir, "tagged.json");
    const plane = controlPlane({ disabledChanges: ["chg_money"] });
    const first = remote({ client: plane.client, cachePath });
    await first.refresh();
    first.close();
    expect(JSON.parse(await readFile(cachePath, "utf8"))).toEqual({
      etag: '"v1"',
      flags: { disabledChanges: ["chg_money"] },
    });
    plane.polls.length = 0;
    const second = remote({ client: plane.client, cachePath });
    await second.refresh();
    expect(plane.polls[0]).toBe('"v1"');
  });
});

describe("several sources at once", () => {
  const fixed = (flags: RuntimeFlags, stale = false) => ({
    read: () => flags,
    stale: () => stale,
  });

  it("switch off whatever any of them switches off", () => {
    const combined = combineFlags(
      fixed({ disabledContracts: ["2026-01-15"] }),
      fixed({ disabledContracts: ["2026-03-01"], disabledChanges: ["chg_money"] }),
      fixed({}),
    );
    expect(combined.read()).toEqual({
      disabledContracts: ["2026-01-15", "2026-03-01"],
      disabledChanges: ["chg_money"],
    });
    expect(combineFlags(fixed({}), fixed({ allDisabled: true })).read()).toEqual({
      allDisabled: true,
    });
  });

  it("are stale when any of them is", () => {
    expect(combineFlags(fixed({}), fixed({}, true)).stale()).toBe(true);
  });

  it("answer with the same object until a source changes", () => {
    let flags: RuntimeFlags = { disabledChanges: ["a"] };
    const combined = combineFlags({ read: () => flags, stale: () => false });
    const first = combined.read();
    expect(combined.read()).toBe(first);
    flags = { disabledChanges: ["b"] };
    expect(combined.read()).toEqual({ disabledChanges: ["b"] });
  });
});

describe("a switch flipped on the control plane", () => {
  it("stops a running runtime serving that contract, without a deploy", async () => {
    const program = JSON.parse(
      await readFile(
        join(
          import.meta.dirname,
          "../../../fixtures/provider-acme/invariant/compiled/program.json",
        ),
        "utf8",
      ),
    ) as unknown;
    const plane = controlPlane();
    const source = remote({ client: plane.client });
    await source.refresh();
    const runtime = createRuntime({
      program,
      identity: [{ kind: "default", label: "2026-01-15" }],
      flags: source.read,
    });
    expect(runtime.siteFor("2026-01-15", "post", "/v1/payments")).toBeDefined();

    plane.set({ disabledContracts: ["2026-01-15"] });
    await source.refresh();
    expect(() => runtime.siteFor("2026-01-15", "post", "/v1/payments")).toThrow(
      UnsupportedContractError,
    );
  });
});
