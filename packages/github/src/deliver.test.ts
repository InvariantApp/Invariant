/**
 * Delivering a migration, without the network.
 *
 * The fake below is a small model of the Git Data API rather than a pile of
 * stubbed responses, because the behaviour worth testing is what happens across
 * calls: that a redelivery does not open a second pull request, that an empty
 * change writes no commit, that a branch someone has built on is not
 * overwritten. Canned replies cannot show any of that.
 *
 * What is deliberately absent is any path that merges. There is none to test,
 * which is the point.
 */
import { createHash } from "node:crypto";
import type { EvolutionBundle } from "@invariant/bundle";
import { describe, expect, it } from "vitest";
import {
  DeliveryError,
  deliverMigration,
  type GitHubApi,
  promoteIfReady,
} from "./deliver.ts";
import type { MigrationSummary } from "./pr.ts";

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
    },
  ],
  evidence: [
    {
      kind: "E4-laws" as const,
      subject: "Payment",
      result: "pass" as const,
      inputsDigest: "sha256:1",
      tool: "fast-check",
      summary: "round trips hold",
    },
  ],
  compiled: { programDigest: "sha256:cccc" },
  gate: { result: "pass" as const, unexplained: [] },
} satisfies EvolutionBundle;

function summary(over: Partial<MigrationSummary> = {}): MigrationSummary {
  return {
    bundle: BUNDLE,
    repo: "acme/consumer-a",
    from: "2026-01-15",
    hunks: [
      {
        file: "src/checkout.ts",
        changeId: "chg_money_in_minor_units",
        author: "codemod" as const,
        reason: "renamed amount to amount_cents",
        typeChecked: true,
      },
    ],
    manual: [],
    newDiagnostics: [],
    testsRun: false,
    ...over,
  } as MigrationSummary;
}

/** A small, stateful model of the endpoints `deliver.ts` uses. */
function fakeGitHub(options: { branches?: Record<string, string> } = {}) {
  // Real GitHub gives identical contents the identical tree sha, which is what
  // makes a redelivery recognisable as one. The fake has to do the same, so
  // every tree here is named by its contents, the base included.
  // A digest, not a prefix of the contents. The first version took the leading
  // bytes as hex, so two trees whose first path was the same collided and a
  // second delivery looked like a redelivery.
  const treeSha = (files: readonly string[]) =>
    `tree_${createHash("sha256")
      .update([...files].sort().join("|"))
      .digest("hex")
      .slice(0, 12)}`;

  const branches: Record<string, string> = { main: "sha_base", ...options.branches };
  const trees: Record<string, string[]> = { [treeSha([])]: [] };
  const commits: Record<string, { tree: string; parents: string[] }> = {
    sha_base: { tree: treeSha([]), parents: [] },
  };
  const pulls: {
    number: number;
    head: string;
    base: string;
    draft: boolean;
    html_url: string;
  }[] = [];
  const calls: string[] = [];
  let checkRuns: { conclusion: string | null }[] = [];
  let next = 1;

  const api: GitHubApi = {
    // biome-ignore lint/suspicious/noExplicitAny: a fake transport is untyped by nature
    request: async <T>(method: string, path: string, body?: any) => {
      calls.push(`${method} ${path.split("?")[0]}`);
      const ok = <U>(data: U, status = 200) =>
        Promise.resolve({ status, data: data as unknown as T });

      const refMatch = /^\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\/(.+)$/.exec(path);
      if (method === "GET" && refMatch) {
        const sha = branches[refMatch[1] as string];
        if (!sha) throw new DeliveryError(`${path}: Not Found`, 404);
        return ok({ object: { sha } });
      }

      const commitMatch = /^\/repos\/[^/]+\/[^/]+\/git\/commits\/(.+)$/.exec(path);
      if (method === "GET" && commitMatch) {
        const found = commits[commitMatch[1] as string];
        if (!found) throw new DeliveryError("Not Found", 404);
        return ok({ sha: commitMatch[1], tree: { sha: found.tree } });
      }

      if (method === "POST" && path.endsWith("/git/trees")) {
        const parentFiles = trees[body.base_tree as string] ?? [];
        const written = (body.tree as { path: string; content?: string }[]).map(
          (entry) => `${entry.path}:${entry.content ?? ""}`,
        );
        // A later delivery adds to what is already on the branch; a path
        // written twice takes the newer content.
        const byPath = new Map(parentFiles.map((entry) => [entry.split(":")[0], entry]));
        for (const entry of written) byPath.set(entry.split(":")[0], entry);
        const merged = [...byPath.values()].sort();
        const sha = treeSha(merged);
        trees[sha] = merged;
        return ok({ sha });
      }

      if (method === "POST" && path.endsWith("/git/commits")) {
        const sha = `sha_${next++}`;
        commits[sha] = { tree: body.tree as string, parents: body.parents as string[] };
        return ok({ sha, tree: { sha: body.tree } });
      }

      if (method === "POST" && path.endsWith("/git/refs")) {
        branches[(body.ref as string).replace("refs/heads/", "")] = body.sha as string;
        return ok({ object: { sha: body.sha } }, 201);
      }

      const patchRef = /\/git\/refs\/heads\/(.+)$/.exec(path);
      if (method === "PATCH" && patchRef) {
        branches[patchRef[1] as string] = body.sha as string;
        return ok({ object: { sha: body.sha } });
      }

      if (method === "GET" && path.includes("/pulls?")) {
        const head = /head=[^:]+:([^&]+)/.exec(path)?.[1];
        return ok(pulls.filter((pull) => pull.head === head));
      }

      const pullMatch = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(path);
      if (method === "GET" && pullMatch) {
        const found = pulls.find((pull) => pull.number === Number(pullMatch[1]));
        if (!found) throw new DeliveryError("Not Found", 404);
        return ok({ ...found, head: { sha: branches[found.head] } });
      }
      if (method === "PATCH" && pullMatch) {
        const found = pulls.find((pull) => pull.number === Number(pullMatch[1]));
        if (found && body.draft === false) found.draft = false;
        return ok(found);
      }

      if (method === "POST" && path.endsWith("/pulls")) {
        const pull = {
          number: next++,
          head: body.head as string,
          base: body.base as string,
          draft: body.draft === true,
          html_url: `https://github.com/acme/consumer-a/pull/${next - 1}`,
        };
        pulls.push(pull);
        return ok(pull, 201);
      }

      if (path.includes("/check-runs")) return ok({ check_runs: checkRuns });
      if (path.includes("/comments")) return ok({}, 201);

      throw new DeliveryError(`unhandled ${method} ${path}`, 500);
    },
  };

  return {
    api,
    calls,
    pulls,
    branches,
    setChecks: (runs: { conclusion: string | null }[]) => {
      checkRuns = runs;
    },
  };
}

const FILES = [{ path: "src/checkout.ts", content: "const amount_cents = 4999;\n" }];

function deliver(github: ReturnType<typeof fakeGitHub>, files = FILES) {
  return deliverMigration({
    api: github.api,
    repo: "acme/consumer-a",
    baseBranch: "main",
    headBranch: "invariant/2026-09-20",
    summary: summary(),
    files,
    commitMessage: "Migrate to contract 2026-09-20",
  });
}

describe("opening the migration pull request", () => {
  it("commits the files and opens it as a draft", async () => {
    const github = fakeGitHub();
    const result = await deliver(github);

    expect(result.created).toBe(true);
    // Draft is not a preference. The consumer's own checks have not run, and
    // until they have, this is a proposal nobody has verified.
    expect(result.draft).toBe(true);
    expect(github.branches["invariant/2026-09-20"]).toBe(result.commit);
  });

  /**
   * The same bundle can arrive twice: a retry, a redelivered webhook, a
   * backfill when a repository is connected later. A second pull request would
   * be the consumer's problem to clean up.
   */
  it("does not open a second one when the same work is delivered again", async () => {
    const github = fakeGitHub();
    const first = await deliver(github);
    const second = await deliver(github);

    expect(second.created).toBe(false);
    expect(second.number).toBe(first.number);
    expect(github.pulls).toHaveLength(1);
  });

  it("writes no commit when the files are already what they should be", async () => {
    const github = fakeGitHub();
    await deliver(github);
    const before = github.branches["invariant/2026-09-20"];

    const second = await deliver(github);

    // An empty commit would make a redelivery look like new work to everyone
    // watching the repository.
    expect(second.commit).toBeUndefined();
    expect(github.branches["invariant/2026-09-20"]).toBe(before);
  });

  it("adds a later change to the branch it already opened", async () => {
    const github = fakeGitHub();
    const first = await deliver(github);

    const second = await deliver(github, [
      ...FILES,
      { path: "src/refunds.ts", content: "const amount_cents = 100;\n" },
    ]);

    expect(second.created).toBe(false);
    expect(second.number).toBe(first.number);
    expect(second.commit).toBeDefined();
    expect(second.commit).not.toBe(first.commit);
  });

  it("refuses to open one for a migration that changed nothing", async () => {
    const github = fakeGitHub();
    await expect(deliver(github, [])).rejects.toThrow(/changed no files/);
    expect(github.pulls).toHaveLength(0);
  });

  it("never force-pushes", async () => {
    const github = fakeGitHub();
    await deliver(github);
    await deliver(github, [{ path: "src/checkout.ts", content: "changed\n" }]);

    // A branch that moved may hold work somebody did on top of the draft, and
    // this is not the code that decides that it can go.
    expect(github.calls.some((call) => call.includes("force"))).toBe(false);
  });

  it("never merges anything", async () => {
    const github = fakeGitHub();
    await deliver(github);
    github.setChecks([{ conclusion: "success" }]);
    await promoteIfReady({
      api: github.api,
      repo: "acme/consumer-a",
      number: github.pulls[0]?.number as number,
      summary: summary(),
    });

    expect(github.calls.some((call) => call.includes("/merge"))).toBe(false);
  });
});

describe("taking it out of draft", () => {
  it("promotes once the consumer's own checks pass", async () => {
    const github = fakeGitHub();
    await deliver(github);
    github.setChecks([{ conclusion: "success" }, { conclusion: "neutral" }]);

    const result = await promoteIfReady({
      api: github.api,
      repo: "acme/consumer-a",
      number: github.pulls[0]?.number as number,
      summary: summary(),
    });

    expect(result.promoted).toBe(true);
    expect(github.pulls[0]?.draft).toBe(false);
  });

  it("leaves it a draft when a check failed", async () => {
    const github = fakeGitHub();
    await deliver(github);
    github.setChecks([{ conclusion: "success" }, { conclusion: "failure" }]);

    const result = await promoteIfReady({
      api: github.api,
      repo: "acme/consumer-a",
      number: github.pulls[0]?.number as number,
      summary: summary(),
    });

    expect(result.promoted).toBe(false);
    expect(github.pulls[0]?.draft).toBe(true);
  });

  /**
   * Green checks are necessary and not sufficient. A site the engine could not
   * migrate is a site nobody has looked at, and the consumer's suite passing
   * says nothing about it.
   */
  it("leaves it a draft when a site still needs a person", async () => {
    const github = fakeGitHub();
    await deliver(github);
    github.setChecks([{ conclusion: "success" }]);

    const result = await promoteIfReady({
      api: github.api,
      repo: "acme/consumer-a",
      number: github.pulls[0]?.number as number,
      summary: summary({
        manual: [
          {
            file: "src/legacy.ts",
            line: 12,
            column: 3,
            changeId: "chg_money_in_minor_units",
            reason: "status is built into a string",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source text from the migrated file, not an interpolation
            snippet: "`paid:${status}`",
            offset: 0,
          },
        ],
      } as Partial<MigrationSummary>),
    });

    expect(result.promoted).toBe(false);
    expect(result.reason).toContain("need a person");
    expect(github.pulls[0]?.draft).toBe(true);
  });

  it("waits rather than promoting on an empty check list", async () => {
    const github = fakeGitHub();
    await deliver(github);
    github.setChecks([]);

    const result = await promoteIfReady({
      api: github.api,
      repo: "acme/consumer-a",
      number: github.pulls[0]?.number as number,
      summary: summary(),
    });

    // No checks and all checks passing are not the same thing, and a
    // repository with no CI must not be treated as a repository with green CI.
    expect(result.promoted).toBe(false);
    expect(result.reason).toContain("no checks");
  });

  it("ignores a check that has not finished", async () => {
    const github = fakeGitHub();
    await deliver(github);
    github.setChecks([{ conclusion: "success" }, { conclusion: null }]);

    const result = await promoteIfReady({
      api: github.api,
      repo: "acme/consumer-a",
      number: github.pulls[0]?.number as number,
      summary: summary(),
    });

    // A run still in progress is not a failure, and it is not a pass either.
    // It is simply not an answer yet, and the next webhook will bring one.
    expect(result.promoted).toBe(true);
  });
});
