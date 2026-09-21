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
import { propose } from "./propose.ts";
import { RulesJudge } from "./rules.ts";

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
    expect(outcome.unresolved.map((entry) => entry.field)).toContain("tier");
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
    expect(outcome.unresolved.map((entry) => entry.field)).toContain("id");
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
