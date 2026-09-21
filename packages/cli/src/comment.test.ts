/**
 * The pull request comment.
 *
 * What is tested here is mostly what the comment refuses to do: claim a layer
 * ran when it did not, and bury the reason a release is blocked underneath the
 * evidence that everything else was fine.
 */
import { oasdiffAvailable } from "@invariant/diff";
import { describe, expect, it } from "vitest";
import { check } from "./check.ts";
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
