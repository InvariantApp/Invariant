/**
 * The release check, as a GitHub Action.
 *
 * It runs from this repository at a tag, not from npm, so it works before any
 * package is published and pins exactly the code a provider's workflow names.
 * It needs neither npm nor Go: the check is bundled into one file, and oasdiff
 * is downloaded from its pinned release, verified against two hashes, and
 * cached on the runner.
 *
 * Everything the runner provides arrives through `env`, so the whole action can
 * be run against a real repository with a recorded GitHub API in a test.
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  type CheckReport,
  COMMENT_MARKER,
  check,
  loadConfig,
  renderComment,
} from "@invariant/cli";
import {
  assertPinnedVersion,
  binaryFor,
  installBinary,
  OASDIFF_VERSION,
} from "@invariant/diff";

export type Env = Record<string, string | undefined>;

export interface ActionResult {
  report: CheckReport;
  exitCode: number;
  /** What happened to the pull request comment, for the log. */
  comment: "created" | "updated" | "skipped" | "not-permitted";
}

function input(env: Env, name: string, fallback = ""): string {
  const value = env[`INPUT_${name.replaceAll(" ", "_").toUpperCase()}`];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

/** Where the verified oasdiff lives on this runner, fetched once per version. */
async function ensureOasdiff(env: Env): Promise<string> {
  if (env["OASDIFF_BIN"]) return env["OASDIFF_BIN"];
  const binary = binaryFor();
  if (!binary) {
    throw new Error(
      `No oasdiff release is published for ${process.platform}-${process.arch}. ` +
        "Set OASDIFF_BIN to an oasdiff binary on this runner.",
    );
  }
  const cache = join(
    env["RUNNER_TOOL_CACHE"] ?? env["RUNNER_TEMP"] ?? ".",
    "invariant-oasdiff",
    OASDIFF_VERSION,
  );
  const executable = join(cache, binary.executable);
  if (!existsSync(executable)) await installBinary(binary, cache);
  await assertPinnedVersion(executable);
  return executable;
}

/** The pull request this run is for, if it is for one. */
async function pullRequestNumber(env: Env): Promise<number | undefined> {
  const path = env["GITHUB_EVENT_PATH"];
  if (!path || !existsSync(path)) return undefined;
  const event = JSON.parse(await readFile(path, "utf8")) as {
    pull_request?: { number?: number };
  };
  return event.pull_request?.number;
}

/**
 * Writes the report as the one comment on the pull request, editing the last
 * run's rather than adding another on every push.
 *
 * A pull request from a fork gets a read-only token, so the comment cannot be
 * written. That is reported and is not a failure: the verdict is still the
 * check's exit code and the job summary, which a fork cannot suppress.
 */
async function upsertComment(
  env: Env,
  body: string,
  send: typeof fetch,
): Promise<ActionResult["comment"]> {
  const number = await pullRequestNumber(env);
  const repository = env["GITHUB_REPOSITORY"];
  const token = input(env, "token");
  if (number === undefined || !repository || !token) return "skipped";

  const api = env["GITHUB_API_URL"] ?? "https://api.github.com";
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "content-type": "application/json",
  };

  let existing: number | undefined;
  for (let page = 1; page <= 20 && existing === undefined; page += 1) {
    const response = await send(
      `${api}/repos/${repository}/issues/${number}/comments?per_page=100&page=${page}`,
      { headers },
    );
    if (response.status === 403 || response.status === 404) return "not-permitted";
    if (!response.ok) throw new Error(`listing comments answered ${response.status}`);
    const comments = (await response.json()) as { id: number; body?: string }[];
    existing = comments.find((comment) => comment.body?.startsWith(COMMENT_MARKER))?.id;
    if (comments.length < 100) break;
  }

  const response = await send(
    existing === undefined
      ? `${api}/repos/${repository}/issues/${number}/comments`
      : `${api}/repos/${repository}/issues/comments/${existing}`,
    {
      method: existing === undefined ? "POST" : "PATCH",
      headers,
      body: JSON.stringify({ body }),
    },
  );
  if (response.status === 403 || response.status === 404) return "not-permitted";
  if (!response.ok) throw new Error(`writing the comment answered ${response.status}`);
  return existing === undefined ? "created" : "updated";
}

/** GitHub's workflow-command escaping for the message part of an annotation. */
function escapeData(text: string): string {
  return text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeProperty(text: string): string {
  return escapeData(text).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

/**
 * Annotations on the specification file, so the reason a pull request is
 * blocked appears in the diff view beside the file that caused it.
 */
function annotations(report: CheckReport, spec: string): string[] {
  const at = (level: "error" | "warning", title: string, message: string): string =>
    `::${level} file=${escapeProperty(spec)},title=${escapeProperty(title)}::${escapeData(message)}`;
  return [
    ...report.steps.flatMap((step) =>
      step.unexplained.map((entry) =>
        at("error", "Breaking change nothing explains", entry),
      ),
    ),
    ...report.unservable.map((entry) =>
      at("error", "Change the adapter cannot serve", entry),
    ),
    ...report.policy.map((entry) => at("error", "Refused by invariant.yaml", entry)),
    ...report.problems.map((entry) => at("error", "Verification found a problem", entry)),
    ...report.warnings.map((entry) => at("warning", "Worth reading", entry)),
  ];
}

export async function runAction(
  env: Env,
  options: { fetch?: typeof fetch; log?: (line: string) => void } = {},
): Promise<ActionResult> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const send = options.fetch ?? fetch;
  const workspace = env["GITHUB_WORKSPACE"] ?? process.cwd();

  process.env["OASDIFF_BIN"] = await ensureOasdiff(env);

  const config = await loadConfig(
    resolve(workspace, input(env, "config", "invariant.yaml")),
  );
  const report = await check(config, {
    full: input(env, "full", "false") === "true",
  });
  const comment = renderComment(report);

  for (const line of annotations(report, relative(workspace, config.currentSpec)))
    log(line);

  const outputFile = env["RUNNER_TEMP"]
    ? join(env["RUNNER_TEMP"], "invariant-report.md")
    : join(workspace, "invariant-report.md");
  await mkdir(resolve(outputFile, ".."), { recursive: true });
  await writeFile(outputFile, comment, "utf8");

  if (env["GITHUB_STEP_SUMMARY"]) {
    await appendFile(env["GITHUB_STEP_SUMMARY"], `${comment}\n`, "utf8");
  }
  if (env["GITHUB_OUTPUT"]) {
    const unexplained = report.steps.reduce(
      (sum, step) => sum + step.unexplained.length,
      0,
    );
    await appendFile(
      env["GITHUB_OUTPUT"],
      `result=${report.result}\nunexplained=${unexplained}\nreport=${outputFile}\n`,
      "utf8",
    );
  }

  let written: ActionResult["comment"] = "skipped";
  if (input(env, "comment", "true") === "true") {
    written = await upsertComment(env, comment, send);
    if (written === "not-permitted") {
      log(
        "::notice title=Comment not written::This run's token cannot comment on the pull " +
          "request, which is normal for one opened from a fork. The verdict is this " +
          "step's result and the job summary.",
      );
    }
  }

  return { report, exitCode: report.result === "block" ? 1 : 0, comment: written };
}
