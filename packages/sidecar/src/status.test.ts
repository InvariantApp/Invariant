/**
 * A success status that changed, served end to end.
 *
 * Gitea 1.25 answers the creation of an Actions variable `201 Created` where
 * 1.24 answered `204 No Content`, and Gitea's own SDK checks for 204. The
 * Change the proposer drafts for it compiled, and an old caller through the
 * proxy was answered 204 with nothing, while a current caller was answered
 * the provider's 201 as it came.
 */
import { chainProgram, derive, predictDocument } from "@invariant-app/compiler";
import type { OpenApiDocument } from "@invariant-app/contract";
import { statusChanges } from "@invariant-app/proposer";
import { createRuntime } from "@invariant-app/runtime";
import { describe, expect, it } from "vitest";
import { createProxy } from "./proxy.ts";

const doc = (responses: Record<string, unknown>): OpenApiDocument =>
  ({
    openapi: "3.0.3",
    info: { title: "gitea", version: "1" },
    paths: {
      "/user/actions/variables/{variablename}": {
        post: {
          operationId: "createUserVariable",
          parameters: [
            {
              name: "variablename",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: { ...responses, "400": { description: "bad" } },
        },
      },
    },
  }) as unknown as OpenApiDocument;

// 1.24 listed both and answered 204; 1.25 lists and answers 201.
const before = doc({
  "201": { description: "created" },
  "204": { description: "created" },
});
const after = doc({ "201": { description: "created" } });

describe("a success status that changed (Gitea)", () => {
  const changes = statusChanges(before, after);

  it("is drafted from the two documents, predicts the new one, and is exact", () => {
    expect(changes.map((change) => change.ops)).toEqual([
      [
        {
          op: "status",
          endpoint: { method: "post", path: "/user/actions/variables/{variablename}" },
          from: "204",
          to: "201",
        },
      ],
    ]);
    expect(predictDocument(before, after, changes).issues).toEqual([]);
    expect(changes.map((change) => derive(change).runtime)).toEqual(["exact"]);
  });

  it("answers an old caller 204 with nothing, and a current one as the provider did", async () => {
    const { program, issues } = chainProgram("gitea", "v1.25", "sha256:2", [
      { label: "v1.25", parent: "v1.24", from: before, to: after, changes },
    ]);
    expect(issues).toEqual([]);

    const proxy = createProxy({
      runtime: createRuntime({
        program,
        identity: [
          { kind: "header", name: "gitea-version" },
          { kind: "default", label: "v1.25" },
        ],
      }),
      upstream: "http://upstream.internal",
      fetch: (async () =>
        Response.json({ name: "CI", data: "on" }, { status: 201 })) as typeof fetch,
    });
    const call = (version?: string) =>
      proxy(
        new Request("https://gitea.example/user/actions/variables/CI", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(version ? { "gitea-version": version } : {}),
          },
          body: JSON.stringify({ value: "on" }),
        }),
      );

    const old = await call("v1.24");
    expect(old.status).toBe(204);
    expect(await old.text()).toBe("");
    expect(old.headers.get("content-type")).toBeNull();

    const current = await call();
    expect(current.status).toBe(201);
    expect(await current.json()).toEqual({ name: "CI", data: "on" });
  });
});
