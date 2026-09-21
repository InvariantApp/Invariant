/**
 * The decoder is where a build artifact becomes something that runs against
 * live traffic. Everything it will not accept is as important as what it will.
 */
import { describe, expect, it } from "vitest";
import { createRuntime } from "./index.ts";
import { execute, touchedPaths } from "./interpreter.ts";
import {
  decodeProgram,
  fillTemplate,
  findSite,
  matchTemplate,
  ProgramError,
} from "./program.ts";

function program(sites: Record<string, unknown>, routes: unknown[] = []): unknown {
  return {
    irVersion: 1,
    api: "acme",
    current: "sha256:abc",
    currentLabel: "2026-09-20",
    contracts: {
      "2026-01-15": { label: "2026-01-15", routes, sites, behaviors: [] },
    },
  };
}

const MOVE = { k: "move", from: "/a", to: "/b", c: "chg" };

describe("decoding", () => {
  it("accepts a well-formed program", () => {
    const decoded = decodeProgram(program({ "post /v1/things": { request: [MOVE] } }));
    expect(decoded.currentLabel).toBe("2026-09-20");
    expect(decoded.contracts.get("2026-01-15")?.sites.size).toBe(1);
  });

  it("refuses an IR version it does not implement", () => {
    const value = program({}) as Record<string, unknown>;
    value["irVersion"] = 2;
    expect(() => decodeProgram(value)).toThrow(/Unsupported IR version/);
  });

  it("refuses an instruction it does not know", () => {
    expect(() =>
      decodeProgram(program({ "post /x": { request: [{ k: "exec", c: "chg" }] } })),
    ).toThrow(/unknown instruction/);
  });

  it("refuses an unexpected field rather than ignoring it", () => {
    expect(() =>
      decodeProgram(program({ "post /x": { request: [{ ...MOVE, extra: 1 }] } })),
    ).toThrow(/unexpected field "extra"/);
  });

  it("refuses a pointer that names a prototype key", () => {
    expect(() =>
      decodeProgram(
        program({ "post /x": { request: [{ ...MOVE, to: "/__proto__/x" }] } }),
      ),
    ).toThrow(/may not name "__proto__"/);
  });

  it("refuses a move whose wildcards do not line up", () => {
    expect(() =>
      decodeProgram(
        program({ "post /x": { request: [{ ...MOVE, from: "/d/*/a", to: "/b" }] } }),
      ),
    ).toThrow(/different wildcard counts/);
  });

  it("refuses a path that is not a JSON Pointer", () => {
    expect(() =>
      decodeProgram(program({ "post /x": { request: [{ ...MOVE, from: "a" }] } })),
    ).toThrow(/must be a JSON Pointer/);
  });

  it("refuses a scale exponent outside the supported range", () => {
    expect(() =>
      decodeProgram(
        program({
          "post /x": { request: [{ k: "scale", path: "/a", exp: 20, c: "chg" }] },
        }),
      ),
    ).toThrow(/between -9 and 9/);
  });

  it("accepts the status keys OpenAPI writes, default and an upper-case class included", () => {
    const decoded = decodeProgram(
      program({
        "get /x": { response: { default: [MOVE], "2XX": [MOVE], "404": [MOVE] } },
      }),
    );
    const site = decoded.contracts.get("2026-01-15")?.sites.get("get /x");
    expect([...(site?.response.keys() ?? [])].sort()).toEqual(["2xx", "404", "default"]);
  });

  it("refuses a class named twice in two cases", () => {
    expect(() =>
      decodeProgram(
        program({ "get /x": { response: { "2xx": [MOVE], "2XX": [MOVE] } } }),
      ),
    ).toThrow(/names 2xx twice/);
  });

  it("refuses a response keyed by something that is not a status", () => {
    expect(() =>
      decodeProgram(program({ "post /x": { response: { ok: [MOVE] } } })),
    ).toThrow(/invalid status key/);
  });

  it("decodes a route that changes the HTTP method, and refuses one naming no method", () => {
    const decoded = decodeProgram(
      program({}, [
        {
          from: { method: "get", path: "/search" },
          to: { method: "POST", path: "/search" },
          c: "chg",
        },
      ]),
    );
    expect(decoded.contracts.get("2026-01-15")?.routes[0]).toMatchObject({
      method: "get",
      toMethod: "post",
    });
    expect(() =>
      decodeProgram(
        program({}, [
          {
            from: { method: "get", path: "/a" },
            to: { method: "fetch", path: "/a" },
            c: "chg",
          },
        ]),
      ),
    ).toThrow(/not an HTTP method/);
  });

  it("marks a site as numeric only when it actually needs exact digits", () => {
    const withScale = decodeProgram(
      program({ "post /x": { request: [{ k: "scale", path: "/a", exp: 2, c: "chg" }] } }),
    );
    const withoutScale = decodeProgram(program({ "post /y": { request: [MOVE] } }));
    expect(withScale.contracts.get("2026-01-15")?.sites.get("post /x")?.numeric).toBe(
      true,
    );
    expect(withoutScale.contracts.get("2026-01-15")?.sites.get("post /y")?.numeric).toBe(
      false,
    );
  });

  it("accepts a base path, and refuses one that is not a path", () => {
    expect(decodeProgram({ ...(program({}) as object), basePath: "/v1" }).basePath).toBe(
      "/v1",
    );
    expect(decodeProgram(program({})).basePath).toBe("");
    for (const bad of ["v1", "/v1/", 7]) {
      expect(() => decodeProgram({ ...(program({}) as object), basePath: bad })).toThrow(
        ProgramError,
      );
    }
  });

  it("rejects a program that is not an object at all", () => {
    expect(() => decodeProgram("nope")).toThrow(ProgramError);
    expect(() => decodeProgram(null)).toThrow(ProgramError);
  });
});

describe("template matching", () => {
  it("matches a path parameter and nothing else", () => {
    expect(matchTemplate("/v1/p/{id}".split("/"), "/v1/p/abc")).toEqual(["abc"]);
    expect(matchTemplate("/v1/p/{id}".split("/"), "/v1/p")).toBeUndefined();
    expect(matchTemplate("/v1/p/{id}".split("/"), "/v1/p/abc/x")).toBeUndefined();
    expect(matchTemplate("/v1/p/{id}".split("/"), "/v1/p/")).toBeUndefined();
  });

  it("matches a parameter that shares its segment with literal text", () => {
    const cancel = "/v1/{name}:cancel".split("/");
    expect(matchTemplate(cancel, "/v1/op-7:cancel")).toEqual(["op-7"]);
    expect(matchTemplate(cancel, "/v1/:cancel")).toBeUndefined();
    expect(matchTemplate(cancel, "/v1/op-7:get")).toBeUndefined();
    expect(matchTemplate(cancel, "/v1/a/b:cancel")).toBeUndefined();
    const file = "/files/{id}.{format}".split("/");
    expect(matchTemplate(file, "/files/report.v2.json")).toEqual(["report.v2", "json"]);
    // Literal text is literal, not a pattern.
    expect(matchTemplate("/v1/{id}.x".split("/"), "/v1/abcxx")).toBeUndefined();
  });

  it("fills a template with its parameters wherever they sit", () => {
    expect(fillTemplate("/v2/{name}:cancel".split("/"), ["op-7"])).toBe(
      "/v2/op-7:cancel",
    );
    expect(fillTemplate("/f/{id}.{format}".split("/"), ["a", "json"])).toBe("/f/a.json");
  });

  it("finds a site through its template", () => {
    const decoded = decodeProgram(
      program({ "get /v1/things/{id}": { response: { "200": [MOVE] } } }),
    );
    const contract = decoded.contracts.get("2026-01-15");
    expect(contract && findSite(contract, "GET", "/v1/things/abc")).toBeDefined();
    expect(contract && findSite(contract, "GET", "/v1/other/abc")).toBeUndefined();
    expect(contract && findSite(contract, "POST", "/v1/things/abc")).toBeUndefined();
  });
});

/**
 * A fold names a value the map translates. The decoder is strict about that
 * because a fold is the one instruction that shows a caller something untrue,
 * so a program claiming one it cannot perform should not load at all.
 */
describe("folds", () => {
  const enumInstr = (extra: Record<string, unknown>) =>
    program({
      "get /x": {
        request: [],
        response: {
          "2xx": [
            {
              k: "enum",
              path: "/status",
              map: { pending: "pending", review: "pending" },
              c: "chg",
              ...extra,
            },
          ],
        },
      },
    });

  it("accepts a fold of a value the map translates", () => {
    const decoded = decodeProgram(enumInstr({ folded: ["review"] }));
    const instr = decoded.contracts
      .get("2026-01-15")
      ?.sites.get("get /x")
      ?.response.get("2xx")?.[0];
    expect(instr).toMatchObject({ k: "enum", folded: ["review"] });
  });

  it("refuses a fold of a value the map does not translate", () => {
    expect(() => decodeProgram(enumInstr({ folded: ["unmapped"] }))).toThrow(
      ProgramError,
    );
    expect(() => decodeProgram(enumInstr({ folded: ["unmapped"] }))).toThrow(
      /names "unmapped", which the map does not/,
    );
  });

  it("refuses a fold list that is not strings", () => {
    expect(() => decodeProgram(enumInstr({ folded: [1] }))).toThrow(ProgramError);
  });

  it("leaves an instruction without folds exactly as it was", () => {
    const decoded = decodeProgram(enumInstr({}));
    const instr = decoded.contracts
      .get("2026-01-15")
      ?.sites.get("get /x")
      ?.response.get("2xx")?.[0];
    expect(instr).not.toHaveProperty("folded");
  });
});

/**
 * Named blocks let a program follow a value that contains itself. The decoder
 * is what guarantees that following it ends.
 */
describe("blocks", () => {
  const withBlocks = (blocks: Record<string, unknown>, request: unknown[]) => ({
    ...(program({ "post /x": { request } }) as Record<string, unknown>),
    contracts: {
      "2026-01-15": {
        label: "2026-01-15",
        routes: [],
        sites: { "post /x": { request } },
        blocks,
        behaviors: [],
        retired: [],
      },
    },
  });
  const NODE = {
    Node: [
      { k: "del", path: "/secret", c: "chg" },
      {
        k: "within",
        path: "/children/*",
        block: [{ k: "call", block: "Node", c: "chg" }],
        c: "chg",
      },
    ],
  };

  it("follows a tree as deep as a body may be", () => {
    const decoded = decodeProgram(
      withBlocks(NODE, [{ k: "call", block: "Node", c: "chg" }]),
    );
    const site = decoded.contracts.get("2026-01-15")?.sites.get("post /x");
    let tree: Record<string, unknown> = { secret: 1, children: [] };
    for (let depth = 0; depth < 120; depth += 1) {
      tree = { secret: depth, children: [tree] };
    }
    const out = structuredClone(tree);
    execute(out as never, site?.request ?? []);
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("lists what a recursive block touches without following it forever", () => {
    const decoded = decodeProgram(
      withBlocks(NODE, [{ k: "call", block: "Node", c: "chg" }]),
    );
    const [call] =
      decoded.contracts.get("2026-01-15")?.sites.get("post /x")?.request ?? [];
    expect(call && touchedPaths(call)).toEqual([["secret"], ["children", "*"]]);
  });

  it("refuses a block that calls itself where it stands", () => {
    expect(() =>
      decodeProgram(
        withBlocks({ Loop: [{ k: "call", block: "Loop", c: "chg" }] }, [
          { k: "call", block: "Loop", c: "chg" },
        ]),
      ),
    ).toThrow(/without descending: Loop -> Loop/);
  });

  it("allows a block to call itself inside a within that descends", () => {
    expect(() =>
      decodeProgram(withBlocks(NODE, [{ k: "call", block: "Node", c: "chg" }])),
    ).not.toThrow();
  });

  it("refuses a within with no path as a way around that", () => {
    expect(() =>
      decodeProgram(
        withBlocks(
          {
            Loop: [
              {
                k: "within",
                path: "",
                block: [{ k: "call", block: "Loop", c: "chg" }],
                c: "chg",
              },
            ],
          },
          [],
        ),
      ),
    ).toThrow(ProgramError);
  });
});

describe("response status keys", () => {
  it("run the most specific instructions for a status, then its class, then default", () => {
    const tag = (value: string) => [
      { k: "set", path: "/matched", value, ifAbsent: false, c: "chg" },
    ];
    const runtime = createRuntime({
      program: program({
        "get /x": {
          response: { "404": tag("404"), "4xx": tag("4xx"), default: tag("default") },
        },
      }) as never,
      identity: [{ kind: "default", label: "2026-01-15" }],
    });
    const site = runtime.siteFor("2026-01-15", "get", "/x");
    if (!site) throw new Error("no site");
    const context = { contract: "2026-01-15", operation: "x" };
    const matched = (status: number) =>
      (
        JSON.parse(runtime.transformResponse(site, status, "{}", context)) as {
          matched: string;
        }
      ).matched;
    expect(matched(404)).toBe("404");
    expect(matched(409)).toBe("4xx");
    expect(matched(500)).toBe("default");
    expect(matched(200)).toBe("default");
  });
});
