/**
 * The pull request comment.
 *
 * What is tested here is mostly what the comment refuses to do: claim a layer
 * ran when it did not, and bury the reason a release is blocked underneath the
 * evidence that everything else was fine.
 */
import { oasdiffAvailable } from "@invariant-app/diff";
import { describe, expect, it } from "vitest";
import { type CheckReport, check } from "./check.ts";
import { COMMENT_MARKER, renderComment } from "./comment.ts";
import { loadConfig } from "./config.ts";
import { githubNewFileUrl } from "./suggest.ts";

const FIXTURE = new URL("../../../fixtures/provider-acme/", import.meta.url).pathname;
const hasOasdiff = await oasdiffAvailable();

describe.skipIf(!hasOasdiff)("the pull request comment", () => {
  it("leads with the verdict and folds the evidence away", async () => {
    const report = await check(await loadConfig(`${FIXTURE}invariant.yaml`));
    const comment = renderComment(report);

    // The marker lets a second run edit the first comment rather than pile a
    // new one on every push.
    expect(comment.startsWith(COMMENT_MARKER)).toBe(true);
    expect(comment).toContain("## Safe to merge");
    expect(comment).toContain("<details>");
    expect(comment).toContain("| :white_check_mark: |");

    // The verdict comes before the proof, not after it.
    expect(comment.indexOf("## Safe to merge")).toBeLessThan(
      comment.indexOf("<details>"),
    );
  });

  it("names the layers that did not run, rather than implying they passed", async () => {
    const report = await check(await loadConfig(`${FIXTURE}invariant.yaml`));
    const comment = renderComment(report);

    // Without --full the differential and conformance layers never started,
    // and a reader who cannot tell that from a pass has not been told anything.
    expect(comment).toContain("Not run in this release:");
    expect(comment).toContain("The old build and the new build plus adapter agree");
    expect(comment).toContain("What production has reported since");
  });

  it("puts the reason a release is blocked above everything else", async () => {
    const report = await check(await loadConfig(`${FIXTURE}invariant.yaml`));
    const blocked = {
      ...report,
      result: "block" as const,
      problems: [
        'chg_capture_method: /capture_method "auto" is not one of "automatic", "manual"',
      ],
    };

    const comment = renderComment(blocked);
    expect(comment).toContain("## Not safe to merge");
    expect(comment).toContain("1 problem found by running it");
    expect(comment.indexOf("problem found by running it")).toBeLessThan(
      comment.indexOf("<details>"),
    );
    expect(comment).toContain("does not hold when it is actually run");
  });

  it("says what each unexplained kind of delta means, once per kind", async () => {
    const report = await check(await loadConfig(`${FIXTURE}invariant.yaml`));
    const described = [
      "response-property-enum-value-added at GET /v1/payments/{id}: added the new 'refunded' enum value to the 'status' response property",
      "response-property-enum-value-added at GET /v1/payments: added the new 'refunded' enum value to the 'data/items/status' response property",
      "request-property-max-length-decreased at POST /v1/payments: the 'description' request property's maxLength was decreased",
    ];
    const withUnexplained = {
      ...report,
      result: "block" as const,
      steps: report.steps.map((step, index) =>
        index === 0 ? { ...step, unexplained: described } : step,
      ),
    };

    const comment = renderComment(withUnexplained);
    // The deltas themselves, verbatim, since a provider copies them into a
    // behavior Change.
    for (const line of described) expect(comment).toContain(`- ${line}`);
    // And, once per kind, what the catalogue says can be done about it.
    expect(comment.match(/`response-property-enum-value-added`:/g)).toHaveLength(1);
    expect(comment).toContain("`fold`");
    expect(comment).toContain(
      "`request-property-max-length-decreased`: A request field now refuses",
    );
  });

  it("escapes a summary that would otherwise break the table", async () => {
    const report = await check(await loadConfig(`${FIXTURE}invariant.yaml`));
    const withPipe = {
      ...report,
      evidence: [
        {
          ...(report.evidence[0] as (typeof report.evidence)[number]),
          summary: "paid | failed | processing",
        },
      ],
    };

    const comment = renderComment(withPipe);
    expect(comment).toContain("paid \\| failed \\| processing");
  });
});

describe("what callers will notice", () => {
  const changed = (id: string, ops: unknown[]) =>
    ({
      irVersion: 1,
      id,
      summary: `${id} changed something`,
      scopes: [{ schema: "#/components/schemas/Thing" }],
      ops,
    }) as never;

  const reportWith = (changes: unknown[]): CheckReport =>
    ({
      api: "acme",
      current: { label: "2026-09-20", digest: "sha256:abc" },
      steps: [
        {
          from: "2026-01-15",
          to: "2026-09-20",
          changes,
          unexplained: [],
          issues: [],
          stale: [],
          accounted: 0,
          additive: 0,
        },
      ],
      program: undefined,
      warnings: [],
      evidence: [],
      problems: [],
      acknowledged: [],
      unservable: [],
      policy: [],
      result: "pass",
    }) as unknown as CheckReport;

  it("separates what is served, what is lost, and what nothing can serve", () => {
    const comment = renderComment(
      reportWith([
        changed("chg_moved", [{ op: "move", from: "/a", to: "/b" }]),
        changed("chg_relaxed", [{ op: "relax", path: "/price", set: { maximum: null } }]),
        changed("chg_behaviour", [{ op: "behavior", flag: "stricter_limits" }]),
      ]),
    );
    expect(comment).toContain("1 change they will not notice");
    expect(comment).toContain("1 change they carry on through");
    expect(comment).toContain("1 change nothing can serve");
    // The ones worth reading are named; the one that just works is not.
    expect(comment).toContain("`chg_relaxed` (declared loss)");
    expect(comment).toContain("`chg_behaviour` (not served)");
    expect(comment).not.toContain("`chg_moved` (");
  });

  it("names how many callers are still out there, where the service counted them", () => {
    const report = reportWith([
      changed("chg_behaviour", [{ op: "behavior", flag: "stricter_limits" }]),
    ]);
    const comment = renderComment({
      ...report,
      impact: {
        days: 30,
        contracts: [
          {
            label: "2026-01-15",
            consumers: 4,
            requests: 900,
            changes: [],
            retirable: false,
          },
          {
            label: "2025-06-01",
            consumers: 0,
            requests: 0,
            changes: [],
            retirable: true,
          },
        ],
      },
    } as CheckReport);
    expect(comment).toContain("4 consumers on 1 old contract");
    expect(comment).toContain("`2026-01-15`: 4");
    // A contract nobody is on is not worth a reviewer's attention.
    expect(comment).not.toContain("2025-06-01");
  });

  it("says only the good news where everything is served", () => {
    const comment = renderComment(
      reportWith([changed("chg_moved", [{ op: "move", from: "/a", to: "/b" }])]),
    );
    expect(comment).toContain("1 change they will not notice");
    expect(comment).not.toContain("nothing can serve");
  });
});

describe("drafted Changes in the comment", () => {
  const blocked = {
    api: "acme",
    current: { label: "2026-09-20", digest: "sha256:abc" },
    steps: [
      {
        from: "2026-01-15",
        to: "2026-09-20",
        changes: [],
        unexplained: [
          "response-property-removed at GET /v1/payments/{id}: removed the optional property 'currency' from the response",
        ],
        issues: [],
        stale: [],
        accounted: 0,
        additive: 0,
      },
    ],
    program: undefined,
    warnings: [],
    evidence: [],
    problems: [],
    acknowledged: [],
    unservable: [],
    policy: [],
    result: "block",
  } as unknown as CheckReport;

  const draft = (id: string, needsAnswer: boolean) => ({
    id,
    summary: `${id} explains a removed field`,
    path: `invariant/changes/${id}.yaml`,
    file: `/repo/invariant/changes/${id}.yaml`,
    text: `# Drafted by rules.\nirVersion: 1\nid: ${id}\nops:\n  - op: remove\n    path: /currency\n`,
    needsAnswer,
    closeLook: needsAnswer,
  });

  it("offers each draft as a one-click file and as text to copy", () => {
    const comment = renderComment(blocked, {
      suggestions: [draft("chg_currency", false), draft("chg_status", true)],
      newFileUrl: (path, text) =>
        `https://github.com/acme/api/new/feature?filename=${encodeURIComponent(path)}&value=${encodeURIComponent(text)}`,
    });
    expect(comment).toContain("### 2 drafted Changes to explain them");
    expect(comment).toContain(
      "[Add it to this branch](https://github.com/acme/api/new/feature?filename=invariant%2Fchanges%2Fchg_currency.yaml&value=",
    );
    expect(comment).toContain(
      "<summary><code>invariant/changes/chg_status.yaml</code></summary>",
    );
    expect(comment).toContain(
      "```yaml\n# Drafted by rules.\nirVersion: 1\nid: chg_currency",
    );
    // A decision is not a draft to accept as it stands.
    expect(comment).toContain(
      "**`chg_status`**: chg_status explains a removed field **Needs your answer:**",
    );
    // Drafts sit under the deltas they explain, above the proof.
    expect(comment.indexOf("drafted Changes")).toBeGreaterThan(
      comment.indexOf("nothing accounts for"),
    );
  });

  it("still offers the text where no link can be made", () => {
    const comment = renderComment(blocked, {
      suggestions: [draft("chg_currency", false)],
      newFileUrl: () => undefined,
    });
    expect(comment).toContain("### A drafted Change to explain them");
    expect(comment).not.toContain("Add it to this branch");
    expect(comment).toContain("```yaml");
  });

  it("says nothing about drafts when there are none", () => {
    expect(renderComment(blocked)).not.toContain("drafted Change");
  });
});

describe("the new-file link", () => {
  it("opens GitHub's editor on the head branch, and gives up on a file too long to link", () => {
    const link = githubNewFileUrl({
      repository: "contributor/api",
      branch: "feature/new-thing",
    });
    expect(link("invariant/changes/chg_a.yaml", "id: chg_a\n")).toBe(
      "https://github.com/contributor/api/new/feature/new-thing?filename=invariant%2Fchanges%2Fchg_a.yaml&value=id%3A%20chg_a%0A",
    );
    expect(link("invariant/changes/chg_a.yaml", "x".repeat(6500))).toBeUndefined();
  });
});
