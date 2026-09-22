/**
 * The release check's comment on GitLab and Bitbucket, against servers that
 * answer as each host's API does: written once, then edited, never duplicated.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMMENT_MARKER } from "./comment.ts";
import { upsertReviewComment } from "./review.ts";

interface Held {
  id: number;
  body: string;
}

let server: Server;
let base: string;
const gitlab: Held[] = [{ id: 1, body: "looks good" }];
const bitbucket: Held[] = [{ id: 9, body: "nice" }];
const seenHeaders: Record<string, unknown>[] = [];

const read = (request: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => resolve(text));
  });

beforeAll(async () => {
  server = createServer(async (request, response) => {
    seenHeaders.push(request.headers);
    const url = new URL(request.url ?? "/", "http://x");
    const reply = (status: number, value?: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(value === undefined ? "" : JSON.stringify(value));
    };
    if (url.pathname.startsWith("/api/v4/projects/acme%2Fapi/merge_requests/7/notes")) {
      if (request.headers["private-token"] !== "glpat") return reply(401);
      const id = Number(url.pathname.split("/").at(-1));
      if (request.method === "GET") return reply(200, gitlab);
      const { body } = JSON.parse(await read(request)) as { body: string };
      if (request.method === "POST") {
        gitlab.push({ id: 2, body });
        return reply(201, {});
      }
      const note = gitlab.find((entry) => entry.id === id);
      if (note) note.body = body;
      return reply(200, {});
    }
    if (url.pathname.startsWith("/2.0/repositories/acme/api/pullrequests/3/comments")) {
      const id = Number(url.pathname.split("/").at(-1));
      if (request.method === "GET") {
        return reply(200, {
          values: bitbucket.map((entry) => ({
            id: entry.id,
            content: { raw: entry.body },
          })),
        });
      }
      const { content } = JSON.parse(await read(request)) as { content: { raw: string } };
      if (request.method === "POST") {
        bitbucket.push({ id: 10, body: content.raw });
        return reply(201, {});
      }
      const comment = bitbucket.find((entry) => entry.id === id);
      if (comment) comment.body = content.raw;
      return reply(200, {});
    }
    reply(404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const comment = (verdict: string) => `${COMMENT_MARKER}\n\n${verdict}`;

describe("the comment on GitLab", () => {
  const env = () => ({
    GITLAB_CI: "true",
    CI_API_V4_URL: `${base}/api/v4`,
    CI_PROJECT_ID: "acme/api",
    CI_MERGE_REQUEST_IID: "7",
    INVARIANT_GITLAB_TOKEN: "glpat",
  });

  it("is written once, then edited in place", async () => {
    expect(await upsertReviewComment(comment("blocked"), env())).toEqual({
      host: "gitlab",
      comment: "created",
    });
    expect(await upsertReviewComment(comment("passes"), env())).toEqual({
      host: "gitlab",
      comment: "updated",
    });
    expect(gitlab).toEqual([
      { id: 1, body: "looks good" },
      { id: 2, body: comment("passes") },
    ]);
  });

  it("says so when the token may not write, and when there is none", async () => {
    expect(
      await upsertReviewComment(comment("x"), {
        ...env(),
        INVARIANT_GITLAB_TOKEN: "wrong",
      }),
    ).toEqual({ host: "gitlab", comment: "not-permitted" });
    const { INVARIANT_GITLAB_TOKEN: _, ...without } = env();
    expect(await upsertReviewComment(comment("x"), without)).toMatchObject({
      host: undefined,
      reason: expect.stringMatching(/INVARIANT_GITLAB_TOKEN is not set/),
    });
  });
});

describe("the comment on Bitbucket", () => {
  it("is written once, then edited in place", async () => {
    const env = {
      BITBUCKET_BUILD_NUMBER: "12",
      BITBUCKET_WORKSPACE: "acme",
      BITBUCKET_REPO_SLUG: "api",
      BITBUCKET_PR_ID: "3",
      INVARIANT_BITBUCKET_TOKEN: "bbt",
      INVARIANT_BITBUCKET_API: `${base}/2.0`,
    };
    expect(await upsertReviewComment(comment("blocked"), env)).toMatchObject({
      comment: "created",
    });
    expect(await upsertReviewComment(comment("passes"), env)).toMatchObject({
      comment: "updated",
    });
    expect(bitbucket.map((entry) => entry.body)).toEqual(["nice", comment("passes")]);
    expect(seenHeaders.at(-1)?.["authorization"]).toBe("Bearer bbt");
  });
});

describe("anywhere else", () => {
  it("writes nothing and says why", async () => {
    expect(await upsertReviewComment(comment("x"), {})).toMatchObject({
      host: undefined,
    });
  });
});
