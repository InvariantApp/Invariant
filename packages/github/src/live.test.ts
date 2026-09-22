/**
 * The same delivery, against real GitHub.
 *
 * `deliver.test.ts` runs the logic against a fake that models the Git Data API.
 * A fake is only ever as right as whoever wrote it, so this runs the identical
 * code against the service itself: a real repository, a real tree, a real
 * commit, a real draft pull request.
 *
 * Skipped unless `INVARIANT_GH_TOKEN` and `INVARIANT_GH_REPO` are set, because
 * it needs credentials and writes to a repository. It is not part of the
 * ordinary suite and it is not run in continuous integration.
 *
 * What it does not prove, and must not be read as proving: the GitHub App half.
 * Installation tokens, the sponsored link a consumer redeems, and webhook
 * delivery all need an app registration that has to be created through a
 * browser. The code path is identical from `GitHubApi` inwards, because
 * authentication is an argument here rather than a dependency, but the
 * registration itself is untested and this file says so rather than implying
 * otherwise.
 *
 *   INVARIANT_GH_TOKEN=... INVARIANT_GH_REPO=owner/name \
 *     pnpm vitest run packages/github/src/live.test.ts
 */
import type { EvolutionBundle } from "@invariant-app/bundle";
import { describe, expect, it } from "vitest";
import { apiFromFetch, deliverMigration, promoteIfReady } from "./deliver.ts";
import type { MigrationSummary } from "./pr.ts";

const TOKEN = process.env["INVARIANT_GH_TOKEN"];
const REPO = process.env["INVARIANT_GH_REPO"];
const live = TOKEN !== undefined && REPO !== undefined;

const BUNDLE = {
  bundleVersion: 1,
  api: "acme-payments",
  from: { label: "2026-01-15", digest: "sha256:bbbb" },
  to: { label: "2026-09-20", digest: "sha256:aaaaaaaaaaaaaaaaaaaa" },
  source: { repo: "acme/payments-api", commit: "c0ffee1234", pr: 482 },
  changes: [
    {
      irVersion: 1 as const,
      id: "chg_money_in_minor_units",
      summary: "Money crosses the wire in minor units.",
      ops: [{ op: "move" as const, from: "/amount", to: "/amount_cents" }],
      provenance: {
        confirmed_by: {
          kind: "provider-merge" as const,
          commit: "abc",
          reviewer: "dana",
        },
      },
    },
  ],
  evidence: [
    {
      kind: "E4-laws" as const,
      subject: "Payment",
      result: "pass" as const,
      inputsDigest: "sha256:1",
      tool: "fast-check",
      summary: "round trips hold on 10000 generated values",
    },
  ],
  compiled: { programDigest: "sha256:cccc" },
  gate: { result: "pass" as const, unexplained: [] },
} satisfies EvolutionBundle;

const SUMMARY: MigrationSummary = {
  bundle: BUNDLE,
  repo: REPO ?? "owner/name",
  from: "2026-01-15",
  hunks: [
    {
      file: "src/checkout.ts",
      changeId: "chg_money_in_minor_units",
      author: "codemod",
      reason: "renamed amount to amount_cents and scaled the literal",
      typeChecked: true,
    },
  ],
  manual: [],
  newDiagnostics: [],
  testsRun: false,
};

/**
 * A branch per run, so two runs never fight over the same ref.
 *
 * The repository is left as it is afterwards rather than cleaned up: the token
 * this runs with deliberately cannot delete anything, and a draft pull request
 * left open is the visible evidence that it worked.
 */
const BRANCH = `invariant/2026-09-20-${Date.now().toString(36)}`;

describe.skipIf(!live)("delivering against real GitHub", () => {
  it("opens a draft pull request with the migration on it", async () => {
    const api = apiFromFetch(TOKEN as string);
    const result = await deliverMigration({
      api,
      repo: REPO as string,
      baseBranch: "main",
      headBranch: BRANCH,
      summary: SUMMARY,
      files: [
        {
          path: "src/checkout.ts",
          content: "export const payment = { amount_cents: 4999, currency: 'usd' };\n",
        },
      ],
      commitMessage: "Move to acme-payments contract 2026-09-20",
    });

    expect(result.created).toBe(true);
    expect(result.draft).toBe(true);
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);

    // The body is the whole point of the pull request: a consumer has to be
    // able to see what changed, who confirmed it, and what was proved, without
    // leaving the page.
    const pull = await api.request<{ body: string; draft: boolean }>(
      "GET",
      `/repos/${REPO}/pulls/${result.number}`,
    );
    expect(pull.data.draft).toBe(true);
    expect(pull.data.body).toContain("chg_money_in_minor_units");
    expect(pull.data.body).toContain("codemod");
  }, 60_000);

  it("does not open a second one when the same work is delivered again", async () => {
    const api = apiFromFetch(TOKEN as string);
    const again = await deliverMigration({
      api,
      repo: REPO as string,
      baseBranch: "main",
      headBranch: BRANCH,
      summary: SUMMARY,
      files: [
        {
          path: "src/checkout.ts",
          content: "export const payment = { amount_cents: 4999, currency: 'usd' };\n",
        },
      ],
      commitMessage: "Move to acme-payments contract 2026-09-20",
    });

    expect(again.created).toBe(false);
    // Identical contents, so GitHub returns the tree that is already there and
    // nothing is committed. A redelivery must not look like new work.
    expect(again.commit).toBeUndefined();
  }, 60_000);

  it("leaves it a draft while the repository has reported no checks", async () => {
    const api = apiFromFetch(TOKEN as string);
    const open = await api.request<{ number: number }[]>(
      "GET",
      `/repos/${REPO}/pulls?state=open&head=${(REPO as string).split("/")[0]}:${BRANCH}`,
    );
    const number = open.data[0]?.number as number;

    const result = await promoteIfReady({
      api,
      repo: REPO as string,
      number,
      summary: SUMMARY,
    });

    // No checks configured on this repository, which is not the same as checks
    // passing, and must never be read as though it were.
    expect(result.promoted).toBe(false);
    expect(result.reason).toContain("no checks");
  }, 60_000);
});
