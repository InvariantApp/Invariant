/**
 * A new program while the proxy runs: taken when it loads, refused when it
 * does not, and never mixed into a request already under way.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "@invariant/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProxy } from "./proxy.ts";
import { reloadable } from "./reload.ts";

const OLD = "2026-01-01";

/** A program that renames `amount` to `to` for callers on the old contract. */
const program = (to: string) =>
  JSON.stringify({
    irVersion: 2,
    api: "payments",
    currentLabel: "2026-09-20",
    current: "sha256:head",
    contracts: {
      [OLD]: {
        label: OLD,
        routes: [],
        sites: {
          "post /v1/payments": {
            request: [{ k: "move", from: "/amount", to: `/${to}`, c: "chg_rename" }],
          },
        },
        behaviors: [],
        retired: [],
      },
    },
  });

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "invariant-reload-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

/** An upstream that answers with the body it was sent, when told to. */
function echo() {
  let hold: Promise<void> = Promise.resolve();
  return {
    pause() {
      let release: () => void = () => {};
      hold = new Promise((resolve) => {
        release = resolve;
      });
      return release;
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const body = await new Request(input, init).text();
      await hold;
      return new Response(body, { headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  };
}

async function proxyAt(path: string, upstream: ReturnType<typeof echo>, log: string[]) {
  return reloadable({
    path,
    log: (message) => log.push(message),
    build: (text) =>
      createProxy({
        runtime: createRuntime({
          program: JSON.parse(text),
          identity: [
            { kind: "header", name: "payments-version" },
            { kind: "default", label: "2026-09-20" },
          ],
        }),
        upstream: "http://upstream.test",
        fetch: upstream.fetch,
      }),
  });
}

const pay = () =>
  new Request("https://api.example.com/v1/payments", {
    method: "POST",
    headers: { "content-type": "application/json", "payments-version": OLD },
    body: JSON.stringify({ amount: 5 }),
  });

describe("a new program while the proxy runs", () => {
  it("serves once it loads", async () => {
    const path = join(dir, "takes.json");
    await writeFile(path, program("amount_cents"));
    const log: string[] = [];
    const running = await proxyAt(path, echo(), log);
    expect(await (await running.handler(pay())).json()).toEqual({ amount_cents: 5 });

    await writeFile(path, program("amount_minor"));
    expect(await running.reload("SIGHUP")).toBe(true);
    expect(await (await running.handler(pay())).json()).toEqual({ amount_minor: 5 });
    expect(log).toEqual(["serving a new program (SIGHUP)"]);
  });

  it("is refused when it does not load, and the running one keeps serving", async () => {
    const path = join(dir, "refused.json");
    await writeFile(path, program("amount_cents"));
    const log: string[] = [];
    const running = await proxyAt(path, echo(), log);

    await writeFile(path, "{ half a file");
    expect(await running.reload("the file changed")).toBe(false);
    await writeFile(path, JSON.stringify({ irVersion: 99, api: "payments" }));
    expect(await running.reload("the file changed")).toBe(false);
    await rm(path);
    expect(await running.reload("SIGHUP")).toBe(false);

    expect(await (await running.handler(pay())).json()).toEqual({ amount_cents: 5 });
    expect(log).toHaveLength(3);
    for (const line of log) expect(line).toMatch(/^kept the running program/);
  });

  it("changes nothing when the file is the same", async () => {
    const path = join(dir, "same.json");
    await writeFile(path, program("amount_cents"));
    const log: string[] = [];
    const running = await proxyAt(path, echo(), log);
    expect(await running.reload("the file changed")).toBe(false);
    expect(log).toEqual([]);
  });

  it("leaves a request under way on the program it started with", async () => {
    const path = join(dir, "inflight.json");
    await writeFile(path, program("amount_cents"));
    const upstream = echo();
    const running = await proxyAt(path, upstream, []);
    const release = upstream.pause();
    const underWay = running.handler(pay());

    await writeFile(path, program("amount_minor"));
    await running.reload("SIGHUP");
    release();
    expect(await (await underWay).json()).toEqual({ amount_cents: 5 });
  });
});
