/**
 * Schemas whose places cannot be listed, compiled and run.
 *
 * A comment thread whose replies are comments has a comment at every depth.
 * A Change to the comment used to be placed where the site search found one,
 * which stopped at the first: the top comment was translated and every reply
 * went to an old caller in the new shape, without a word. And Stripe, where
 * nearly every object reaches nearly every other through expandable fields
 * that are an id or the object, has more places than can be walked at all.
 *
 * Both are now served by blocks that follow the value to wherever it goes.
 */
import type { OpenApiDocument } from "@invariant/contract";
import { parseChange } from "@invariant/ir";
import { createRuntime } from "@invariant/runtime";
import { describe, expect, it } from "vitest";
import { chainProgram, expandChains } from "./chain.ts";
import { predictDocument } from "./predict.ts";

function thread(body: string): OpenApiDocument {
  const comment = { $ref: "#/components/schemas/Comment" };
  return {
    openapi: "3.1.0",
    info: { title: "threads", version: "1" },
    paths: {
      "/comments": {
        post: {
          operationId: "createComment",
          requestBody: { content: { "application/json": { schema: comment } } },
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { data: { type: "array", items: comment } },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Comment: {
          type: "object",
          // Last, where a move puts a renamed field.
          properties: {
            author: {
              anyOf: [{ type: "string" }, { $ref: "#/components/schemas/User" }],
            },
            replies: { type: "array", items: comment },
            [body]: { type: "string" },
          },
        },
        User: {
          type: "object",
          properties: {
            name: { type: "string" },
            pinned: comment,
          },
        },
      },
    },
  } as unknown as OpenApiDocument;
}

const before = thread("text");
const after = thread("body");
const change = parseChange({
  irVersion: 1,
  id: "chg_comment_body",
  summary: "A comment's text is its body.",
  scopes: [{ schema: "#/components/schemas/Comment" }],
  ops: [{ op: "move", from: "/text", to: "/body" }],
});

function runtimeFor() {
  const { program, issues } = chainProgram("threads", "v2", "sha256:2", [
    { label: "v2", parent: "v1", from: before, to: after, changes: [change] },
  ]);
  expect(issues).toEqual([]);
  const runtime = createRuntime({
    program,
    identity: [{ kind: "default", label: "v1" }],
  });
  const site = runtime.siteFor("v1", "post", "/comments");
  if (!site) throw new Error("no site");
  return {
    program,
    runtime,
    site,
    context: { contract: "v1", operation: "createComment" },
  };
}

describe("a Change to a schema that contains itself", () => {
  it("is predicted as any other", () => {
    const prediction = predictDocument(before, after, [change]);
    expect(prediction.issues).toEqual([]);
    expect(JSON.stringify(prediction.document)).toBe(JSON.stringify(after));
  });

  it("is compiled into blocks the size of the schemas, not of the paths", () => {
    const { program } = runtimeFor();
    // Blocks are shared by every contract; the ones named for a contract's
    // work in a chain are not a schema's.
    const blocks = expandChains(program).blocks ?? {};
    expect(Object.keys(blocks).sort()).toEqual([
      "v2:Comment:in",
      "v2:Comment:out",
      "v2:User:in",
      "v2:User:out",
    ]);
  });

  it("translates every reply, however deep, on the way in", () => {
    const { runtime, site, context } = runtimeFor();
    const sent = {
      text: "top",
      replies: [{ text: "a", replies: [{ text: "a1", replies: [] }] }, { text: "b" }],
    };
    expect(
      JSON.parse(runtime.transformRequest(site, JSON.stringify(sent), context)),
    ).toEqual({
      body: "top",
      replies: [{ body: "a", replies: [{ body: "a1", replies: [] }] }, { body: "b" }],
    });
  });

  it("and back, through an expandable author that is an id in one place and the object in another", () => {
    const { runtime, site, context } = runtimeFor();
    const answer = {
      data: [
        {
          body: "top",
          author: "usr_1",
          replies: [
            {
              body: "reply",
              author: { name: "Ada", pinned: { body: "pinned", replies: [] } },
            },
          ],
        },
      ],
    };
    expect(
      JSON.parse(runtime.transformResponse(site, 200, JSON.stringify(answer), context)),
    ).toEqual({
      data: [
        {
          text: "top",
          author: "usr_1",
          replies: [
            {
              text: "reply",
              author: { name: "Ada", pinned: { text: "pinned", replies: [] } },
            },
          ],
        },
      ],
    });
  });
});
