/**
 * Envelope programs across a chain of releases.
 *
 * Each step is compiled against the two contracts either side of it, and the
 * chain has to read as one program from the oldest caller's request to the
 * current handler: parameters declared the way the oldest caller writes them,
 * body steps placed under `/@body`, and a path parameter named the way the
 * final template names it.
 */
import type { OpenApiDocument } from "@invariant/contract";
import { type Change, parseChange } from "@invariant/ir";
import { describe, expect, it } from "vitest";
import { chainProgram } from "./chain.ts";

function contract(
  path: string,
  parameters: Record<string, unknown>[],
  body?: Record<string, unknown>,
): OpenApiDocument {
  return {
    openapi: "3.0.3",
    info: { title: "t", version: "1" },
    paths: {
      [path]: {
        post: {
          operationId: "search",
          parameters,
          ...(body
            ? { requestBody: { content: { "application/json": { schema: body } } } }
            : {}),
          responses: { "200": { description: "ok" } },
        },
      },
    },
  } as unknown as OpenApiDocument;
}

const query = (name: string) => ({ name, in: "query", schema: { type: "integer" } });
const change = (id: string, scopes: unknown[], ops: unknown[]): Change =>
  parseChange({ irVersion: 1, id, summary: id, scopes, ops });

describe("a chain of releases with parameters", () => {
  it("declares each parameter the way the oldest caller writes it", () => {
    const body = {
      type: "object",
      properties: { q: { type: "string" }, text: { type: "string" } },
    };
    const v1 = contract("/search", [query("limit")], {
      type: "object",
      properties: { q: { type: "string" } },
    });
    const v2 = contract("/search", [query("limit")], {
      type: "object",
      properties: { text: { type: "string" } },
    });
    const v3 = contract("/search", [query("page_size")], body);
    const v4 = contract("/search", [query("size")], body);
    const { program, issues } = chainProgram("t", "v4", "sha256:4", [
      {
        label: "v2",
        parent: "v1",
        from: v1,
        to: v2,
        changes: [
          change(
            "chg_text",
            [{ schema: "#/components/schemas/Missing" }],
            [{ op: "move", from: "/q", to: "/text" }],
          ),
        ],
      },
      {
        label: "v3",
        parent: "v2",
        from: v2,
        to: v3,
        changes: [
          change(
            "chg_page_size",
            [{ operation: "search", location: "query" }],
            [{ op: "move", from: "/limit", to: "/page_size" }],
          ),
        ],
      },
      {
        label: "v4",
        parent: "v3",
        from: v3,
        to: v4,
        changes: [
          change(
            "chg_size",
            [{ operation: "search", location: "query" }],
            [{ op: "move", from: "/page_size", to: "/size" }],
          ),
        ],
      },
    ]);
    // The schema scope names nothing in these inline documents, which is
    // reported; the parameters are what this case is about.
    expect(issues.map((issue) => issue.changeId)).not.toContain("chg_page_size");
    const envelope = program.contracts["v1"]?.sites["post /search"]?.envelope;
    expect(envelope?.instrs.map((instr) => instr.c)).toEqual([
      "chg_page_size",
      "chg_size",
    ]);
    expect(envelope?.params.old.map((codec) => codec.name)).toEqual(["limit"]);
    expect(envelope?.params.new.map((codec) => codec.name).sort()).toEqual([
      "page_size",
      "size",
    ]);
  });

  it("names a path parameter the way the final template does", () => {
    const pathParam = {
      name: "kind",
      in: "path",
      required: true,
      schema: { type: "string" },
    };
    const renamed = { ...pathParam, name: "type" };
    const v1 = contract("/items/{kind}", [pathParam]);
    const v2 = contract("/items/{kind}", [{ ...pathParam, schema: { type: "integer" } }]);
    const v3 = contract("/things/{type}", [{ ...renamed, schema: { type: "integer" } }]);
    const { program, issues } = chainProgram("t", "v3", "sha256:3", [
      {
        label: "v2",
        parent: "v1",
        from: v1,
        to: v2,
        changes: [
          change(
            "chg_kind_integer",
            [{ operation: "search", location: "path" }],
            [
              {
                op: "convert",
                path: "/kind",
                codec: { kind: "cast", from: "string", to: "integer" },
              },
            ],
          ),
        ],
      },
      {
        label: "v3",
        parent: "v2",
        from: v2,
        to: v3,
        changes: [
          change(
            "chg_things",
            [],
            [
              {
                op: "route",
                from: { method: "post", path: "/items/{kind}" },
                to: { method: "post", path: "/things/{type}" },
              },
            ],
          ),
        ],
      },
    ]);
    expect(issues).toEqual([]);
    const site = program.contracts["v1"]?.sites["post /things/{type}"];
    expect(site?.envelope?.instrs).toEqual([
      { k: "cast", path: "/@path/type", to: "integer", c: "chg_kind_integer" },
    ]);
    expect(site?.envelope?.params.old.map((codec) => codec.name)).toEqual(["type"]);
  });

  it("refuses a path parameter op that is not a conversion", () => {
    const pathParam = {
      name: "kind",
      in: "path",
      required: true,
      schema: { type: "string" },
    };
    const v1 = contract("/items/{kind}", [pathParam]);
    const { issues } = chainProgram("t", "v2", "sha256:2", [
      {
        label: "v2",
        parent: "v1",
        from: v1,
        to: v1,
        changes: [
          change(
            "chg_kind",
            [{ operation: "search", location: "path" }],
            [{ op: "move", from: "/kind", to: "/type" }],
          ),
        ],
      },
    ]);
    expect(issues.map((issue) => issue.message).join()).toContain("route change");
  });
});
