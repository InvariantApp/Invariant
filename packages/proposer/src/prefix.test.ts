/**
 * Detecting that a whole API moved to a new URL prefix.
 *
 * Written after running sixty real version pairs through the gate and watching
 * `api-path-removed-without-deprecation` come back 1572 times, far ahead of
 * anything else. Nothing had been removed. AWS ships `/2017-10-30/distribution`
 * and then `/2018-06-18/distribution`; Google ships `/v1/apps` and then
 * `/v1alpha/apps`. The version is in the path, so bumping it moves everything.
 *
 * The cases below are the real shapes, and the ones that matter most are the
 * refusals: claiming a whole-API move when a handful of endpoints were
 * reorganised would bury genuine removals under a route change that looks like
 * it explained them.
 */
import type { OpenApiDocument } from "@invariant/contract";
import { describe, expect, it } from "vitest";
import { detectPrefixMove, prefixChange } from "./prefix.ts";

function doc(paths: Record<string, string[]>): OpenApiDocument {
  const out: Record<string, unknown> = {};
  for (const [path, methods] of Object.entries(paths)) {
    out[path] = Object.fromEntries(
      methods.map((method) => [method, { responses: { "200": { description: "ok" } } }]),
    );
  }
  return {
    openapi: "3.0.3",
    info: { title: "t", version: "1" },
    paths: out,
  } as OpenApiDocument;
}

function under(prefix: string, names: readonly string[]): Record<string, string[]> {
  return Object.fromEntries(names.map((name) => [`/${prefix}/${name}`, ["get"]]));
}

const ENDPOINTS = ["distribution", "distribution/{id}", "invalidation", "streaming"];

describe("an API that moved to a new prefix", () => {
  it("recognises a dated prefix being bumped, as AWS does it", () => {
    const move = detectPrefixMove(
      doc(under("2017-10-30", ENDPOINTS)),
      doc(under("2018-06-18", ENDPOINTS)),
    );

    expect(move?.from).toBe("2017-10-30");
    expect(move?.to).toBe("2018-06-18");
    expect(move?.moved).toHaveLength(4);
    expect(move?.confidence).toBe(1);
  });

  it("recognises a version prefix being bumped, as Google does it", () => {
    const move = detectPrefixMove(
      doc(under("v1", ENDPOINTS)),
      doc(under("v1alpha", ENDPOINTS)),
    );
    expect(move?.from).toBe("v1");
    expect(move?.to).toBe("v1alpha");
  });

  it("turns the move into one Change rather than one per endpoint", () => {
    const move = detectPrefixMove(
      doc(under("2017-10-30", ENDPOINTS)),
      doc(under("2018-06-18", ENDPOINTS)),
    );
    const change = prefixChange(move as NonNullable<typeof move>);

    // It was one decision. Sixty Changes all saying the same thing would be
    // sixty things to review and sixty things to retire separately.
    expect(change.ops).toHaveLength(4);
    expect(change.ops.every((op) => op.op === "route")).toBe(true);
    expect(change.summary).toContain("2018-06-18");
  });

  it("keeps the method, so a moved POST does not become a moved GET", () => {
    const move = detectPrefixMove(
      doc({ "/v1/things": ["get", "post"], "/v1/things/{id}": ["get"] }),
      doc({ "/v2/things": ["get", "post"], "/v2/things/{id}": ["get"] }),
    );

    expect(move?.moved.map((entry) => `${entry.method} ${entry.to}`).sort()).toEqual([
      "get /v2/things",
      "get /v2/things/{id}",
      "post /v2/things",
    ]);
  });

  it("reports what it does not explain alongside what it does", () => {
    const move = detectPrefixMove(
      doc({ ...under("v1", ENDPOINTS), "/v1/legacy": ["get"] }),
      doc(under("v2", ENDPOINTS)),
    );

    // `/v1/legacy` has no counterpart, and saying nothing about it would be
    // the difference between a helpful draft and a misleading one.
    expect(move?.moved).toHaveLength(4);
    expect(move?.unexplained).toBe(1);
  });
});

describe("what it refuses to call a move", () => {
  it("says nothing when the paths did not change", () => {
    expect(
      detectPrefixMove(doc(under("v1", ENDPOINTS)), doc(under("v1", ENDPOINTS))),
    ).toBeUndefined();
  });

  /**
   * The refusal that matters. Two endpoints relocating is a reorganisation;
   * calling it a whole-API move would file genuine removals under a route
   * change that appears to have accounted for them.
   */
  it("says nothing when most of what went missing is unaccounted for", () => {
    const move = detectPrefixMove(
      doc({
        "/v1/a": ["get"],
        "/v1/b": ["get"],
        "/v1/c": ["get"],
        "/v1/d": ["get"],
        "/v1/e": ["get"],
      }),
      doc({ "/v2/a": ["get"], "/v2/b": ["get"] }),
    );

    expect(move).toBeUndefined();
  });

  it("says nothing about a single endpoint moving", () => {
    const move = detectPrefixMove(doc({ "/v1/a": ["get"] }), doc({ "/v2/a": ["get"] }));
    // One endpoint is a coincidence. A prefix move is a pattern or it is not
    // worth claiming.
    expect(move).toBeUndefined();
  });

  it("says nothing when endpoints were removed rather than moved", () => {
    const move = detectPrefixMove(
      doc(under("v1", ENDPOINTS)),
      doc(under("v1", ["distribution"])),
    );
    expect(move).toBeUndefined();
  });

  it("is not fooled by paths that only look alike below the first segment", () => {
    // `/v1/a/b` to `/v2/a/c` is not a prefix substitution: the tail changed too,
    // and treating it as one would claim an endpoint exists that does not.
    const move = detectPrefixMove(
      doc({ "/v1/a/b": ["get"], "/v1/a/c": ["get"], "/v1/a/d": ["get"] }),
      doc({ "/v2/x/b": ["get"], "/v2/x/c": ["get"], "/v2/x/d": ["get"] }),
    );
    expect(move).toBeUndefined();
  });
});
