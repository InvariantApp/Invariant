/**
 * Turning a migration into a real pull request on a real repository.
 *
 * Everything else in this package is pure: signatures, expiring links, the
 * provenance body, the promotion rule. This is the part that talks to GitHub,
 * and it is kept deliberately thin, because the interesting decisions were all
 * made before anything is sent.
 *
 * Three things it will not do. It never merges, because a migration is a
 * proposal and merging it is the consumer's decision. It never force-pushes,
 * because a branch it does not own may hold work somebody did on top of the
 * draft. And it never runs the consumer's code: the commit is built from file
 * contents through the Git Data API, without a checkout, so nothing in the
 * repository being migrated is ever executed on our side.
 *
 * Authentication is an argument rather than a dependency. In production that is
 * a short-lived installation token from the GitHub App, which is scoped to the
 * repositories a consumer chose. In a test it is whatever the harness has.
 */
import type { MigrationSummary } from "./pr.ts";
import {
  PR_MARKER,
  readyToPromote,
  renderPullRequestBody,
  renderPullRequestTitle,
} from "./pr.ts";

export class DeliveryError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "DeliveryError";
    this.status = status;
  }
}

/**
 * The slice of GitHub this needs, named so it can be faked exactly.
 *
 * Small on purpose. A wrapper that exposed the whole API would be a wrapper
 * nobody could test without the network, and the parts that matter here are
 * the six calls below.
 */
export interface GitHubApi {
  request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; data: T }>;
}

/** An Octokit-shaped client, or anything else that can make a request. */
export function apiFromFetch(
  token: string,
  fetchImpl: typeof fetch = fetch,
  baseUrl = "https://api.github.com",
): GitHubApi {
  return {
    async request<T>(method: string, path: string, body?: Record<string, unknown>) {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "content-type": "application/json",
          "user-agent": "invariant-updater",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      const text = await response.text();
      const data = (text === "" ? null : JSON.parse(text)) as T;
      if (!response.ok) {
        const message =
          typeof data === "object" && data !== null && "message" in data
            ? String((data as { message: unknown }).message)
            : response.statusText;
        throw new DeliveryError(`${method} ${path}: ${message}`, response.status);
      }
      return { status: response.status, data };
    },
  };
}

export interface FileChange {
  /** Path inside the repository, with no leading slash. */
  path: string;
  /** New contents, or null to delete the file. */
  content: string | null;
}

export interface DeliverOptions {
  api: GitHubApi;
  /** `owner/name`. */
  repo: string;
  /** Branch the pull request targets. Read, never written to. */
  baseBranch: string;
  /** Branch the migration is pushed to. Created if absent, updated if present. */
  headBranch: string;
  summary: MigrationSummary;
  files: readonly FileChange[];
  commitMessage: string;
}

export interface DeliveryResult {
  /** The pull request number, whether it was opened now or already existed. */
  number: number;
  url: string;
  /** Whether this call created it. A second run updates rather than duplicates. */
  created: boolean;
  /** The commit the branch now points at, or undefined when nothing changed. */
  commit: string | undefined;
  draft: boolean;
}

interface Ref {
  object: { sha: string };
}
interface Commit {
  sha: string;
  tree: { sha: string };
}
interface Tree {
  sha: string;
}
interface PullRequest {
  number: number;
  html_url: string;
  draft: boolean;
  head: { sha: string };
}

/**
 * Opens or updates the migration pull request.
 *
 * Idempotent by design, because the same bundle can be delivered twice: a
 * retry, a redelivered webhook, a backfill when a repository is connected
 * later. A second run with identical files changes nothing and returns the
 * pull request that is already open, rather than opening a second one that a
 * consumer then has to close.
 */
export async function deliverMigration(options: DeliverOptions): Promise<DeliveryResult> {
  const { api, repo, baseBranch, headBranch, files, summary } = options;

  const base = await api.request<Ref>(
    "GET",
    `/repos/${repo}/git/ref/heads/${baseBranch}`,
  );
  const baseSha = base.data.object.sha;

  const existingHead = await headRef(api, repo, headBranch);
  const parent = existingHead ?? baseSha;
  const parentCommit = await api.request<Commit>(
    "GET",
    `/repos/${repo}/git/commits/${parent}`,
  );

  const tree = await api.request<Tree>("POST", `/repos/${repo}/git/trees`, {
    base_tree: parentCommit.data.tree.sha,
    tree: files.map((file) => ({
      path: file.path,
      mode: "100644",
      type: "blob",
      ...(file.content === null ? { sha: null } : { content: file.content }),
    })),
  });

  // Nothing to say. Writing an empty commit would make a redelivery look like
  // new work to everyone watching the repository.
  const unchanged = tree.data.sha === parentCommit.data.tree.sha;

  let head = parent;
  if (!unchanged) {
    const commit = await api.request<Commit>("POST", `/repos/${repo}/git/commits`, {
      message: options.commitMessage,
      tree: tree.data.sha,
      parents: [parent],
    });
    head = commit.data.sha;

    if (existingHead) {
      // Fast-forward only. A branch that has moved underneath us may hold work
      // somebody did on top of the draft, and this is not the code to decide
      // that it can go.
      await api.request("PATCH", `/repos/${repo}/git/refs/heads/${headBranch}`, {
        sha: head,
        force: false,
      });
    } else {
      await api.request("POST", `/repos/${repo}/git/refs`, {
        ref: `refs/heads/${headBranch}`,
        sha: head,
      });
    }
  }

  const open = await openPullRequest(api, repo, headBranch, baseBranch);
  if (open) {
    return {
      number: open.number,
      url: open.html_url,
      created: false,
      commit: unchanged ? undefined : head,
      draft: open.draft,
    };
  }

  if (unchanged && !existingHead) {
    throw new DeliveryError(
      `${repo}: the migration changed no files, so there is nothing to open a pull request about`,
    );
  }

  const created = await api.request<PullRequest>("POST", `/repos/${repo}/pulls`, {
    title: renderPullRequestTitle(summary),
    // Draft, always. The consumer's own checks decide whether it is ready, and
    // they have not run yet.
    draft: true,
    head: headBranch,
    base: baseBranch,
    body: renderPullRequestBody(summary),
  });

  return {
    number: created.data.number,
    url: created.data.html_url,
    created: true,
    commit: head,
    draft: true,
  };
}

async function headRef(
  api: GitHubApi,
  repo: string,
  branch: string,
): Promise<string | undefined> {
  try {
    const ref = await api.request<Ref>("GET", `/repos/${repo}/git/ref/heads/${branch}`);
    return ref.data.object.sha;
  } catch (error) {
    if (error instanceof DeliveryError && error.status === 404) return undefined;
    throw error;
  }
}

async function openPullRequest(
  api: GitHubApi,
  repo: string,
  head: string,
  base: string,
): Promise<PullRequest | undefined> {
  const owner = repo.split("/")[0];
  const found = await api.request<PullRequest[]>(
    "GET",
    `/repos/${repo}/pulls?state=open&head=${owner}:${head}&base=${base}`,
  );
  return found.data[0];
}

export interface PromotionResult {
  promoted: boolean;
  reason: string;
}

/**
 * Takes the pull request out of draft once the consumer's own checks pass.
 *
 * The promotion rule itself lives in `readyToPromote` and is tested without a
 * network. This is the part that asks GitHub what happened and, if the answer
 * is good, says so on the pull request. It still does not merge.
 */
export async function promoteIfReady(options: {
  api: GitHubApi;
  repo: string;
  number: number;
  summary: MigrationSummary;
}): Promise<PromotionResult> {
  const { api, repo, number, summary } = options;

  const pull = await api.request<PullRequest>("GET", `/repos/${repo}/pulls/${number}`);
  const runs = await api.request<{ check_runs: { conclusion: string | null }[] }>(
    "GET",
    `/repos/${repo}/commits/${pull.data.head.sha}/check-runs`,
  );

  const checks = runs.data.check_runs
    .filter((run) => run.conclusion !== null)
    .map((run) => ({ conclusion: run.conclusion as string }));

  const verdict = readyToPromote(summary, checks);
  if (!verdict.ready) return { promoted: false, reason: verdict.reason };
  if (!pull.data.draft) return { promoted: false, reason: "it is already out of draft" };

  await api.request("PATCH", `/repos/${repo}/pulls/${number}`, { draft: false });
  await api.request("POST", `/repos/${repo}/issues/${number}/comments`, {
    body: `${PR_MARKER}\nReady for review: ${verdict.reason}. Nothing here has been merged, and nothing here will be.`,
  });

  return { promoted: true, reason: verdict.reason };
}
