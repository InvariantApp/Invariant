/**
 * The same delivery again, as the GitHub App this time.
 *
 * `live.test.ts` proved the delivery path against real GitHub using whatever
 * token the harness had. That leaves the question the App exists to answer
 * unasked: not whether a token can open a pull request, but whether *this*
 * token can only reach the repositories a consumer chose.
 *
 * A personal token carries everything its owner can see. An installation token
 * carries one installation, narrowed again to the repositories named when it
 * was minted. The difference is the entire reason for the App, and it is a
 * claim about GitHub's enforcement rather than about this code, so the only
 * way to establish it is to ask GitHub.
 *
 * Needs `.secrets/github-app.json` and `INVARIANT_GH_APP_LIVE=1`. Skipped
 * otherwise, and never run in continuous integration.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvolutionBundle } from "@invariant/bundle";
import { describe, expect, it } from "vitest";
import { appApi, installationToken } from "./app.ts";
import { apiFromFetch, DeliveryError, deliverMigration } from "./deliver.ts";
import type { MigrationSummary } from "./pr.ts";

const CREDENTIALS = join(
  new URL("../../../", import.meta.url).pathname,
  ".secrets/github-app.json",
);

const enabled = process.env["INVARIANT_GH_APP_LIVE"] === "1" && existsSync(CREDENTIALS);

interface Stored {
  appId: string;
  privateKey: string;
}

const stored: Stored = enabled
  ? (JSON.parse(readFileSync(CREDENTIALS, "utf8")) as Stored)
  : { appId: "", privateKey: "" };

/** The repository the app was installed on, and one it deliberately was not. */
const GRANTED = "InvariantApp/invariant-delivery-fixture";
const WITHHELD = "InvariantApp/Invariant";

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
  repo: GRANTED,
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

async function installationFor(repo: string): Promise<number> {
  const api = apiFromFetch(
    (await import("./app.ts")).appJwt({
      appId: stored.appId,
      privateKey: stored.privateKey,
    }),
  );
  const [owner, name] = repo.split("/");
  const found = await api.request<{ id: number }>(
    "GET",
    `/repos/${owner}/${name}/installation`,
  );
  return found.data.id;
}

describe.skipIf(!enabled)("delivering as the GitHub App", () => {
  it("mints a token scoped to the repository it was asked for", async () => {
    const installation = await installationFor(GRANTED);
    const token = await installationToken({ ...stored }, installation, {
      repositories: [GRANTED.split("/")[1] as string],
    });

    expect(token.token.startsWith("ghs_")).toBe(true);
    // An hour, give or take. A token that did not expire would be a token that
    // had to be revoked by hand if it ever leaked.
    expect(token.expiresAt - Date.now()).toBeLessThanOrEqual(3_700_000);
    expect(token.expiresAt).toBeGreaterThan(Date.now());
  }, 60_000);

  /**
   * The claim the App exists to make, asked of GitHub rather than asserted.
   *
   * A personal token reaches everything its owner can see, so `Invariant`
   * itself would be readable with one. The installation token must not reach
   * it, and GitHub answers 404 rather than 403 so that the token cannot be
   * used to discover which private repositories exist.
   */
  it("cannot reach a repository the installation does not cover", async () => {
    const installation = await installationFor(GRANTED);
    const api = appApi({ ...stored }, installation, {
      repositories: [GRANTED.split("/")[1] as string],
    });

    await expect(api.request("GET", `/repos/${WITHHELD}`)).rejects.toThrow(DeliveryError);

    const reachable = await api.request<{ full_name: string }>(
      "GET",
      `/repos/${GRANTED}`,
    );
    expect(reachable.data.full_name).toBe(GRANTED);
  }, 60_000);

  it("opens the draft pull request through installation auth", async () => {
    const installation = await installationFor(GRANTED);
    const api = appApi({ ...stored }, installation, {
      repositories: [GRANTED.split("/")[1] as string],
    });

    const branch = `invariant/app-${Date.now().toString(36)}`;
    const result = await deliverMigration({
      api,
      repo: GRANTED,
      baseBranch: "main",
      headBranch: branch,
      summary: SUMMARY,
      files: [
        {
          path: "src/checkout.ts",
          content: `export const payment = { amount_cents: 4999, currency: 'usd' }; // ${branch}\n`,
        },
      ],
      commitMessage: "Move to acme-payments contract 2026-09-20",
    });

    expect(result.created).toBe(true);
    expect(result.draft).toBe(true);

    // Attributed to the app, not to a person. A migration nobody wrote should
    // not arrive wearing somebody's name, and GitHub's `[bot]` suffix says so
    // in a way that cannot be mistaken for a username: the suffix is reserved,
    // so no account can be created that would blend in with it.
    const commit = await api.request<{ author: { name: string } | null }>(
      "GET",
      `/repos/${GRANTED}/git/commits/${result.commit}`,
    );
    expect(commit.data.author?.name).toBe("invariant-updater[bot]");
  }, 60_000);
});
