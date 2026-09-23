/**
 * A schema that says the same values another way, the whole way a release
 * goes: drafted, compiled, applied to the old contract and compared with the
 * new one by the pinned differ. The drafting and the proof have their own
 * tests; this is the claim a provider relies on, that what was drafted leaves
 * nothing unexplained, and that nothing is drafted where the values changed.
 *
 * Figma rewrote a node's `Effect` from one object into a choice between its
 * kinds, and sixty-odd places stayed unexplained with no op that could say
 * nothing had changed for an old caller.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RulesJudge } from "@invariant-app/proposer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analysePair } from "./real.ts";

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "restated-"));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const number = { type: "number" };

/** One operation answering with a node, whose effects are shaped as given. */
function nodes(schemas: Record<string, unknown>) {
  return {
    openapi: "3.0.3",
    info: { title: "nodes", version: "1" },
    paths: {
      "/nodes/{id}": {
        get: {
          operationId: "getNode",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "the node",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Node" } },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Node: {
          type: "object",
          required: ["id", "effects"],
          properties: {
            id: { type: "string" },
            effects: { type: "array", items: { $ref: "#/components/schemas/Effect" } },
          },
        },
        ...schemas,
      },
    },
  };
}

const oneEffect = {
  Effect: {
    type: "object",
    required: ["type", "radius"],
    properties: {
      type: { type: "string", enum: ["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR"] },
      radius: number,
      offset: number,
    },
  },
};

const effectKinds = (kinds: string[]) => ({
  Effect: {
    oneOf: kinds.map((kind) => ({ $ref: `#/components/schemas/${kind}Effect` })),
    discriminator: { propertyName: "type" },
  },
  ...Object.fromEntries(
    kinds.map((kind) => [
      `${kind}Effect`,
      {
        type: "object",
        required: ["type", "radius"],
        properties: {
          type: { type: "string", enum: [kind] },
          radius: number,
          offset: number,
        },
      },
    ]),
  ),
});

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

describe("a schema stated as a choice of its kinds, end to end", () => {
  it("leaves nothing unexplained where every kind was already allowed", async () => {
    const result = await analyse(
      "kinds",
      nodes(oneEffect),
      nodes(effectKinds(["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR"])),
    );
    expect(result.reached).toBe("done");
    expect(result.compileIssues).toEqual([]);
    // There was something to explain, and all of it is explained.
    expect(result.breakingBefore).toBeGreaterThan(0);
    expect(result.breakingAfter).toBe(0);
  });

  it("drafts no restatement where a kind is new to old callers", async () => {
    const result = await analyse(
      "new-kind",
      nodes(oneEffect),
      nodes(effectKinds(["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR", "GLOW"])),
    );
    expect(result.reached).toBe("done");
    expect(result.compileIssues).toEqual([]);
    expect(result.breakingAfter).toBeGreaterThan(0);
  });
});
