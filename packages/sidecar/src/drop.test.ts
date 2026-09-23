/**
 * A list parameter that stopped accepting values, served end to end.
 *
 * Asana took a hundred and twenty-six fields out of what a portfolio's items
 * may be asked to include, and an old caller asking for `opt_fields=color` was
 * refused outright. The Change the proposer drafts for it (its own tests say
 * so) compiled, and an old caller's request reaching the provider with the
 * fields that are gone left out and everything else it asked for kept, in
 * order.
 */
import { chainProgram, derive, predictDocument } from "@invariant-app/compiler";
import type { OpenApiDocument } from "@invariant-app/contract";
import { parseChange } from "@invariant-app/ir";
import { createRuntime } from "@invariant-app/runtime";
import { describe, expect, it } from "vitest";
import { createProxy } from "./proxy.ts";

const doc = (fields: string[]): OpenApiDocument =>
  ({
    openapi: "3.0.3",
    info: { title: "portfolios", version: "1" },
    paths: {
      "/portfolios/{gid}/items": {
        get: {
          operationId: "getItemsForPortfolio",
          parameters: [
            { name: "gid", in: "path", required: true, schema: { type: "string" } },
            {
              name: "opt_fields",
              in: "query",
              style: "form",
              explode: false,
              schema: { type: "array", items: { type: "string", enum: fields } },
            },
          ],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  }) as unknown as OpenApiDocument;

const before = doc(["name", "color", "owner", "archived"]);
const after = doc(["name", "owner"]);
const changes = [
  parseChange({
    irVersion: 1,
    id: "chg_get_items_for_portfolio_opt_fields",
    summary: "Fewer fields may be asked for.",
    scopes: [{ operation: "getItemsForPortfolio", location: "query" }],
    ops: [
      {
        op: "convert",
        path: "/opt_fields",
        codec: { kind: "dropValues", values: ["color", "archived"] },
      },
    ],
  }),
];

describe("a list parameter that stopped accepting values (Asana)", () => {
  it("predicts the new contract, and is a declared loss", () => {
    expect(predictDocument(before, after, changes).issues).toEqual([]);
    expect(changes.map((change) => derive(change).runtime)).toEqual(["declared-lossy"]);
  });

  it("reaches the provider with the fields that are gone left out", async () => {
    const { program, issues } = chainProgram("portfolios", "v2", "sha256:2", [
      { label: "v2", parent: "v1", from: before, to: after, changes },
    ]);
    expect(issues).toEqual([]);

    const seen: Request[] = [];
    const proxy = createProxy({
      runtime: createRuntime({
        program,
        identity: [
          { kind: "header", name: "asana-version" },
          { kind: "default", label: "v2" },
        ],
      }),
      upstream: "http://upstream.internal",
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push(new Request(input, init));
        return Response.json({ data: [] });
      }) as typeof fetch,
    });
    const response = await proxy(
      new Request(
        "https://app.asana.com/portfolios/12/items?opt_fields=name,color,owner,archived",
        { headers: { "asana-version": "v1" } },
      ),
    );
    expect(response.status).toBe(200);
    const sent = new URL((seen[0] as Request).url);
    expect(sent.pathname).toBe("/portfolios/12/items");
    expect(sent.searchParams.get("opt_fields")).toBe("name,owner");

    // A current caller's request is not touched.
    await proxy(
      new Request("https://app.asana.com/portfolios/12/items?opt_fields=name,owner"),
    );
    expect(new URL((seen[1] as Request).url).searchParams.get("opt_fields")).toBe(
      "name,owner",
    );
  });
});
