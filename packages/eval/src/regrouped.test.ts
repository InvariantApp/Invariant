/**
 * Fields that moved through a wrapper, the whole way a release goes: drafted,
 * compiled, applied to the old contract and compared with the new one by the
 * pinned differ. The drafting has its own tests; this is the claim a provider
 * relies on, that what was drafted leaves nothing unexplained.
 *
 * Datadog flattened a custom rule's revision, which had held its fields in an
 * `attributes` object, and one release left forty-odd places unexplained
 * because each field read as removed in one place and unrelated in another.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RulesJudge } from "@invariant-app/proposer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analysePair } from "./real.ts";

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "regrouped-"));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const string = { type: "string" };

/** One operation answering with a rule, whose revision is shaped as given. */
function rules(revision: Record<string, unknown>) {
  return {
    openapi: "3.0.3",
    info: { title: "rules", version: "1" },
    paths: {
      "/rules/{id}": {
        get: {
          operationId: "getRule",
          parameters: [{ name: "id", in: "path", required: true, schema: string }],
          responses: {
            "200": {
              description: "the rule",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Rule" } },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Rule: {
          type: "object",
          required: ["id", "revision"],
          properties: { id: string, revision },
        },
      },
    },
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

describe("fields that moved through a wrapper, end to end", () => {
  it("leaves nothing unexplained where a wrapper was dissolved", async () => {
    const fields = { code: string, name: string, language: string };
    const result = await analyse(
      "hoisted",
      rules({
        type: "object",
        required: ["attributes"],
        properties: {
          attributes: {
            type: "object",
            required: ["code", "name", "language"],
            properties: fields,
          },
        },
      }),
      rules({
        type: "object",
        required: ["code", "name", "language"],
        properties: fields,
      }),
    );
    expect(result.reached).toBe("done");
    expect(result.compileIssues).toEqual([]);
    // There was something to explain, and all of it is explained.
    expect(result.breakingBefore).toBeGreaterThan(0);
    expect(result.breakingAfter).toBe(0);
  });

  it("leaves nothing unexplained where a wrapper was introduced", async () => {
    const fields = { amount: { type: "integer" }, currency: string };
    const result = await analyse(
      "nested",
      rules({
        type: "object",
        required: ["amount", "currency"],
        properties: fields,
      }),
      rules({
        type: "object",
        required: ["price"],
        properties: {
          price: { type: "object", required: ["amount", "currency"], properties: fields },
        },
      }),
    );
    expect(result.reached).toBe("done");
    expect(result.compileIssues).toEqual([]);
    expect(result.breakingBefore).toBeGreaterThan(0);
    expect(result.breakingAfter).toBe(0);
  });
});
