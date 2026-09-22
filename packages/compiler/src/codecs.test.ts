/**
 * The value codecs, compiled and run: an instant written another way, an
 * identifier in another case, and a value that became a list of one.
 *
 * Each is checked the way a provider meets it: the new contract predicted
 * from the old one and the Change, a program compiled from both, and real
 * requests and responses through the runtime, including the ones it has to
 * refuse.
 */
import type { OpenApiDocument } from "@invariant-app/contract";
import { type Change, parseChange } from "@invariant-app/ir";
import { createRuntime, TransformError } from "@invariant-app/runtime";
import { describe, expect, it } from "vitest";
import { chainProgram } from "./chain.ts";
import { derive } from "./derive.ts";
import { predictDocument } from "./predict.ts";

function events(side: "old" | "new"): OpenApiDocument {
  const event = { $ref: "#/components/schemas/Event" };
  return {
    openapi: "3.1.0",
    info: { title: "events", version: "1" },
    paths: {
      "/events": {
        post: {
          operationId: "createEvent",
          requestBody: { content: { "application/json": { schema: event } } },
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: event } },
            },
          },
        },
        get: {
          operationId: "listEvents",
          parameters: [
            {
              name: "created_after",
              in: "query",
              schema:
                side === "old"
                  ? { type: "integer" }
                  : { type: "string", format: "date-time" },
            },
            { name: "limit", in: "query", schema: { type: "integer" } },
          ],
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: event } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Event: {
          type: "object",
          properties:
            side === "old"
              ? {
                  created: { type: "integer" },
                  status: { type: "string", enum: ["in_progress", "done"] },
                  email: { type: "string" },
                }
              : {
                  created: { type: "string", format: "date-time" },
                  status: { type: "string", enum: ["IN_PROGRESS", "DONE"] },
                  emails: { type: "array", items: { type: "string" } },
                },
        },
      },
    },
  } as unknown as OpenApiDocument;
}

const before = events("old");
const after = events("new");

const EVENT: Change = parseChange({
  irVersion: 1,
  id: "chg_event_shapes",
  summary: "Times are text, states are shouted, and an event has emails.",
  scopes: [{ schema: "#/components/schemas/Event" }],
  ops: [
    {
      op: "convert",
      path: "/created",
      codec: { kind: "dateFormat", from: "epoch-s", to: "rfc3339" },
    },
    {
      op: "convert",
      path: "/status",
      codec: { kind: "stringCase", from: "snake", to: "screaming" },
    },
    { op: "move", from: "/email", to: "/emails" },
    { op: "convert", path: "/emails", codec: { kind: "wrapArray" } },
  ],
});

const FILTER: Change = parseChange({
  irVersion: 1,
  id: "chg_created_after",
  summary: "The filter takes a time as text.",
  scopes: [{ operation: "listEvents", location: "query" }],
  ops: [
    {
      op: "convert",
      path: "/created_after",
      codec: { kind: "dateFormat", from: "epoch-s", to: "rfc3339" },
    },
  ],
});

function runtimeFor(changes: Change[]) {
  const { program, issues } = chainProgram("events", "v2", "sha256:2", [
    { label: "v2", parent: "v1", from: before, to: after, changes },
  ]);
  expect(issues).toEqual([]);
  return createRuntime({ program, identity: [{ kind: "default", label: "v1" }] });
}

const context = { contract: "v1", operation: "createEvent" };

describe("value codecs, compiled and run", () => {
  it("predict the new contract exactly", () => {
    const prediction = predictDocument(before, after, [EVENT, FILTER]);
    expect(prediction.issues).toEqual([]);
    expect(JSON.stringify(prediction.document)).toBe(JSON.stringify(after));
  });

  it("cost nothing an old caller can see", () => {
    expect(derive(EVENT).runtime).toBe("exact");
  });

  it("carry an old request to the new shape", () => {
    const runtime = runtimeFor([EVENT, FILTER]);
    const site = runtime.siteFor("v1", "post", "/events");
    if (!site) throw new Error("no site");
    const sent = { created: 1700000000, status: "in_progress", email: "a@x.io" };
    expect(
      JSON.parse(runtime.transformRequest(site, JSON.stringify(sent), context)),
    ).toEqual({
      created: "2023-11-14T22:13:20Z",
      status: "IN_PROGRESS",
      emails: ["a@x.io"],
    });
  });

  it("show an old caller the new response in the shape they know", () => {
    const runtime = runtimeFor([EVENT, FILTER]);
    const site = runtime.siteFor("v1", "post", "/events");
    if (!site) throw new Error("no site");
    // An offset names the same instant, so it reaches the old caller as one.
    const answer = {
      created: "2023-11-15T00:13:20+02:00",
      status: "DONE",
      emails: ["a@x.io"],
    };
    expect(
      JSON.parse(runtime.transformResponse(site, 200, JSON.stringify(answer), context)),
    ).toEqual({ created: 1700000000, status: "done", email: "a@x.io" });
  });

  it("refuse a response the old contract cannot express", () => {
    const runtime = runtimeFor([EVENT, FILTER]);
    const site = runtime.siteFor("v1", "post", "/events");
    if (!site) throw new Error("no site");
    const respond = (body: unknown) => () =>
      runtime.transformResponse(site, 200, JSON.stringify(body), context);
    // Two addresses, where the old contract has room for one.
    expect(respond({ emails: ["a@x.io", "b@x.io"] })).toThrow(TransformError);
    // A time within a second, where the old contract counts whole ones.
    expect(respond({ created: "2023-11-14T22:13:20.120Z" })).toThrow(TransformError);
    // A state that is not written in the case the Change says.
    expect(respond({ status: "Done" })).toThrow(TransformError);
  });

  it("rewrite a query parameter and leave the rest of the query alone", () => {
    const runtime = runtimeFor([EVENT, FILTER]);
    const site = runtime.siteFor("v1", "get", "/events");
    if (!site) throw new Error("no site");
    const out = runtime.transformEnvelope(
      site,
      {
        path: "/events",
        search: "limit=5&created_after=1700000000",
        headers: [],
        body: undefined,
      },
      { contract: "v1", operation: "listEvents" },
    );
    const query = new URLSearchParams(out.search);
    expect(query.get("created_after")).toBe("2023-11-14T22:13:20Z");
    expect(out.search.startsWith("limit=5&")).toBe(true);
  });

  it("truncate a time only where the provider declared it, and say what it costs", () => {
    const truncating = parseChange({
      ...EVENT,
      ops: [
        {
          op: "convert",
          path: "/created",
          codec: {
            kind: "dateFormat",
            from: "epoch-s",
            to: "rfc3339",
            onInexact: "truncate",
          },
        },
      ],
    });
    const derived = derive(truncating);
    expect(derived.runtime).toBe("declared-lossy");
    expect(derived.lossy.backward).toContain("/created");
    const { program, issues } = chainProgram("events", "v2", "sha256:2", [
      {
        label: "v2",
        parent: "v1",
        from: before,
        to: predictDocument(before, after, [truncating]).document,
        changes: [truncating],
      },
    ]);
    expect(issues).toEqual([]);
    const runtime = createRuntime({
      program,
      identity: [{ kind: "default", label: "v1" }],
    });
    const site = runtime.siteFor("v1", "post", "/events");
    if (!site) throw new Error("no site");
    const answer = { created: "1969-12-31T23:59:59.500Z" };
    // Toward the earlier second, as the epoch counts, even before 1970.
    expect(
      JSON.parse(runtime.transformResponse(site, 200, JSON.stringify(answer), context)),
    ).toEqual({ created: -1 });
  });

  it("refuse, before anything runs, a listed value the case cannot carry", () => {
    const old = events("old");
    const schema = (
      old["components"] as {
        schemas: Record<string, { properties: Record<string, unknown> }>;
      }
    ).schemas["Event"];
    if (!schema) throw new Error("no Event");
    schema.properties["status"] = { type: "string", enum: ["in_progress", "step_2b"] };
    const change = parseChange({
      ...EVENT,
      ops: [
        {
          op: "convert",
          path: "/status",
          codec: { kind: "stringCase", from: "snake", to: "camel" },
        },
      ],
    });
    const prediction = predictDocument(old, after, [change]);
    expect(prediction.issues.map((issue) => issue.message).join()).toContain("step_2b");
  });

  it("never turn a path parameter into a list", () => {
    const doc = events("old");
    (doc["paths"] as Record<string, unknown>)["/events/{id}"] = {
      get: {
        operationId: "getEvent",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "ok" } },
      },
    };
    const change = parseChange({
      irVersion: 1,
      id: "chg_path_list",
      summary: "An id became a list.",
      scopes: [{ operation: "getEvent", location: "path" }],
      ops: [{ op: "convert", path: "/id", codec: { kind: "wrapArray" } }],
    });
    const prediction = predictDocument(doc, doc, [change]);
    expect(prediction.issues.map((issue) => issue.message).join()).toContain(
      "path parameter can only be converted in place",
    );
  });
});
