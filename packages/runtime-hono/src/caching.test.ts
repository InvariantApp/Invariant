/**
 * Caches and conditional requests, which see the same URL answered in a
 * different shape for each contract.
 *
 * A cache keyed on the URL alone would hand one contract's shape to another's
 * callers, and an entity tag passed through unchanged would tell a caller
 * their copy is current when the bytes they hold are not the ones the tag
 * names. Both used to happen: no response said it varied on the contract
 * header, and an adapted body went out under the handler's own tag.
 */
import { createRuntime } from "@invariant/runtime";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { adapt, wrapFetch } from "./index.ts";

const OLD = "2026-01-01";
const CURRENT = "2026-09-20";
const HEADER = "payments-version";

const PROGRAM = {
  irVersion: 2,
  api: "payments",
  currentLabel: CURRENT,
  current: "sha256:head",
  contracts: {
    [OLD]: {
      label: OLD,
      routes: [],
      sites: {
        "get /v1/things/{id}": {
          response: {
            "2xx": [{ k: "move", from: "/amount_cents", to: "/amount", c: "chg_a" }],
          },
        },
      },
      behaviors: [],
      retired: [],
    },
  },
};

/** A handler that answers `If-None-Match` from its own tag, as a real one would. */
function service() {
  const seen: (string | null)[] = [];
  const runtime = createRuntime({
    program: PROGRAM,
    identity: [
      { kind: "header" as const, name: HEADER },
      { kind: "default" as const, label: CURRENT },
    ],
  });
  const app = new Hono();
  app.use("/v1/*", adapt({ runtime }));
  const thing = (c: import("hono").Context) => {
    seen.push(c.req.header("if-none-match") ?? null);
    if (c.req.header("if-none-match") === '"v7"') {
      return c.body(null, 304, { etag: '"v7"' });
    }
    return c.json({ id: "t_1", amount_cents: 1999 }, 200, { etag: '"v7"' });
  };
  app.get("/v1/things/:id", thing);
  app.get("/v1/other", (c) => c.json({ ok: true }, 200, { etag: '"o1"' }));
  return { fetch: wrapFetch((request) => app.fetch(request), { runtime }), seen };
}

const get = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  new Request(`https://api.example.com${path}`, { method, headers });

describe("an answer a cache may keep", () => {
  it("varies on the header that chose its contract, for current callers too", async () => {
    const { fetch } = service();
    const current = await fetch(get("/v1/things/t_1"));
    const old = await fetch(get("/v1/things/t_1", { [HEADER]: OLD }));
    const elsewhere = await fetch(get("/v1/other", { [HEADER]: OLD }));
    for (const response of [current, old, elsewhere]) {
      expect(response.headers.get("vary")?.toLowerCase()).toContain(HEADER);
    }
    // A current caller's answer is otherwise left as it was.
    expect(current.headers.get("invariant-contract")).toBeNull();
    expect(current.headers.get("etag")).toBe('"v7"');
  });

  it("carries a tag of its own when its body was adapted", async () => {
    const { fetch } = service();
    const old = await fetch(get("/v1/things/t_1", { [HEADER]: OLD }));
    expect(await old.json()).toEqual({ id: "t_1", amount: 1999 });
    expect(old.headers.get("etag")).toBe(`"v7~${OLD}"`);
    // Nothing was adapted here, so the handler's tag still names the bytes.
    const other = await fetch(get("/v1/other", { [HEADER]: OLD }));
    expect(other.headers.get("etag")).toBe('"o1"');
  });

  it("revalidates: the handler sees its own tag, and the caller gets theirs back", async () => {
    const { fetch, seen } = service();
    const first = await fetch(get("/v1/things/t_1", { [HEADER]: OLD }));
    const tag = first.headers.get("etag") ?? "";
    const again = await fetch(
      get("/v1/things/t_1", { [HEADER]: OLD, "if-none-match": tag }),
    );
    expect(seen.at(-1)).toBe('"v7"');
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(tag);
  });

  it("is never revalidated across contracts", async () => {
    const { fetch } = service();
    // The current contract's tag, sent by an old caller, names bytes in the
    // current shape, which is not a copy an old caller can be told to keep.
    const crossed = await fetch(
      get("/v1/things/t_1", { [HEADER]: OLD, "if-none-match": '"v7"' }),
    );
    expect(crossed.status).toBe(200);
    expect(crossed.headers.get("etag")).toBe(`"v7~${OLD}"`);
    // An old caller's tag, sent without naming the contract, is not current's.
    const other = await fetch(get("/v1/things/t_1", { "if-none-match": `"v7~${OLD}"` }));
    expect(other.status).toBe(200);
  });

  it("answers HEAD without the length of a body the caller is never sent", async () => {
    const { fetch } = service();
    const head = await fetch(get("/v1/things/t_1", { [HEADER]: OLD }, "HEAD"));
    expect(head.headers.get("content-length")).toBeNull();
    expect(head.headers.get("etag")).toBe(`"v7~${OLD}"`);
  });
});
