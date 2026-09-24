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
import type { OpenApiDocument } from "@invariant-app/contract";
import { CHOOSE_ONE } from "@invariant-app/ir";
import { describe, expect, it } from "vitest";
import { decisionChange } from "./decisions.ts";
import {
  type ParameterDelta,
  parameterDeltas,
  parameterDrafts,
  retireChange,
  retiredEndpoints,
  statusChanges,
} from "./endpoints.ts";

const parameterChanges = (deltas: ParameterDelta[]) =>
  parameterDrafts(deltas).drafts.map((draft) => draft.change);

interface Op {
  parameters?: unknown[];
  responses?: Record<string, unknown>;
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

describe("parameter drafts that need no decision", () => {
  const list = (parameters: unknown[]) => doc({ "/v1/orders": { get: { parameters } } });
  const drafted = (before: unknown[], after: unknown[]) =>
    parameterDrafts(parameterDeltas(list(before), list(after)));
  const opsOf = (result: ReturnType<typeof drafted>) =>
    result.drafts.flatMap((draft) => draft.change.ops);

  it("drops a parameter that went, from old callers' requests", () => {
    expect(
      opsOf(
        drafted([param("debug", "query"), param("q", "query")], [param("q", "query")]),
      ),
    ).toEqual([{ op: "remove", path: "/debug", restore: null }]);
  });

  it("moves the only parameter that went to the only one that arrived, for a reviewer to confirm", () => {
    const result = drafted([param("limit", "query")], [param("page_size", "query")]);
    expect(opsOf(result)).toEqual([{ op: "move", from: "/limit", to: "/page_size" }]);
    expect(result.drafts[0]?.attention).toBe("explicit");
  });

  it("moves a parameter to another location when it arrives there under the same name", () => {
    expect(
      opsOf(drafted([param("api-version", "query")], [param("Api-Version", "header")])),
    ).toEqual([{ op: "move", from: "/api-version", to: "/@header/api-version" }]);
  });

  it("gives a newly required parameter its declared default, and asks where there is none", () => {
    const withDefault = drafted(
      [],
      [{ ...param("tier", "query", { default: "basic" }), required: true }],
    );
    expect(opsOf(withDefault)).toEqual([{ op: "add", path: "/tier", value: "basic" }]);
    const without = drafted([], [{ ...param("tier", "query"), required: true }]);
    expect(opsOf(without)).toEqual([]);
    expect(without.questions).toEqual([]);
    // Asked as the decision a new required body field is, the op written
    // around the answer.
    expect(without.decisions.map(decisionChange)).toEqual([
      {
        irVersion: 1,
        id: "chg_param_get_v1_orders_tier_add",
        summary: "The `tier` query parameter of get_v1_orders is new and required.",
        scopes: [{ operation: "get_v1_orders", location: "query" }],
        ops: [{ op: "add", path: "/tier", value: CHOOSE_ONE }],
      },
    ]);
  });

  it("asks what old callers send for a parameter that became required (Asana's `workspace`)", () => {
    const result = drafted(
      [param("workspace", "query")],
      [{ ...param("workspace", "query"), required: true }],
    );
    expect(opsOf(result)).toEqual([]);
    expect(result.questions).toEqual([]);
    expect(result.decisions.map(decisionChange)).toEqual([
      {
        irVersion: 1,
        id: "chg_param_get_v1_orders_workspace_default_new",
        summary: "The `workspace` query parameter of get_v1_orders is now required.",
        scopes: [{ operation: "get_v1_orders", location: "query" }],
        ops: [
          {
            op: "default",
            path: "/workspace",
            when: "absent",
            toward: "new",
            value: CHOOSE_ONE,
          },
        ],
      },
    ]);
  });

  it("asks which accepted value each that went is sent as (Sentry's release `sort`)", () => {
    const sort = (values: string[]) => param("sort", "query", { enum: values });
    const result = drafted(
      [sort(["date", "sessions", "users", "crash_free_users"])],
      [sort(["date", "crash_free_sessions"])],
    );
    expect(opsOf(result)).toEqual([]);
    expect(result.questions).toEqual([]);
    const [decision] = result.decisions;
    expect(decision).toMatchObject({
      kind: "vocabulary",
      direction: "request",
      lost: ["sessions", "users", "crash_free_users"],
      gained: ["crash_free_sessions"],
      choices: ["date", "crash_free_sessions"],
      suggested: {
        fold: [],
        pairs: [
          ["sessions", "crash_free_sessions"],
          ["users", CHOOSE_ONE],
          ["crash_free_users", "crash_free_sessions"],
        ],
      },
    });
    expect(result.decisions.map(decisionChange)).toEqual([
      {
        irVersion: 1,
        id: "chg_get_v1_orders_query_parameters_sort_vocabulary",
        summary:
          "`sort` on get_v1_orders query parameters no longer accepts values old callers may send.",
        scopes: [{ operation: "get_v1_orders", location: "query" }],
        ops: [
          {
            op: "convert",
            path: "/sort",
            codec: {
              kind: "enumMap",
              pairs: [
                ["date", "date"],
                ["sessions", CHOOSE_ONE],
                ["users", CHOOSE_ONE],
                ["crash_free_users", CHOOSE_ONE],
              ],
            },
          },
        ],
      },
    ]);
  });

  it("still asks a person where more than the values changed", () => {
    const status = (values: string[], type: string) =>
      param("status", "query", { enum: values, type });
    const result = drafted(
      [status(["open", "closed"], "string")],
      [status(["open"], "integer")],
    );
    expect(result.decisions).toEqual([]);
    expect(result.questions.map((question) => question.field)).toEqual(["status"]);
  });

  it("leaves out of a list what it no longer accepts, and asks where others arrived (Asana)", () => {
    const fields = (values: string[]) => ({
      name: "opt_fields",
      in: "query",
      schema: { type: "array", items: { type: "string", enum: values } },
    });
    const result = drafted(
      [fields(["name", "color", "owner", "archived"])],
      [fields(["name", "owner"])],
    );
    expect(opsOf(result)).toEqual([
      {
        op: "convert",
        path: "/opt_fields",
        codec: { kind: "dropValues", values: ["color", "archived"] },
      },
    ]);
    // A value that went beside one that arrived may be the same one renamed.
    const renamed = drafted([fields(["name", "colour"])], [fields(["name", "color"])]);
    expect(opsOf(renamed)).toEqual([]);
    expect(renamed.questions.map((question) => question.field)).toEqual(["opt_fields"]);
  });

  it("casts a parameter whose type changed, and supplies a default where one became required", () => {
    const result = drafted(
      [{ name: "limit", in: "query", schema: { type: "string" } }],
      [
        {
          name: "limit",
          in: "query",
          required: true,
          schema: { type: "integer", default: 20 },
        },
      ],
    );
    expect(opsOf(result)).toEqual([
      {
        op: "convert",
        path: "/limit",
        codec: { kind: "cast", from: "string", to: "integer" },
      },
      { op: "default", path: "/limit", value: 20, when: "absent", toward: "new" },
    ]);
  });

  it("re-encodes a time filter that became date-time text, and a value that became a list", () => {
    const result = drafted(
      [
        { name: "created_after", in: "query", schema: { type: "integer" } },
        { name: "tag", in: "query", schema: { type: "string" } },
      ],
      [
        {
          name: "created_after",
          in: "query",
          schema: { type: "string", format: "date-time" },
        },
        {
          name: "tag",
          in: "query",
          schema: { type: "array", items: { type: "string" } },
        },
      ],
    );
    expect(opsOf(result)).toEqual([
      {
        op: "convert",
        path: "/created_after",
        codec: { kind: "dateFormat", from: "epoch-s", to: "rfc3339" },
      },
      { op: "convert", path: "/tag", codec: { kind: "wrapArray" } },
    ]);
  });

  it("restates a parameter that states a format its bounds already kept (Twilio)", () => {
    // Twilio stated `int64` on a `PageSize` it had always bounded to 1000.
    const pageSize = (extra: Record<string, unknown>) => ({
      name: "PageSize",
      in: "query",
      schema: { type: "integer", minimum: 1, maximum: 1000, ...extra },
    });
    expect(opsOf(drafted([pageSize({})], [pageSize({ format: "int64" })]))).toEqual([
      { op: "restate", path: "/PageSize" },
    ]);
    // Unbounded, an old caller may send what no int64 holds, which nothing
    // here can hide.
    const unbounded = (extra: Record<string, unknown>) => ({
      name: "memory",
      in: "query",
      schema: { type: "integer", ...extra },
    });
    expect(opsOf(drafted([unbounded({})], [unbounded({ format: "int64" })]))).toEqual([]);
    // Nor is a format this cannot check, as Okta's "Opaque token".
    expect(
      opsOf(
        drafted(
          [param("after", "query")],
          [param("after", "query", { format: "Opaque token" })],
        ),
      ),
    ).toEqual([]);
  });

  it("drops a null an old caller sends where the parameter can no longer be null", () => {
    expect(
      opsOf(
        drafted(
          [{ name: "cursor", in: "query", schema: { type: "string", nullable: true } }],
          [param("cursor", "query")],
        ),
      ),
    ).toEqual([{ op: "dropNull", path: "/cursor", toward: "new" }]);
  });
});

describe("a success status that changed", () => {
  const body = { "application/json": { schema: { type: "object" } } };
  const answering = (responses: Record<string, unknown>) =>
    doc({ "/albums/{id}": { delete: { responses } } });
  const drafted = (before: Record<string, unknown>, after: Record<string, unknown>) =>
    statusChanges(answering(before), answering(after)).map((change) => change.ops);

  it("is drafted where the new document added the one status that replaced it", () => {
    // Immich 1.138 answers 204 where 1.137 answered 200 with nothing.
    expect(
      drafted({ "200": { description: "ok" } }, { "204": { description: "done" } }),
    ).toEqual([
      [
        {
          op: "status",
          endpoint: { method: "delete", path: "/albums/{id}" },
          from: "200",
          to: "204",
        },
      ],
    ]);
  });

  it("is drafted where one status went and one is left", () => {
    // Gitea 1.24 listed 201 and 204 and answered 204; 1.25 lists 201 alone.
    expect(
      drafted(
        { "201": { description: "created" }, "204": { description: "created" } },
        { "201": { description: "created" } },
      ).map((ops) => ops.map((op) => ("from" in op ? [op.from, op.to] : []))),
    ).toEqual([[["204", "201"]]]);
  });

  it("is not drafted where the old status promised a body the new one does not carry", () => {
    expect(
      drafted(
        { "200": { description: "ok", content: body } },
        { "204": { description: "done" } },
      ),
    ).toEqual([]);
  });

  it("is not drafted where the documents do not say which status replaced it", () => {
    expect(
      drafted(
        { "200": { description: "ok" } },
        { "201": { description: "created" }, "202": { description: "accepted" } },
      ),
    ).toEqual([]);
    expect(
      drafted({ "200": { description: "ok" } }, { "200": { description: "ok" } }),
    ).toEqual([]);
  });
});
