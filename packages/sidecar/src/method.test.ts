/**
 * A search that moved from GET with a query string to POST with a body, served
 * end to end: Changes compiled against both contracts, and an old caller's GET
 * reaching the provider as the POST it now expects.
 */
import { chainProgram, predictDocument } from "@invariant/compiler";
import type { OpenApiDocument } from "@invariant/contract";
import { parseChange } from "@invariant/ir";
import { createRuntime } from "@invariant/runtime";
import { describe, expect, it } from "vitest";
import { createProxy } from "./proxy.ts";

const doc = (operation: Record<string, unknown>, method: string): OpenApiDocument =>
  ({
    openapi: "3.0.3",
    info: { title: "search", version: "1" },
    paths: { "/search": { [method]: { operationId: "search", ...operation } } },
  }) as unknown as OpenApiDocument;

const before = doc(
  {
    parameters: [
      { name: "q", in: "query", required: true, schema: { type: "string" } },
      { name: "limit", in: "query", schema: { type: "integer" } },
    ],
    responses: { "200": { description: "ok" } },
  },
  "get",
);
const after = doc(
  {
    parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
    requestBody: {
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["q"],
            properties: { q: { type: "string" } },
          },
        },
      },
    },
    responses: { "200": { description: "ok" } },
  },
  "post",
);

describe("a search moved from GET to POST", () => {
  it("reaches the provider as a POST with the query in its body", async () => {
    const changes = [
      parseChange({
        irVersion: 1,
        id: "chg_search_post",
        summary: "Search takes its query in a body.",
        ops: [
          {
            op: "route",
            from: { method: "get", path: "/search" },
            to: { method: "post", path: "/search" },
          },
        ],
      }),
      parseChange({
        irVersion: 1,
        id: "chg_search_query_body",
        summary: "q moved into the body.",
        scopes: [{ operation: "search", location: "query" }],
        ops: [{ op: "move", from: "/q", to: "/@body/q" }],
      }),
    ];
    // Closure: replaying the Changes over the old contract predicts the new.
    const prediction = predictDocument(before, after, changes);
    expect(prediction.issues).toEqual([]);
    const predicted = (
      prediction.document["paths"] as Record<string, Record<string, unknown>>
    )["/search"];
    expect(Object.keys(predicted ?? {})).toEqual(["post"]);
    const post = predicted?.["post"] as { requestBody?: unknown } | undefined;
    expect(JSON.stringify(post?.requestBody)).toContain('"q"');

    const { program, issues } = chainProgram("search", "v2", "sha256:2", [
      { label: "v2", parent: "v1", from: before, to: after, changes },
    ]);
    expect(issues).toEqual([]);

    const seen: Request[] = [];
    const proxy = createProxy({
      runtime: createRuntime({
        program,
        identity: [
          { kind: "header", name: "search-version" },
          { kind: "default", label: "v2" },
        ],
      }),
      upstream: "http://upstream.internal",
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push(new Request(input, init));
        return Response.json({ ok: true });
      }) as typeof fetch,
    });
    const response = await proxy(
      new Request("https://api.example.com/search?q=shoes&limit=5", {
        headers: { "search-version": "v1" },
      }),
    );
    expect(response.status).toBe(200);
    const sent = seen[0] as Request;
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe("http://upstream.internal/search?limit=5");
    expect(sent.headers.get("content-type")).toBe("application/json");
    expect(await sent.json()).toEqual({ q: "shoes" });
  });
});
