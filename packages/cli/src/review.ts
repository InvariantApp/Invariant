/**
 * The release check's comment on a GitLab merge request or a Bitbucket pull
 * request, where the GitHub Action writes it on GitHub.
 *
 * One comment per review, found again by its marker and edited on every push,
 * so a reviewer reads the current verdict rather than a thread of old ones. The
 * host is read from the CI environment each provides; the token is the
 * provider's own, in a variable they name, because neither CI's job token may
 * write a comment. A token that may not write is reported, never fatal: the
 * verdict is still the job's exit code, which a comment cannot change.
 */
import { COMMENT_MARKER } from "./comment.ts";

type Env = Record<string, string | undefined>;

export type ReviewOutcome =
  | { host: "gitlab" | "bitbucket"; comment: "created" | "updated" | "not-permitted" }
  | { host: undefined; reason: string };

interface Existing {
  id: string;
  body: string;
}

interface Host {
  name: "gitlab" | "bitbucket";
  headers: Record<string, string>;
  /** Every comment on the review, one page at a time. */
  pages: () => AsyncGenerator<Existing[] | "not-permitted">;
  create: (body: string) => { url: string; method: string; body: string };
  update: (id: string, body: string) => { url: string; method: string; body: string };
}

function gitlab(env: Env): Host | string {
  const api = env["CI_API_V4_URL"];
  const project = env["CI_PROJECT_ID"];
  const request = env["CI_MERGE_REQUEST_IID"];
  const token = env["INVARIANT_GITLAB_TOKEN"];
  if (!api || !project) return "not running in GitLab CI";
  if (!request) return "this pipeline is not for a merge request";
  if (!token) {
    return "INVARIANT_GITLAB_TOKEN is not set; a project access token with the api scope can write the comment";
  }
  const base = `${api}/projects/${encodeURIComponent(project)}/merge_requests/${request}/notes`;
  const headers = { "private-token": token, "content-type": "application/json" };
  return {
    name: "gitlab",
    headers,
    async *pages() {
      for (let page = 1; page <= 20; page += 1) {
        const response = await fetch(`${base}?per_page=100&page=${page}`, { headers });
        if (response.status === 401 || response.status === 403) {
          yield "not-permitted";
          return;
        }
        if (!response.ok) throw new Error(`listing notes answered ${response.status}`);
        const notes = (await response.json()) as { id: number; body?: string }[];
        yield notes.map((note) => ({ id: String(note.id), body: note.body ?? "" }));
        if (notes.length < 100) return;
      }
    },
    create: (body) => ({ url: base, method: "POST", body: JSON.stringify({ body }) }),
    update: (id, body) => ({
      url: `${base}/${id}`,
      method: "PUT",
      body: JSON.stringify({ body }),
    }),
  };
}

function bitbucket(env: Env): Host | string {
  const workspace = env["BITBUCKET_WORKSPACE"];
  const slug = env["BITBUCKET_REPO_SLUG"];
  const request = env["BITBUCKET_PR_ID"];
  const token = env["INVARIANT_BITBUCKET_TOKEN"];
  if (!workspace || !slug) return "not running in Bitbucket Pipelines";
  if (!request) return "this pipeline is not for a pull request";
  if (!token) {
    return "INVARIANT_BITBUCKET_TOKEN is not set; a repository access token that may write pull requests can write the comment";
  }
  const api = env["INVARIANT_BITBUCKET_API"] ?? "https://api.bitbucket.org/2.0";
  const base = `${api}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}/pullrequests/${request}/comments`;
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  return {
    name: "bitbucket",
    headers,
    async *pages() {
      let next: string | undefined = `${base}?pagelen=100`;
      for (let page = 0; next && page < 20; page += 1) {
        const response = await fetch(next, { headers });
        if (response.status === 401 || response.status === 403) {
          yield "not-permitted";
          return;
        }
        if (!response.ok) throw new Error(`listing comments answered ${response.status}`);
        const listed = (await response.json()) as {
          values: { id: number; content?: { raw?: string } }[];
          next?: string;
        };
        yield listed.values.map((comment) => ({
          id: String(comment.id),
          body: comment.content?.raw ?? "",
        }));
        next = listed.next;
      }
    },
    create: (body) => ({
      url: base,
      method: "POST",
      body: JSON.stringify({ content: { raw: body } }),
    }),
    update: (id, body) => ({
      url: `${base}/${id}`,
      method: "PUT",
      body: JSON.stringify({ content: { raw: body } }),
    }),
  };
}

/** Writes `body` as the review's one release-check comment, on whichever host this CI is. */
export async function upsertReviewComment(
  body: string,
  env: Env = process.env,
): Promise<ReviewOutcome> {
  const found = env["GITLAB_CI"]
    ? gitlab(env)
    : env["BITBUCKET_BUILD_NUMBER"]
      ? bitbucket(env)
      : undefined;
  if (found === undefined) {
    return {
      host: undefined,
      reason:
        "this CI is neither GitLab nor Bitbucket; on GitHub the Action writes the comment",
    };
  }
  if (typeof found === "string") return { host: undefined, reason: found };

  let existing: string | undefined;
  for await (const page of found.pages()) {
    if (page === "not-permitted") return { host: found.name, comment: "not-permitted" };
    existing = page.find((comment) => comment.body.startsWith(COMMENT_MARKER))?.id;
    if (existing !== undefined) break;
  }
  const write =
    existing === undefined ? found.create(body) : found.update(existing, body);
  const response = await fetch(write.url, {
    method: write.method,
    headers: found.headers,
    body: write.body,
  });
  if (response.status === 401 || response.status === 403) {
    return { host: found.name, comment: "not-permitted" };
  }
  if (!response.ok) throw new Error(`writing the comment answered ${response.status}`);
  return { host: found.name, comment: existing === undefined ? "created" : "updated" };
}
