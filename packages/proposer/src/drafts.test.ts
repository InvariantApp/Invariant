/**
 * Drafts that need no decision, because no value has to be invented.
 *
 * Each case is one that stayed unexplained across the real corpus although
 * nothing about it was a judgement: a field added to a schema that only ever
 * appears in responses, a field removed from one that only ever appears in
 * requests with nothing added in its place, and an operation renamed where it
 * stood. Anything else still goes to a person.
 */
import type { OpenApiDocument } from "@invariant/contract";
import { describe, expect, it } from "vitest";
import { decisionChange } from "./decisions.ts";
import { propose } from "./propose.ts";
import { RulesJudge } from "./rules.ts";
import { CHOOSE_ONE } from "./vocabulary.ts";

type Schema = Record<string, unknown>;

function contract(
  schemas: Record<string, Schema>,
  operationIds = { get: "getThing", post: "createThing" },
) {
  const body = (name: string) => ({
    content: { "application/json": { schema: { $ref: `#/components/schemas/${name}` } } },
  });
  return {
    openapi: "3.0.3",
    info: { title: "t", version: "1" },
    paths: {
      "/things": {
        post: {
          operationId: operationIds.post,
          requestBody: body("ThingCreate"),
          responses: { "201": { description: "made", ...body("Shared") } },
        },
      },
      "/things/{id}": {
        get: {
          operationId: operationIds.get,
          responses: { "200": { description: "one", ...body("Thing") } },
        },
      },
    },
    components: { schemas },
  } as unknown as OpenApiDocument;
}

const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
});

const base = {
  Webhook: object({ id: { type: "string" } }),
  Thing: object({ id: { type: "string" } }, ["id"]),
  ThingCreate: object({ name: { type: "string" }, legacy: { type: "string" } }),
  Shared: object({ id: { type: "string" } }, ["id"]),
};

async function drafts(
  after: Record<string, Schema>,
  ids?: { get: string; post: string },
) {
  return propose(contract(base), contract({ ...base, ...after }, ids), {
    judge: new RulesJudge(),
  });
}

describe("a new required field", () => {
  it("is taken out of old callers' responses where the schema is only ever a response", async () => {
    const outcome = await drafts({
      Thing: object({ id: { type: "string" }, region: { type: "string" } }, [
        "id",
        "region",
      ]),
    });
    const change = outcome.proposals.find((proposal) =>
      proposal.change.id.includes("region"),
    );
    expect(change?.change.ops).toEqual([{ op: "add", path: "/region", value: null }]);
    expect(change?.change.scopes).toEqual([{ schema: "#/components/schemas/Thing" }]);
  });

  it("is given the specification's default where old callers send the schema", async () => {
    const outcome = await drafts({
      ThingCreate: object(
        {
          name: { type: "string" },
          legacy: { type: "string" },
          tier: { type: "string", default: "basic" },
        },
        ["tier"],
      ),
    });
    const change = outcome.proposals.find((proposal) =>
      proposal.change.id.includes("tier"),
    );
    expect(change?.change.ops).toEqual([{ op: "add", path: "/tier", value: "basic" }]);
  });

  it("is left to a person where a value would have to be invented", async () => {
    const outcome = await drafts({
      ThingCreate: object(
        {
          name: { type: "string" },
          legacy: { type: "string" },
          tier: { type: "string" },
        },
        ["tier"],
      ),
    });
    expect(
      outcome.proposals.some((proposal) => proposal.change.id.includes("tier")),
    ).toBe(false);
    // Asked as a decision with the Change drafted around the answer.
    const decision = outcome.decisions.find((entry) => entry.field === "tier");
    expect(decision).toMatchObject({ kind: "value", op: { op: "add" } });
    expect(decision && decisionChange(decision).ops).toEqual([
      { op: "add", path: "/tier", value: CHOOSE_ONE },
    ]);
  });
});

describe("a removed field with nothing added in its place", () => {
  it("is dropped from old callers' requests where the schema is only ever a request", async () => {
    const outcome = await drafts({ ThingCreate: object({ name: { type: "string" } }) });
    const change = outcome.proposals.find((proposal) =>
      proposal.change.id.includes("legacy"),
    );
    expect(change?.change.ops).toEqual([
      { op: "remove", path: "/legacy", restore: null },
    ]);
  });

  it("is left to a person where old callers were always given it", async () => {
    const outcome = await drafts({ Thing: object({}) });
    expect(
      outcome.proposals.some((proposal) => proposal.change.id.includes("thing_id")),
    ).toBe(false);
    const decision = outcome.decisions.find((entry) => entry.field === "id");
    expect(decision && decisionChange(decision).ops).toEqual([
      { op: "remove", path: "/id", restore: CHOOSE_ONE },
    ]);
  });
});

describe("an operation renamed where it stood", () => {
  it("is recorded as a route with the new operationId", async () => {
    const outcome = await drafts({}, { get: "retrieveThing", post: "createThing" });
    const change = outcome.proposals.find((proposal) =>
      proposal.change.ops.some((op) => op.op === "route"),
    );
    expect(change?.change.ops).toEqual([
      {
        op: "route",
        from: { method: "get", path: "/things/{id}" },
        to: { method: "get", path: "/things/{id}" },
        operationId: { from: "getThing", to: "retrieveThing" },
      },
    ]);
  });
});

describe("a whole API moved to a new prefix", () => {
  it("records each operation's renamed id on its route", async () => {
    const versioned = (version: string) =>
      ({
        openapi: "3.0.3",
        info: { title: "t", version },
        paths: Object.fromEntries(
          ["distribution", "invalidation", "origin"].map((name) => [
            `/${version}/${name}`,
            {
              get: {
                operationId: `Get${name}${version.replaceAll("-", "_")}`,
                responses: { "200": { description: "ok" } },
              },
            },
          ]),
        ),
      }) as unknown as OpenApiDocument;
    // How AWS CloudFront versions: the path and the operation id both carry it.
    const outcome = await propose(versioned("2016-11-25"), versioned("2017-03-25"), {
      judge: new RulesJudge(),
    });
    const routes = outcome.proposals.flatMap((proposal) =>
      proposal.change.ops.filter((op) => op.op === "route"),
    );
    expect(routes).toContainEqual({
      op: "route",
      from: { method: "get", path: "/2016-11-25/distribution" },
      to: { method: "get", path: "/2017-03-25/distribution" },
      operationId: { from: "Getdistribution2016_11_25", to: "Getdistribution2017_03_25" },
    });
  });
});

describe("a whole API moved under a prefix it did not have, or out of one", () => {
  const paths = (prefix: string) =>
    ({
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      paths: Object.fromEntries(
        ["meshes", "routes", "nodes"].map((name) => [
          `${prefix}/${name}`,
          {
            get: {
              operationId: `List${name}`,
              responses: { "200": { description: "ok" } },
            },
          },
        ]),
      ),
    }) as unknown as OpenApiDocument;
  const routes = async (before: string, after: string) =>
    (
      await propose(paths(before), paths(after), { judge: new RulesJudge() })
    ).proposals.flatMap((proposal) =>
      proposal.change.ops.filter((op) => op.op === "route"),
    );

  it("routes every endpoint under the new prefix, as AWS App Mesh versioned", async () => {
    expect(await routes("", "/v20190125")).toContainEqual({
      op: "route",
      from: { method: "get", path: "/meshes" },
      to: { method: "get", path: "/v20190125/meshes" },
    });
  });

  it("routes every endpoint out from under a prefix that was dropped", async () => {
    expect(await routes("/v1", "")).toContainEqual({
      op: "route",
      from: { method: "get", path: "/v1/meshes" },
      to: { method: "get", path: "/meshes" },
    });
  });
});

describe("nested fields", () => {
  const nestedBase = {
    ...base,
    ThingCreate: object({
      name: { type: "string" },
      shipping: object({ city: { type: "string" }, legacy_code: { type: "string" } }),
      lines: {
        type: "array",
        items: object({ sku: { type: "string" }, price: { type: "number" } }),
      },
    }),
  };
  const nested = async (after: Record<string, Schema>) =>
    propose(contract(nestedBase), contract({ ...nestedBase, ...after }), {
      judge: new RulesJudge(),
    });

  it("are followed into inline objects and lists", async () => {
    const outcome = await nested({
      ThingCreate: object({
        name: { type: "string" },
        shipping: object({ city: { type: "string" } }),
        lines: {
          type: "array",
          items: object({ sku: { type: "string" }, price: { type: "number" } }),
        },
      }),
    });
    const change = outcome.proposals.find((proposal) =>
      proposal.change.ops.some((op) => op.op === "remove"),
    );
    expect(change?.change.ops).toEqual([
      { op: "remove", path: "/shipping/legacy_code", restore: null },
    ]);
  });

  it("are renamed where they sit, inside a list's items too", async () => {
    const outcome = await nested({
      ThingCreate: object({
        name: { type: "string" },
        shipping: object({ city: { type: "string" }, legacy_code: { type: "string" } }),
        lines: {
          type: "array",
          items: object({ sku: { type: "string" }, price_cents: { type: "integer" } }),
        },
      }),
    });
    const moves = outcome.proposals.flatMap((proposal) =>
      proposal.change.ops.filter((op) => op.op === "move"),
    );
    expect(moves).toContainEqual({
      op: "move",
      from: "/lines/*/price",
      to: "/lines/*/price_cents",
    });
  });

  it("are not followed into another named schema, which is compared as itself", async () => {
    const withRef = {
      ...base,
      Address: object({ city: { type: "string" }, zip: { type: "string" } }),
      Thing: object(
        { id: { type: "string" }, address: { $ref: "#/components/schemas/Address" } },
        ["id"],
      ),
    };
    const outcome = await propose(
      contract(withRef),
      contract({ ...withRef, Address: object({ city: { type: "string" } }) }),
      { judge: new RulesJudge() },
    );
    // Only Address speaks for its own fields; Thing never reaches into it.
    expect(
      outcome.unresolved
        .filter((entry) => entry.field.includes("zip"))
        .map((e) => e.schema),
    ).not.toContain("Thing");
  });
});

describe("a schema no operation uses", () => {
  it("gets no drafts, since the gate reports nothing for it", async () => {
    // Plaid documents its webhook payloads as schemas nothing refers to.
    const outcome = await drafts({
      Webhook: object({ environment: { type: "string" } }, ["environment"]),
    });
    expect(
      outcome.proposals.some((proposal) => proposal.change.id.includes("webhook")),
    ).toBe(false);
    expect(outcome.unresolved.some((entry) => entry.schema === "Webhook")).toBe(false);
  });
});

describe("a field that may now be left out or null, or no longer may", () => {
  const ops = async (after: Record<string, Schema>) =>
    (await drafts(after)).proposals.flatMap((proposal) => proposal.change.ops);

  it("sends old callers a now-nullable optional response field left out", async () => {
    const before = {
      ...base,
      Thing: object({ id: { type: "string" }, note: { type: "string" } }, ["id"]),
    };
    const outcome = await propose(
      contract(before),
      contract({
        ...before,
        Thing: object(
          { id: { type: "string" }, note: { type: "string", nullable: true } },
          ["id"],
        ),
      }),
      { judge: new RulesJudge() },
    );
    expect(outcome.proposals.flatMap((proposal) => proposal.change.ops)).toEqual([
      { op: "dropNull", path: "/note", toward: "old" },
    ]);
  });

  it("gives old callers the declared default where a response field became optional", async () => {
    expect(
      await ops({
        Thing: object({ id: { type: "string", default: "unknown" } }, []),
      }),
    ).toEqual([
      { op: "default", path: "/id", value: "unknown", when: "absent", toward: "old" },
    ]);
  });

  it("leaves it to a person where a response field became optional with no default", async () => {
    const outcome = await drafts({ Thing: object({ id: { type: "string" } }, []) });
    const decision = outcome.decisions.find((entry) => entry.field === "id");
    expect(decision && decisionChange(decision).ops).toEqual([
      { op: "default", path: "/id", value: CHOOSE_ONE, when: "absent", toward: "old" },
    ]);
  });

  it("gives old callers' requests the default where a field became required", async () => {
    expect(
      await ops({
        ThingCreate: object(
          { name: { type: "string", default: "unnamed" }, legacy: { type: "string" } },
          ["name"],
        ),
      }),
    ).toEqual([
      { op: "default", path: "/name", value: "unnamed", when: "absent", toward: "new" },
    ]);
  });

  it("drops a null from old callers' requests where an optional field stopped being nullable", async () => {
    const before = {
      ...base,
      ThingCreate: object({ name: { type: "string", nullable: true } }),
    };
    const outcome = await propose(
      contract(before),
      contract({ ...before, ThingCreate: object({ name: { type: "string" } }) }),
      { judge: new RulesJudge() },
    );
    expect(outcome.proposals.flatMap((proposal) => proposal.change.ops)).toEqual([
      { op: "dropNull", path: "/name", toward: "new" },
    ]);
  });

  it("records a request field that now accepts null, with nothing to translate", async () => {
    expect(
      await ops({
        ThingCreate: object(
          { name: { type: "string", nullable: true }, legacy: { type: "string" } },
          ["name"],
        ),
      }),
    ).toEqual([{ op: "dropNull", path: "/name", toward: "old" }]);
  });

  it("drafts nothing where the change hurts no old caller", async () => {
    // A request field that became optional: old callers always send it.
    const before = {
      ...base,
      ThingCreate: object({ name: { type: "string" }, legacy: { type: "string" } }, [
        "name",
      ]),
    };
    const outcome = await propose(
      contract(before),
      contract({ ...before, ThingCreate: base.ThingCreate }),
      {
        judge: new RulesJudge(),
      },
    );
    expect(outcome.proposals).toEqual([]);
    expect(outcome.unresolved).toEqual([]);
  });
});

describe("an operation that kept its path and changed its method", () => {
  it("is routed, and its query parameters follow into the new body", async () => {
    const search = (method: string, operation: Record<string, unknown>) =>
      ({
        openapi: "3.0.3",
        info: { title: "t", version: "1" },
        paths: { "/search": { [method]: { operationId: "search", ...operation } } },
      }) as unknown as OpenApiDocument;
    const outcome = await propose(
      search("get", {
        parameters: [
          { name: "q", in: "query", required: true, schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer" } },
        ],
        responses: { "200": { description: "ok" } },
      }),
      search("post", {
        parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", properties: { q: { type: "string" } } },
            },
          },
        },
        responses: { "200": { description: "ok" } },
      }),
      { judge: new RulesJudge() },
    );
    const ops = outcome.proposals.flatMap((proposal) => proposal.change.ops);
    expect(ops).toContainEqual({
      op: "route",
      from: { method: "get", path: "/search" },
      to: { method: "post", path: "/search" },
    });
    expect(ops).toContainEqual({ op: "move", from: "/q", to: "/@body/q" });
    // Not reported as retired as well.
    expect(ops.some((op) => op.op === "retire")).toBe(false);
  });
});

describe("a value that went and one that arrived", () => {
  it("is paired, and put in front of a person rather than assumed", async () => {
    // Adyen dropped `alma` and added `wero` in one release: two different
    // payment methods, which only a person can tell from a rename.
    const vocabulary = (values: string[]) =>
      object({ type: { type: "string", enum: values } }, ["type"]);
    const before = await propose(
      contract({ ...base, Thing: vocabulary(["alma", "card"]) }),
      contract({ ...base, Thing: vocabulary(["wero", "card"]) }),
      { judge: new RulesJudge() },
    );
    const renamed = before.proposals.find((proposal) =>
      proposal.change.ops.some((op) => op.op === "convert"),
    );
    expect(renamed?.attention).toBe("explicit");
    expect(renamed?.confidence).toBeLessThan(1);
    expect(renamed?.notes.join(" ")).toContain("confirm");
  });
});
