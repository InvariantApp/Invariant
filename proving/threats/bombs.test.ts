/**
 * Transformation bombs: small inputs built to make the work, or the output,
 * enormous.
 *
 * DESIGN 11.1 bounds the work a request causes by the operations and the
 * matched places, with a body cap, a depth cap, a wildcard fan-out cap and a
 * per-request time budget. The proxy tests send bodies at those caps over the
 * network; these go after the rest: a specification that multiplies what the
 * compiler writes, YAML that multiplies what the parser holds, a response the
 * runtime would have to fan out over, and a body that would outlast its time.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chainProgram, predictDocument } from "@invariant-app/compiler";
import type { OpenApiDocument } from "@invariant-app/contract";
import type { Change } from "@invariant-app/ir";
import {
  createRuntime,
  MatchLimitError,
  ProgramError,
  TimeBudgetError,
} from "@invariant-app/runtime";
import { describe, expect, it } from "vitest";
import { invariant, workdir } from "./harness.ts";

/**
 * A document where each of `depth` levels holds two references to the next,
 * so the schema at the bottom sits at 2^depth places. A few kilobytes at any
 * depth.
 */
function doubling(depth: number, leafField: string): OpenApiDocument {
  const schemas: Record<string, unknown> = {};
  for (let level = 0; level < depth; level += 1) {
    const next = { $ref: `#/components/schemas/L${level + 1}` };
    schemas[`L${level}`] = { type: "object", properties: { left: next, right: next } };
  }
  schemas[`L${depth}`] = {
    type: "object",
    properties: { [leafField]: { type: "string" } },
  };
  const body = {
    content: { "application/json": { schema: { $ref: "#/components/schemas/L0" } } },
  };
  return JSON.parse(
    JSON.stringify({
      openapi: "3.1.0",
      info: { title: "bomb", version: "1" },
      paths: {
        "/things": {
          post: {
            requestBody: body,
            responses: { "200": { description: "ok", ...body } },
          },
        },
      },
      components: { schemas },
    }),
  ) as OpenApiDocument;
}

function compile(depth: number) {
  const change: Change = {
    irVersion: 1,
    id: "chg_leaf",
    summary: "The field at the bottom was renamed.",
    scopes: [{ schema: `#/components/schemas/L${depth}` }],
    ops: [{ op: "move", from: "/old", to: "/new" }],
  };
  const from = doubling(depth, "old");
  const prediction = predictDocument(from, doubling(depth, "new"), [change]);
  const chained = chainProgram("bomb", "new", "sha256:0", [
    { label: "new", parent: "old", from, to: prediction.document, changes: [change] },
  ]);
  return {
    issues: [...prediction.issues, ...chained.issues],
    program: chained.program,
    bytes: JSON.stringify(chained.program).length,
  };
}

describe("a specification that multiplies what the compiler writes", () => {
  it("compiles a schema at 2^14 places into a program the size of the schemas", () => {
    // Before the fix this wrote 6.8 MB for a one-field rename, and every level
    // doubled it.
    const compiled = compile(14);
    expect(compiled.issues).toEqual([]);
    expect(compiled.bytes).toBeLessThan(64 * 1024);

    // And the program still renames the field at every one of those places.
    const runtime = createRuntime({
      program: compiled.program as never,
      identity: [{ kind: "default", label: "old" }],
      maxBodyBytes: 4 * 1024 * 1024,
    });
    const tree = (level: number): unknown =>
      level === 14 ? { old: "x" } : { left: tree(level + 1), right: tree(level + 1) };
    const site = runtime.siteFor("old", "post", "/things");
    if (!site) throw new Error("no site");
    const out = runtime.transformRequest(site, JSON.stringify(tree(0)), {
      contract: "old",
      operation: "bomb",
    });
    expect(out.split('"new":"x"').length - 1).toBe(2 ** 14);
    expect(out).not.toContain('"old"');
  });

  it("compiles a schema at 2^24 places in moments, where it once overflowed the stack", () => {
    // Sixteen levels were enough to end the compiler with a RangeError.
    const started = performance.now();
    const compiled = compile(24);
    expect(compiled.issues).toEqual([]);
    expect(compiled.bytes).toBeLessThan(64 * 1024);
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});

describe("YAML that multiplies what the parser holds", () => {
  it("invariant check refuses an alias expansion before building it", async () => {
    // Ten aliases at each of nine levels: a billion values from 1 KB of text.
    const lines = ['a0: &a0 ["x","x","x","x","x","x","x","x","x","x"]'];
    for (let level = 1; level <= 9; level += 1) {
      const previous = `*a${level - 1}`;
      lines.push(`a${level}: &a${level} [${Array(10).fill(previous).join(",")}]`);
    }
    const root = await workdir("bomb");
    try {
      await mkdir(join(root, ".git"));
      await writeFile(
        join(root, "head.yaml"),
        [
          "openapi: 3.0.3",
          "info: { title: bomb, version: '1' }",
          "paths: {}",
          "x-bomb:",
          ...lines.map((line) => `  ${line}`),
          "",
        ].join("\n"),
      );
      await writeFile(
        join(root, "base.yaml"),
        "openapi: 3.0.3\ninfo: { title: bomb, version: '1' }\npaths: {}\n",
      );
      await writeFile(
        join(root, "invariant.yaml"),
        'api: bomb\nspec:\n  current: head.yaml\n  released:\n    "2026-01-01": base.yaml\nidentity:\n  - kind: default\n    label: "2026-01-01"\n',
      );
      const started = performance.now();
      const result = await invariant(["check", "--config", join(root, "invariant.yaml")]);
      expect(result.code).toBe(1);
      expect(result.output).toMatch(/expands to more than/);
      expect(performance.now() - started).toBeLessThan(30_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const fanOut = createRuntime({
  program: {
    irVersion: 2,
    api: "bomb",
    current: "sha256:0",
    currentLabel: "new",
    contracts: {
      old: {
        label: "old",
        routes: [],
        behaviors: [],
        retired: [],
        sites: {
          "post /items": {
            request: Array.from({ length: 60 }, (_, index) => ({
              k: "move",
              from: `/items/*/f${index}`,
              to: `/items/*/g${index}`,
              c: "chg_many",
            })),
            response: {
              "2xx": [
                { k: "move", from: "/a/*/b/*/c", to: "/a/*/b/*/d", c: "chg_nested" },
              ],
            },
          },
        },
      },
    },
  },
  identity: [{ kind: "default", label: "old" }],
  maxBodyBytes: 64 * 1024 * 1024,
  limits: { maxMatches: 10_000, timeBudgetMs: 5 },
});
const context = { contract: "old", operation: "bomb" };

describe("bodies that would make the runtime work without end", () => {
  it("refuses a response whose nested wildcards match past the cap", () => {
    const site = fanOut.siteFor("old", "post", "/items");
    if (!site) throw new Error("no site");
    const a = Array.from({ length: 101 }, () => ({
      b: Array.from({ length: 101 }, () => ({ c: 1 })),
    }));
    expect(() =>
      fanOut.transformResponse(site, 200, JSON.stringify({ a }), context),
    ).toThrow(MatchLimitError);
  });

  it("stops a body that outlasts its time budget, rather than finishing late", () => {
    const site = fanOut.siteFor("old", "post", "/items");
    if (!site) throw new Error("no site");
    // Sixty instructions over 9,000 items each: every instruction is within
    // the fan-out cap, and together they are far past five milliseconds.
    const item = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [`f${index}`, 1]),
    );
    const items = Array.from({ length: 9_000 }, () => item);
    expect(() =>
      fanOut.transformRequest(site, JSON.stringify({ items }), context),
    ).toThrow(TimeBudgetError);
  });

  const program = (
    request: unknown[],
    blocks: Record<string, unknown[]> = {},
  ): Parameters<typeof createRuntime>[0] => ({
    program: {
      irVersion: 2,
      api: "bomb",
      current: "sha256:0",
      currentLabel: "new",
      contracts: {
        old: {
          label: "old",
          routes: [],
          behaviors: [],
          retired: [],
          ...(Object.keys(blocks).length > 0 ? { blocks } : {}),
          sites: { "post /x": { request } },
        },
      },
    } as never,
    identity: [{ kind: "default", label: "old" }],
  });

  it("refuses a program whose blocks nest deeper than any compiler writes", () => {
    let nested: unknown[] = [{ k: "del", path: "/x", c: "chg" }];
    for (let level = 0; level < 12; level += 1) {
      nested = [{ k: "within", path: "/a", block: nested, c: "chg" }];
    }
    expect(() => createRuntime(program(nested))).toThrow(/nests blocks more than/);
  });

  it("refuses a program whose blocks call one another forever on one value", () => {
    expect(() =>
      createRuntime(
        program([{ k: "call", block: "loop", c: "chg" }], {
          loop: [{ k: "call", block: "again", c: "chg" }],
          again: [{ k: "call", block: "loop", c: "chg" }],
        }),
      ),
    ).toThrow(ProgramError);
  });
});
