/**
 * Parameters, through the proxy, to an upstream that records what it got.
 */
import { createRuntime } from "@invariant-app/runtime";
import { describe, expect, it } from "vitest";
import { createProxy } from "./proxy.ts";

const PROGRAM = {
  irVersion: 2,
  api: "items",
  currentLabel: "2",
  current: "sha256:2",
  basePath: "/api",
  contracts: {
    "1": {
      label: "1",
      routes: [],
      sites: {
        "get /items/{kind}": {
          envelope: {
            instrs: [
              {
                k: "enum",
                path: "/@path/kind",
                map: { widget: "widgets" },
                c: "chg_kind",
              },
              {
                k: "move",
                from: "/@query/limit",
                to: "/@query/page_size",
                c: "chg_limit",
              },
              {
                k: "move",
                from: "/@cookie/theme",
                to: "/@header/x-theme",
                c: "chg_theme",
              },
            ],
            params: {
              old: [
                {
                  in: "path",
                  name: "kind",
                  style: "simple",
                  explode: false,
                  type: "string",
                },
                {
                  in: "query",
                  name: "limit",
                  style: "form",
                  explode: true,
                  type: "integer",
                },
                {
                  in: "cookie",
                  name: "theme",
                  style: "form",
                  explode: true,
                  type: "string",
                },
              ],
              new: [
                {
                  in: "query",
                  name: "page_size",
                  style: "form",
                  explode: true,
                  type: "integer",
                },
                {
                  in: "header",
                  name: "x-theme",
                  style: "simple",
                  explode: false,
                  type: "string",
                },
              ],
            },
            body: false,
          },
        },
      },
      behaviors: [],
      retired: [],
    },
  },
};

describe("an old caller's parameters, through the proxy", () => {
  it("reach the upstream in the current contract's path, query, headers and cookies", async () => {
    const seen: Request[] = [];
    const proxy = createProxy({
      runtime: createRuntime({
        program: PROGRAM,
        identity: [
          { kind: "header", name: "items-version" },
          { kind: "default", label: "2" },
        ],
      }),
      upstream: "http://upstream.internal",
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push(new Request(input, init));
        return Response.json({ ok: true });
      }) as typeof fetch,
    });
    const response = await proxy(
      new Request("https://api.example.com/api/items/widget?limit=20&q=a%20b", {
        headers: { "items-version": "1", cookie: "sid=1; theme=dark" },
      }),
    );
    expect(response.status).toBe(200);
    const sent = seen[0] as Request;
    expect(sent.url).toBe(
      "http://upstream.internal/api/items/widgets?q=a%20b&page_size=20",
    );
    expect(sent.headers.get("x-theme")).toBe("dark");
    expect(sent.headers.get("cookie")).toBe("sid=1");
  });
});
