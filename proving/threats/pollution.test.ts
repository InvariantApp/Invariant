/**
 * Prototype pollution: `__proto__`, `constructor` and `prototype` as JSON
 * keys and as pointer segments, sent to every layer that turns text into
 * objects and walks them by name.
 *
 * Two things are asserted each time. Nothing lands on the prototypes every
 * object in the process shares, and the key is either carried as the data it
 * is or refused with the layer's own error, never silently resolved to
 * something the document did not say.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "@invariant-app/cli";
import { chainProgram, predictDocument } from "@invariant-app/compiler";
import {
  bundleDocument,
  contractOf,
  type OpenApiDocument,
  parseDocumentText,
  resolveRef,
} from "@invariant-app/contract";
import { parseFlags } from "@invariant-app/flags";
import { type Change, parseChange } from "@invariant-app/ir";
import { createRuntime } from "@invariant-app/runtime";
import { ConfigError, parseConfig } from "@invariant-app/sidecar";
import { afterEach, describe, expect, it } from "vitest";
import { pollutedPrototypes, workdir } from "./harness.ts";

const UNSAFE = ["__proto__", "constructor", "prototype"] as const;

afterEach(() => {
  expect(pollutedPrototypes()).toEqual([]);
});

/** A body that tries every way JSON can name the shared prototypes. */
const HOSTILE_BODY =
  '{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}},' +
  '"prototype":{"polluted":1},"amount":5,' +
  '"lines":[{"__proto__":{"polluted":1},"qty":1}],' +
  '"metadata":{"__proto__":{"polluted":1},"a":1}}';

const runtime = createRuntime({
  program: {
    irVersion: 2,
    api: "pollution",
    current: "sha256:0",
    currentLabel: "new",
    contracts: {
      old: {
        label: "old",
        routes: [],
        behaviors: [],
        retired: [],
        sites: {
          "post /json": {
            request: [
              { k: "move", from: "/amount", to: "/amount_cents", c: "chg" },
              { k: "move", from: "/lines/*/qty", to: "/lines/*/quantity", c: "chg" },
              { k: "del", path: "/metadata/*", c: "chg" },
            ],
            response: {
              "2xx": [{ k: "move", from: "/amount_cents", to: "/amount", c: "chg" }],
            },
          },
          "post /form": {
            form: {
              fields: { metadata: { style: "deepObject", explode: true } },
              types: {},
            },
            request: [{ k: "move", from: "/metadata/a", to: "/metadata/b", c: "chg" }],
          },
        },
      },
    },
  },
  identity: [{ kind: "default", label: "old" }],
});
const context = { contract: "old", operation: "pollution" };

describe("the runtime", () => {
  it("carries the keys through a request as data, and moves what it was asked to", () => {
    const site = runtime.siteFor("old", "post", "/json");
    if (!site) throw new Error("no site");
    const out = JSON.parse(runtime.transformRequest(site, HOSTILE_BODY, context));
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(out.amount_cents).toBe(5);
    expect(out.lines[0].quantity).toBe(1);
  });

  it("walks a wildcard over an object holding __proto__ without writing through it", () => {
    const site = runtime.siteFor("old", "post", "/json");
    if (!site) throw new Error("no site");
    // `del /metadata/*` would, followed naively, delete from Object.prototype.
    const out = JSON.parse(runtime.transformRequest(site, HOSTILE_BODY, context));
    expect(Object.getPrototypeOf(out.metadata)).toBe(Object.prototype);
  });

  it("carries them through a response", () => {
    const site = runtime.siteFor("old", "post", "/json");
    if (!site) throw new Error("no site");
    const out = JSON.parse(
      runtime.transformResponse(
        site,
        200,
        '{"__proto__":{"polluted":1},"amount_cents":5}',
        context,
      ),
    );
    expect(out.amount).toBe(5);
  });

  it("reads a form's bracketed keys without letting one name a prototype", () => {
    const site = runtime.siteFor("old", "post", "/form");
    if (!site) throw new Error("no site");
    runtime.transformRequestForm(
      site,
      "metadata[__proto__][polluted]=1&metadata[constructor][prototype][polluted]=1" +
        "&__proto__[polluted]=1&metadata[a]=1",
      context,
    );
  });

  it.each([
    "/__proto__/polluted",
    "/constructor/prototype/polluted",
    "/a/prototype",
    "/lines/*/__proto__",
  ])("refuses to load a program whose pointer is %s", (pointer) => {
    expect(() =>
      createRuntime({
        program: {
          irVersion: 2,
          api: "pollution",
          current: "sha256:0",
          currentLabel: "new",
          contracts: {
            old: {
              label: "old",
              routes: [],
              behaviors: [],
              retired: [],
              sites: {
                "post /x": { request: [{ k: "del", path: pointer, c: "chg" }] },
              },
            },
          },
        },
        identity: [{ kind: "default", label: "old" }],
      }),
    ).toThrow(/may not name/);
  });
});

/** Old and new contracts where `field` is renamed `renamed`. */
function renamed(field: string): { old: OpenApiDocument; new: OpenApiDocument } {
  const contract = (name: string) =>
    JSON.parse(
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        paths: {
          "/things": {
            post: {
              requestBody: {
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/Thing" } },
                },
              },
              responses: { "200": { description: "ok" } },
            },
          },
        },
        components: { schemas: { Thing: { type: "object" } } },
      }).replace(
        '"Thing":{"type":"object"}',
        `"Thing":{"type":"object","properties":{"${name}":{"type":"string"}}}`,
      ),
    ) as OpenApiDocument;
  return { old: contract(field), new: contract("renamed") };
}

describe("the compiler", () => {
  it.each(UNSAFE)(
    "refuses a Change whose pointer names %s, before emitting a program",
    (key) => {
      const pair = renamed(key);
      const change: Change = {
        irVersion: 1,
        id: "chg_unsafe",
        summary: "unsafe",
        scopes: [{ schema: "#/components/schemas/Thing" }],
        ops: [{ op: "move", from: `/${key}`, to: "/renamed" }],
      };
      const prediction = predictDocument(pair.old, pair.new, [change]);
      expect(prediction.issues.map((issue) => issue.message).join("\n")).toContain(
        `names "${key}"`,
      );
      // Before the fix `prototype` compiled without an issue into a program the
      // runtime then refused at load, in production, on deploy.
      const chained = chainProgram("t", "new", "sha256:0", [
        { label: "new", parent: "old", from: pair.old, to: pair.new, changes: [change] },
      ]);
      expect(chained.issues.map((issue) => issue.message).join("\n")).toContain(
        `names "${key}"`,
      );
    },
  );

  it("parses a Change holding __proto__ keys without taking them as its own", () => {
    expect(() =>
      parseChange(
        JSON.parse(
          '{"irVersion":1,"id":"chg_x","summary":"x","ops":[],"__proto__":{"polluted":1}}',
        ),
      ),
    ).toThrow();
  });
});

describe("the pointer layer", () => {
  const document = JSON.parse(
    '{"openapi":"3.0.3","info":{"title":"t","version":"1"},"paths":{},' +
      '"components":{"schemas":{"Real":{"type":"string"}}}}',
  ) as OpenApiDocument;

  it.each([
    "#/__proto__",
    "#/components/schemas/__proto__",
    "#/components/schemas/constructor",
    "#/components/schemas/Real/constructor",
    "#/components/__proto__/polluted",
  ])("finds nothing at %s rather than a prototype", (ref) => {
    // Before the fix `#/components/schemas/__proto__` resolved to
    // Object.prototype and `constructor` to Object itself.
    expect(resolveRef(document, ref)).toBeUndefined();
  });

  it("refuses a document that refers to a prototype as a schema it does not define", () => {
    const refers = JSON.parse(
      JSON.stringify(document).replace(
        '"paths":{}',
        '"paths":{"/a":{"get":{"responses":{"200":{"description":"ok","content":{"application/json":{"schema":{"$ref":"#/components/schemas/constructor"}}}}}}}}',
      ),
    );
    expect(() => contractOf("x", refers)).toThrow(/is referenced but not defined/);
  });

  it("keeps a schema kept in a file named __proto__ when a split document is gathered", async () => {
    const root = await workdir("pollution-bundle");
    try {
      await mkdir(join(root, ".git"));
      await writeFile(
        join(root, "openapi.json"),
        JSON.stringify({
          openapi: "3.0.3",
          info: { title: "t", version: "1" },
          paths: {
            "/a": {
              get: {
                responses: {
                  "200": {
                    description: "ok",
                    content: {
                      "application/json": { schema: { $ref: "./__proto__.json" } },
                    },
                  },
                },
              },
            },
          },
        }),
      );
      await writeFile(join(root, "__proto__.json"), '{"type":"string"}');
      const bundled = await bundleDocument(join(root, "openapi.json"));
      const schemas = (bundled["components"] as { schemas: Record<string, unknown> })
        .schemas;
      // Placed under a name of its own, since `__proto__` cannot be one.
      expect(Object.keys(schemas)).toEqual(["__proto___2"]);
      expect(() => contractOf("x", bundled)).not.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads __proto__ keys in YAML and JSON specifications as keys", () => {
    for (const [path, text] of [
      [
        "a.yaml",
        "a:\n  __proto__:\n    polluted: 1\n  constructor:\n    prototype:\n      polluted: 1\n",
      ],
      ["a.json", '{"a":{"__proto__":{"polluted":1}}}'],
      // Text the first YAML reader refuses goes to the second.
      ["b.yaml", 'a:\n  __proto__:\n    polluted: 1\nb: "x\n  y"\n'],
    ] as const) {
      const value = parseDocumentText(path, text) as { a: object };
      expect(Object.hasOwn(value.a, "__proto__")).toBe(true);
      expect(Object.getPrototypeOf(value.a)).toBe(Object.prototype);
    }
  });
});

describe("configuration", () => {
  it("the proxy refuses __proto__ as a setting rather than reading through it", () => {
    expect(() =>
      parseConfig(
        JSON.parse(
          '{"program":"p.json","upstream":"http://127.0.0.1:1","__proto__":{"skip":["/"]}}',
        ),
        "/tmp",
      ),
    ).toThrow(ConfigError);
    expect(() =>
      parseConfig(
        JSON.parse(
          '{"program":"p.json","upstream":"http://127.0.0.1:1","listen":{"__proto__":{"port":1}}}',
        ),
        "/tmp",
      ),
    ).toThrow(ConfigError);
  });

  it("flags read __proto__ as nothing", () => {
    const flags = parseFlags(
      '{"__proto__":{"allDisabled":true},"constructor":{"prototype":{"allDisabled":true}}}',
    );
    expect(flags).toEqual({});
  });

  it("invariant.yaml with a __proto__ setting is refused as a setting it does not know", async () => {
    const root = await workdir("pollution-config");
    try {
      await writeFile(join(root, "openapi.json"), "{}");
      await writeFile(
        join(root, "invariant.yaml"),
        [
          "api: t",
          "__proto__:",
          "  polluted: 1",
          "spec:",
          "  current: openapi.json",
          "  released:",
          "    __proto__: openapi.json",
          "identity:",
          "  - kind: default",
          "    label: x",
          "",
        ].join("\n"),
      );
      await expect(loadConfig(join(root, "invariant.yaml"))).rejects.toThrow(
        /__proto__ is not a setting/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
