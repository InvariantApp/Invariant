/**
 * What old callers are sent, the whole way a release goes: drafted, compiled,
 * applied to the old contract, every decision answered, and compared with
 * the new one by the pinned differ. Each case stayed unexplained on a real
 * API although it was either the same values written another way or a
 * change the IR always had an op for.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RulesJudge } from "@invariant-app/proposer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analysePair } from "./real.ts";

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "response-shapes-"));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

type Schema = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Schema) => ({ content: { "application/json": { schema } } });
const string = { type: "string" };

/** One operation that only answers, with a body. */
function api(response: Schema, schemas: Record<string, Schema>, openapi = "3.0.3") {
  return {
    openapi,
    info: { title: "things", version: "1" },
    paths: {
      "/things": {
        get: {
          operationId: "getThings",
          responses: { "200": { description: "found", ...json(response) } },
        },
      },
    },
    components: { schemas },
  };
}

async function analyse(name: string, before: object, after: object) {
  const fromPath = join(directory, `${name}-before.json`);
  const toPath = join(directory, `${name}-after.json`);
  await writeFile(fromPath, JSON.stringify(before));
  await writeFile(toPath, JSON.stringify(after));
  return analysePair(
    { api: `test:${name}`, fromVersion: "1", toVersion: "2", fromPath, toPath },
    { judge: new RulesJudge(), timeoutMs: 120_000 },
  );
}

describe("a field that became optional inside an object written in place (Supabase)", () => {
  // The custom hostname response holds `data`, written in place, whose error
  // list refers to a named value. That one reference kept everything in
  // `data` from being read, and what may now be missing went unasked.
  const version = (required: string[]) =>
    api(ref("Hostname"), {
      JsonValue: { type: "object" },
      Hostname: {
        type: "object",
        required: ["data"],
        properties: {
          data: {
            type: "object",
            required: ["errors", "result"],
            properties: {
              errors: { type: "array", items: ref("JsonValue") },
              result: {
                type: "object",
                required: ["id", ...required],
                properties: { id: string, custom_origin_server: string },
              },
            },
          },
        },
      },
    });

  it("is asked about, and closes once answered", async () => {
    const result = await analyse(
      "hostname",
      version(["custom_origin_server"]),
      version([]),
    );
    expect(result.compileIssues).toEqual([]);
    expect(result.breakingBefore).toBeGreaterThan(0);
    expect(result.decisions).toBe(1);
    expect(result.breakingAfterDecided).toBe(0);
  });
});

describe("a list body whose items were renamed (Supabase)", () => {
  // An organization's members are a list of `V1OrganizationMemberResponse`,
  // renamed `..._Output` in a later release, where `role_name` may be left
  // out. Only the list names the schema, so nothing matched the two.
  const member = (required: string[]) => ({
    type: "object",
    required: ["user_id", ...required],
    properties: { user_id: string, role_name: string },
  });

  it("is compared as the schema it was, and closes once answered", async () => {
    const result = await analyse(
      "members",
      api({ type: "array", items: ref("Member") }, { Member: member(["role_name"]) }),
      api({ type: "array", items: ref("Member_Output") }, { Member_Output: member([]) }),
    );
    expect(result.compileIssues).toEqual([]);
    expect(result.breakingBefore).toBeGreaterThan(0);
    expect(result.breakingAfterDecided).toBe(0);
  });
});

describe("a choice whose branches were given titles (Langfuse)", () => {
  // Langfuse titled each branch of its prompt. The differ knows a branch
  // written in place by its title, and read two branches gone and two new
  // ones in every response that returns a prompt.
  const kind = (value: string, title?: string) => ({
    type: "object",
    required: ["type", "name"],
    properties: { type: { type: "string", enum: [value] }, name: string },
    ...(title ? { title } : {}),
  });
  const version = (titled: boolean) =>
    api(ref("Prompt"), {
      Prompt: {
        oneOf: [
          kind("chat", titled ? "ChatPrompt" : undefined),
          kind("text", titled ? "TextPrompt" : undefined),
        ],
      },
    });

  it("is restated, and nothing is left", async () => {
    const result = await analyse("titled", version(false), version(true));
    expect(result.compileIssues).toEqual([]);
    expect(result.breakingBefore).toBeGreaterThan(0);
    expect(result.decisions).toBe(0);
    expect(result.breakingAfter).toBe(0);
  });
});

describe("a value that was any value and came to name a choice (Supabase)", () => {
  // The custom hostname's errors were a list of anything, and a later
  // release a list of a named choice between the kinds of JSON value. Old
  // callers were promised any value, so every one of the choice is one.
  const version = (items: Schema, schemas: Record<string, Schema> = {}) =>
    api(ref("Hostname"), {
      ...schemas,
      Hostname: {
        type: "object",
        required: ["errors"],
        properties: { errors: { type: "array", items } },
      },
    });

  it("is restated, and nothing is left", async () => {
    const result = await analyse(
      "any-value",
      version({}),
      version(ref("JsonValue"), {
        JsonValue: { anyOf: [string, { type: "number" }, { type: "object" }] },
      }),
    );
    expect(result.compileIssues).toEqual([]);
    expect(result.breakingBefore).toBeGreaterThan(0);
    expect(result.breakingAfter).toBe(0);
  });
});

describe("an object written in place that came to be named (PayPal)", () => {
  // PayPal's refund wrote its payable breakdown in place, each amount
  // referring to `money`, and a later release named the breakdown. Read on
  // the new side alone, every amount's currency looked newly added.
  const money = {
    type: "object",
    required: ["currency_code", "value"],
    properties: { currency_code: string, value: string },
  };
  const breakdown = { type: "object", properties: { gross_amount: ref("money") } };

  it("drafts nothing where nothing changed", async () => {
    const result = await analyse(
      "breakdown",
      api(ref("refund"), {
        money,
        refund: { type: "object", properties: { breakdown } },
      }),
      api(ref("refund"), {
        money,
        breakdown,
        refund: { type: "object", properties: { breakdown: ref("breakdown") } },
      }),
    );
    expect(result.compileIssues).toEqual([]);
    expect(result.drafts).toBe(0);
    expect(result.breakingAfter).toBe(0);
  });
});

describe("a field that may now be null, written as a union with null (Mistral)", () => {
  // Mistral's library owner went from a `uuid` string to `anyOf` that
  // string or null, in OpenAPI 3.1. Predicted as a list of types, the same
  // meaning read to the differ as the owner's types widening.
  const version = (owner: Schema) =>
    api(
      ref("Library"),
      {
        Library: {
          type: "object",
          required: ["owner_id"],
          properties: { owner_id: owner },
        },
      },
      "3.1.0",
    );

  it("closes once what old callers are shown instead of null is answered", async () => {
    const uuid = { type: "string", format: "uuid" };
    const result = await analyse(
      "owner",
      version(uuid),
      version({ anyOf: [uuid, { type: "null" }] }),
    );
    expect(result.compileIssues).toEqual([]);
    expect(result.breakingBefore).toBeGreaterThan(0);
    expect(result.breakingAfterDecided).toBe(0);
  });
});

describe("a vocabulary that grew inside an optional object (Figma)", () => {
  // Figma's `devStatus` is optional and its `type` required, and gained
  // `COMPLETED`. Answering the fold made `devStatus` always sent in the
  // prediction, which the differ read as it becoming optional again.
  const version = (values: string[]) =>
    api(ref("Node"), {
      Node: {
        type: "object",
        properties: {
          devStatus: {
            type: "object",
            required: ["type"],
            properties: { type: { type: "string", enum: values } },
          },
        },
      },
    });

  it("closes once the fold is answered", async () => {
    const result = await analyse(
      "dev-status",
      version(["NONE", "READY_FOR_DEV"]),
      version(["NONE", "READY_FOR_DEV", "COMPLETED"]),
    );
    expect(result.compileIssues).toEqual([]);
    expect(result.breakingBefore).toBeGreaterThan(0);
    expect(result.decisions).toBe(1);
    expect(result.breakingAfterDecided).toBe(0);
  });
});

describe("a list whose items stopped saying what they are (Twilio)", () => {
  // Twilio's builds listed their asset versions as objects of any shape, and
  // a later release as values of any kind. A list's items were never read
  // unless they named values or a choice, so nothing said so.
  const version = (items: Schema) =>
    api(ref("Build"), {
      Build: {
        type: "object",
        properties: { asset_versions: { type: "array", items, nullable: true } },
      },
    });

  it("is declared, and nothing is left", async () => {
    const result = await analyse(
      "asset-versions",
      version({ type: "object" }),
      version({}),
    );
    expect(result.compileIssues).toEqual([]);
    expect(result.breakingBefore).toBeGreaterThan(0);
    expect(result.decisions).toBe(0);
    expect(result.breakingAfter).toBe(0);
  });
});

describe("a list that became another kind of value (Cloudflare)", () => {
  // Cloudflare's failure responses answered `result` as a list of rules, and
  // later as an object or null. Each rule's fields read as removed from a
  // list that was no longer there, and answering those asked the compiler to
  // walk into items an object does not have.
  const rule = {
    type: "object",
    required: ["id", "mode"],
    properties: { id: string, mode: string, notes: ref("Notes") },
  };

  it("does not ask about what the list's items held", async () => {
    const result = await analyse(
      "result-kind",
      api(
        {
          type: "object",
          required: ["result"],
          properties: { result: { type: "array", items: rule } },
        },
        { Notes: string },
      ),
      api(
        {
          type: "object",
          required: ["result"],
          properties: { result: { type: "object", nullable: true } },
        },
        { Notes: string },
      ),
    );
    expect(result.compileIssues).toEqual([]);
    expect(result.decidedError).toBeUndefined();
  });
});

describe("list items that may now be one of several types (Okta)", () => {
  // Okta's user schema attributes listed an enum's values as text, and a
  // later release as text or whole numbers, in a schema old callers both
  // send and are sent.
  const version = (items: Schema) => ({
    ...api(ref("Attribute"), {
      Attribute: { type: "object", properties: { enum: { type: "array", items } } },
    }),
    paths: {
      "/things": {
        post: {
          operationId: "updateAttribute",
          requestBody: json(ref("Attribute")),
          responses: { "200": { description: "updated", ...json(ref("Attribute")) } },
        },
      },
    },
  });

  it("is declared as the types it may be, and nothing is left", async () => {
    const result = await analyse(
      "enum-types",
      version({ type: "string" }),
      version({ anyOf: [{ type: "string" }, { type: "integer" }] }),
    );
    expect(result.compileIssues).toEqual([]);
    expect(result.breakingBefore).toBeGreaterThan(0);
    expect(result.decisions).toBe(0);
    expect(result.breakingAfter).toBe(0);
  });
});
