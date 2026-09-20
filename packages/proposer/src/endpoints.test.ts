/**
 * The two things the proposer could not see, until sixty real APIs said so.
 *
 * Whole endpoints disappearing was the commonest breaking change in the wild,
 * and nothing could express one. Query and path parameters were invisible
 * entirely: 483 real deltas about them, against a `ParameterScope` the IR had
 * all along.
 *
 * The cases that matter most here are the ones about not double-counting. An
 * endpoint that moved must not also be reported as retired, and a parameter on
 * an endpoint that no longer exists must not be reported at all.
 */
import type { OpenApiDocument } from "@invariant/contract";
import { describe, expect, it } from "vitest";
import {
  parameterChanges,
  parameterDeltas,
  retireChange,
  retiredEndpoints,
} from "./endpoints.ts";

interface Op {
  parameters?: unknown[];
}

function doc(paths: Record<string, Record<string, Op>>): OpenApiDocument {
  const out: Record<string, unknown> = {};
  for (const [path, methods] of Object.entries(paths)) {
    out[path] = Object.fromEntries(
      Object.entries(methods).map(([method, operation]) => [
        method,
        { responses: { "200": { description: "ok" } }, ...operation },
      ]),
    );
  }
  return {
    openapi: "3.0.3",
    info: { title: "t", version: "1" },
    paths: out,
  } as OpenApiDocument;
}

function param(
  name: string,
  where: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { name, in: where, schema: { type: "string", ...extra } };
}

describe("endpoints that are simply gone", () => {
  it("finds one the new contract does not have", () => {
    const gone = retiredEndpoints(
      doc({ "/v1/a": { get: {} }, "/v1/legacy": { post: {} } }),
      doc({ "/v1/a": { get: {} } }),
    );

    expect(gone).toHaveLength(1);
    expect(gone[0]?.path).toBe("/v1/legacy");
    expect(gone[0]?.method).toBe("post");
  });

  it("tells two methods on the same path apart", () => {
    const gone = retiredEndpoints(
      doc({ "/v1/a": { get: {}, post: {} } }),
      doc({ "/v1/a": { get: {} } }),
    );

    expect(gone).toHaveLength(1);
    expect(gone[0]?.method).toBe("post");
  });

  /**
   * The one that matters. A version bump moves every endpoint at once, and
   * reporting each as both relocated and retired would turn one route change
   * into sixty contradictory drafts.
   */
  it("does not retire an endpoint a route change already moved", () => {
    const gone = retiredEndpoints(
      doc({ "/v1/a": { get: {} }, "/v1/b": { get: {} } }),
      doc({ "/v2/a": { get: {} }, "/v2/b": { get: {} } }),
      new Set(["get /v1/a", "get /v1/b"]),
    );

    expect(gone).toEqual([]);
  });

  it("says nothing when nothing went", () => {
    expect(
      retiredEndpoints(doc({ "/v1/a": { get: {} } }), doc({ "/v1/a": { get: {} } })),
    ).toEqual([]);
  });

  it("drafts a Change that carries no transform", () => {
    const change = retireChange({
      method: "post",
      path: "/v1/legacy",
      operationId: "legacy",
    });

    expect(change.ops).toEqual([
      { op: "retire", endpoint: { method: "post", path: "/v1/legacy" } },
    ]);
    // There is no handler left to reach, so there is nothing for a transform
    // to rewrite a request into. The op exists to let the provider say so.
    expect(change.ops.every((op) => op.op === "retire")).toBe(true);
  });
});

describe("parameters", () => {
  it("sees a query parameter whose allowed values narrowed", () => {
    const deltas = parameterDeltas(
      doc({
        "/v1/orders": {
          get: { parameters: [param("status", "query", { enum: ["open", "closed"] })] },
        },
      }),
      doc({
        "/v1/orders": {
          get: { parameters: [param("status", "query", { enum: ["open", "settled"] })] },
        },
      }),
    );

    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.location).toBe("query");
    expect(deltas[0]?.altered[0]?.before.enumValues).toEqual(["open", "closed"]);
  });

  it("drafts the value mapping when exactly one value moved", () => {
    const changes = parameterChanges(
      parameterDeltas(
        doc({
          "/v1/orders": {
            get: { parameters: [param("status", "query", { enum: ["open", "closed"] })] },
          },
        }),
        doc({
          "/v1/orders": {
            get: {
              parameters: [param("status", "query", { enum: ["open", "settled"] })],
            },
          },
        }),
      ),
    );

    expect(changes).toHaveLength(1);
    expect(changes[0]?.ops[0]).toEqual({
      op: "convert",
      path: "/status",
      codec: {
        kind: "enumMap",
        pairs: [
          ["open", "open"],
          ["closed", "settled"],
        ],
      },
    });
    expect(changes[0]?.scopes?.[0]).toMatchObject({ location: "query" });
  });

  it("drafts nothing when more than one value moved", () => {
    // Two values out and two in is a pairing nobody stated, and guessing it
    // would map a caller's value to the wrong one half the time.
    const changes = parameterChanges(
      parameterDeltas(
        doc({
          "/v1/orders": {
            get: { parameters: [param("status", "query", { enum: ["a", "b", "c"] })] },
          },
        }),
        doc({
          "/v1/orders": {
            get: { parameters: [param("status", "query", { enum: ["a", "x", "y"] })] },
          },
        }),
      ),
    );

    expect(changes).toEqual([]);
  });

  it("picks up parameters declared on the path rather than the operation", () => {
    // A path-level parameter applies to every operation beneath it, so missing
    // them would miss whole endpoints' worth of change.
    const withPathParam = (values: string[]): OpenApiDocument =>
      ({
        openapi: "3.0.3",
        info: { title: "t", version: "1" },
        paths: {
          "/v1/orders/{id}": {
            parameters: [param("id", "path", { enum: values })],
            get: { responses: { "200": { description: "ok" } } },
          },
        },
      }) as unknown as OpenApiDocument;

    const deltas = parameterDeltas(withPathParam(["old"]), withPathParam(["new"]));

    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.location).toBe("path");
  });

  /**
   * An endpoint that moved or went is already described by a route change or a
   * retirement. Comparing its parameters as well would count the same change
   * twice and, worse, produce a parameter Change scoped to an operation that
   * does not exist.
   */
  it("says nothing about an endpoint that is not in both documents", () => {
    const deltas = parameterDeltas(
      doc({
        "/v1/gone": {
          get: { parameters: [param("status", "query", { enum: ["open"] })] },
        },
      }),
      doc({ "/v1/other": { get: {} } }),
    );

    expect(deltas).toEqual([]);
  });

  it("says nothing when the parameters did not change", () => {
    const same = {
      "/v1/orders": {
        get: { parameters: [param("status", "query", { enum: ["open"] })] },
      },
    };
    expect(parameterDeltas(doc(same), doc(same))).toEqual([]);
  });
});
