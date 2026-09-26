/**
 * Suggested Changes: what `invariant propose` would draft, offered where the
 * blocked release is being read.
 *
 * A reviewer told that three breaking deltas are unexplained has to go and
 * run a command, read its drafts and commit them. Most of the time the drafts
 * are right, so the comment carries them: each file, exactly as `propose
 * --write` would write it, with a link that opens it in the host's editor on
 * the pull request's own branch. Accepting one is still a commit a person
 * makes, which is what records that they confirmed it, and the gate still
 * checks the result on the next push.
 *
 * Drafted with rules only. A comment is written on every push, often from a
 * fork's pipeline, and must never send the provider's documents to a model or
 * depend on a network the check itself does not need.
 */
import { join, relative } from "node:path";
import type { CheckReport } from "./check.ts";
import type { InvariantConfig } from "./config.ts";
import { draftFiles, runPropose } from "./propose.ts";

export interface Suggestion {
  id: string;
  summary: string;
  /** Where the file goes, relative to the directory holding invariant.yaml. */
  path: string;
  /** The same file, absolute, for a caller that needs another root. */
  file: string;
  /** The file's text, exactly as `propose --write` writes it. */
  text: string;
  /** A decision drafted with its answer left open; the gate refuses it as is. */
  needsAnswer: boolean;
  /** The proposer asked for a close look rather than a skim. */
  closeLook: boolean;
}

/**
 * Whether a report is blocked for the reason drafts can help with: breaking
 * deltas in the pending step that no Change explains. Anything else blocking
 * it is not something a new Change file would fix.
 */
export function wantsSuggestions(report: CheckReport): boolean {
  const pending = report.steps[report.steps.length - 1];
  return report.result === "block" && (pending?.unexplained.length ?? 0) > 0;
}

/**
 * The drafts for this release's unexplained deltas, skipping every id or
 * site a Change in the repository already covers, as `propose` does.
 */
export async function suggestChanges(config: InvariantConfig): Promise<Suggestion[]> {
  const result = await runPropose(config, { offline: true });
  return draftFiles(result).map((draft) => {
    const file = join(config.invariantDir, "changes", `${draft.id}.yaml`);
    return { ...draft, file, path: relative(config.root, file) };
  });
}

/**
 * The longest link worth offering. Measured against github.com in September
 * 2026: a 6,095 character link opens the editor (by way of the login page for
 * someone signed out), one of 7,095 fails with a server error on that
 * redirect, and 10,000 is refused outright.
 */
const MAX_URL = 6000;

/**
 * A link that opens GitHub's editor on a new file, prefilled, on the branch
 * the pull request is built from. The branch lives in the head repository,
 * which for a pull request from a fork is the contributor's own: the person
 * who can commit to it is the one the link works for.
 */
export function githubNewFileUrl(options: {
  server?: string;
  /** `owner/name` of the repository the pull request's branch lives in. */
  repository: string;
  branch: string;
}): (path: string, text: string) => string | undefined {
  const server = (options.server ?? "https://github.com").replace(/\/$/, "");
  const branch = options.branch.split("/").map(encodeURIComponent).join("/");
  return (path, text) => {
    const url =
      `${server}/${options.repository}/new/${branch}` +
      `?filename=${encodeURIComponent(path)}&value=${encodeURIComponent(text)}`;
    return url.length > MAX_URL ? undefined : url;
  };
}
