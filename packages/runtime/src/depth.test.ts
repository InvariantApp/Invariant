/**
 * Bodies nested deeper than anything a real API sends are refused as too
 * large, before anything walks them. Found by probing: fifty thousand
 * brackets exhausted the stack, and the proxy answered 500.
 */
import { describe, expect, it } from "vitest";
import { BodyTooDeepError, createRuntime } from "./index.ts";

const runtime = createRuntime({
  program: {
    irVersion: 1,
    api: "depth",
    current: "sha256:0",
    currentLabel: "current",
    contracts: {
      old: {
        label: "old",
        routes: [],
        behaviors: [],
        retired: [],
        sites: {
          "post /json": {
            request: [{ k: "move", from: "/a/*/b", to: "/a/*/c", c: "chg" }],
            response: { "2xx": [{ k: "del", path: "/*/x", c: "chg" }] },
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
  maxBodyBytes: 10_000_000,
});
const context = { contract: "old", operation: "depth" };

describe("a body nested too deeply", () => {
  it("is refused as too large, in JSON, both ways", () => {
    const site = runtime.siteFor("old", "post", "/json");
    if (!site) throw new Error("no site");
    const deep = `{"a":${"[".repeat(50_000)}${"]".repeat(50_000)}}`;
    expect(() => runtime.transformRequest(site, deep, context)).toThrow(BodyTooDeepError);
    expect(() => runtime.transformResponse(site, 200, deep, context)).toThrow(
      BodyTooDeepError,
    );
  });

  it("is refused as too large, in a form's bracketed keys", () => {
    const site = runtime.siteFor("old", "post", "/form");
    if (!site) throw new Error("no site");
    const deep = `metadata${"[a]".repeat(50_000)}=1`;
    expect(() => runtime.transformRequestForm(site, deep, context)).toThrow(
      BodyTooDeepError,
    );
  });

  it("is not refused when the depth is in a string", () => {
    const site = runtime.siteFor("old", "post", "/json");
    if (!site) throw new Error("no site");
    const text = JSON.stringify({ a: [{ b: "[".repeat(1000) }] });
    expect(JSON.parse(runtime.transformRequest(site, text, context))).toEqual({
      a: [{ c: "[".repeat(1000) }],
    });
  });
});
