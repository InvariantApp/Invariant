/**
 * Parameters, through a real Hono app.
 *
 * An old caller's query string and headers reach the handler as the current
 * contract names them, and a parameter moved into the body arrives there. A
 * program that converts a path parameter is refused where it is mounted,
 * because Hono binds path parameters before any middleware runs.
 */
import { createRuntime } from "@invariant-app/runtime";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { adapt, wrapFetch } from "./index.ts";

const query = (name: string, type = "integer") => ({
  in: "query",
  name,
  style: "form",
  explode: true,
  type,
});

function program(envelope: unknown, path = "/v1/items") {
  return {
    irVersion: 2,
    api: "items",
    currentLabel: "2",
    current: "sha256:2",
    contracts: {
      "1": {
        label: "1",
        routes: [],
        sites: { [`post ${path}`]: { envelope } },
        behaviors: [],
        retired: [],
      },
    },
  };
}

function appFor(envelope: unknown) {
  const runtime = createRuntime({
    program: program(envelope),
    identity: [
      { kind: "header", name: "items-version" },
      { kind: "default", label: "2" },
    ],
  });
  const seen: {
    query: Record<string, string>;
    header?: string | undefined;
    body?: unknown;
  }[] = [];
  const app = new Hono();
  app.use("/v1/*", adapt({ runtime }));
  app.post("/v1/items", async (c) => {
    const text = await c.req.text();
    seen.push({
      query: c.req.query(),
      header: c.req.header("x-limit") ?? undefined,
      body: text === "" ? undefined : JSON.parse(text),
    });
    return c.json({ ok: true });
  });
  return { fetch: wrapFetch((request) => app.fetch(request), { runtime }), seen };
}

const call = (
  fetch: (request: Request) => Response | Promise<Response>,
  url: string,
  init: RequestInit = {},
) =>
  fetch(
    new Request(`https://api.example.com${url}`, {
      method: "POST",
      ...init,
      headers: { "items-version": "1", ...(init.headers as Record<string, string>) },
    }),
  );

describe("an old caller's parameters, in Hono", () => {
  it("reach the handler under the names the current contract uses", async () => {
    const { fetch, seen } = appFor({
      instrs: [
        { k: "move", from: "/@query/limit", to: "/@query/page_size", c: "chg_limit" },
        {
          k: "move",
          from: "/@header/x-page-size",
          to: "/@header/x-limit",
          c: "chg_header",
        },
      ],
      params: {
        old: [
          query("limit"),
          {
            in: "header",
            name: "x-page-size",
            style: "simple",
            explode: false,
            type: "integer",
          },
        ],
        new: [
          query("page_size"),
          {
            in: "header",
            name: "x-limit",
            style: "simple",
            explode: false,
            type: "integer",
          },
        ],
      },
      body: false,
    });
    const response = await call(fetch, "/v1/items?limit=10&sort=asc", {
      headers: { "X-Page-Size": "5" },
    });
    expect(response.status).toBe(200);
    expect(seen[0]).toEqual({ query: { sort: "asc", page_size: "10" }, header: "5" });
  });

  it("reach the body when the current contract moved them there", async () => {
    const { fetch, seen } = appFor({
      instrs: [{ k: "move", from: "/@query/limit", to: "/@body/limit", c: "chg_limit" }],
      params: { old: [query("limit")], new: [] },
      body: true,
    });
    await call(fetch, "/v1/items?limit=10", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: "x" }),
    });
    expect(seen[0]?.body).toEqual({ q: "x", limit: 10 });
    expect(seen[0]?.query).toEqual({});
  });

  it("are refused, not dropped, when the body they belong in is not JSON", async () => {
    const { fetch, seen } = appFor({
      instrs: [{ k: "move", from: "/@query/limit", to: "/@body/limit", c: "chg_limit" }],
      params: { old: [query("limit")], new: [] },
      body: true,
    });
    const response = await call(fetch, "/v1/items?limit=10", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "q=x",
    });
    expect(response.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("are left alone for a caller on the current contract", async () => {
    const { fetch, seen } = appFor({
      instrs: [
        { k: "move", from: "/@query/limit", to: "/@query/page_size", c: "chg_limit" },
      ],
      params: { old: [query("limit")], new: [query("page_size")] },
      body: false,
    });
    await fetch(
      new Request("https://api.example.com/v1/items?page_size=3", {
        method: "POST",
        headers: { "items-version": "2" },
      }),
    );
    expect(seen[0]?.query).toEqual({ page_size: "3" });
  });
});

describe("a program that converts a path parameter", () => {
  it("is refused where Hono mounts it, since the route is already matched", () => {
    const runtime = createRuntime({
      program: program(
        {
          instrs: [{ k: "enum", path: "/@path/kind", map: { a: "b" }, c: "chg_kind" }],
          params: {
            old: [
              {
                in: "path",
                name: "kind",
                style: "simple",
                explode: false,
                type: "string",
              },
            ],
            new: [],
          },
          body: false,
        },
        "/v1/items/{kind}",
      ),
      identity: [{ kind: "default", label: "2" }],
    });
    expect(() => adapt({ runtime })).toThrow(/Run the proxy/);
  });
});
