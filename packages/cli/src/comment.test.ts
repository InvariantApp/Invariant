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
