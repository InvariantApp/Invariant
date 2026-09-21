/**
 * Why a release is blocked, said accurately.
 *
 * A gate that misdiagnoses is worse than one that only says no, because it
 * sends a provider to read the wrong files. The case this exists for is a
 * stale specification: the code is unchanged and correct, the document is
 * wrong, and nobody's integration is in any danger. Reporting that as
 * "something would break an old caller" is a lie about their service, and for
 * a provider whose OpenAPI is generated it is the likeliest first thing this
 * tool will ever tell them.
 */
import type { Evidence } from "@invariant/verifier";
import { describe, expect, it } from "vitest";
import { type CheckReport, renderReport } from "./check.ts";

function evidence(kind: Evidence["kind"], result: Evidence["result"]): Evidence {
  return {
    kind,
    subject: "2026-09-20",
    result,
    inputsDigest: "sha256:test",
    tool: "test",
    summary: "test",
  };
}

function report(overrides: Partial<CheckReport> = {}): CheckReport {
  return {
    api: "acme-payments",
    current: { label: "2026-09-20", digest: "sha256:head" },
    steps: [
      {
        from: "2026-03-01",
        to: "2026-09-20",
        changes: [],
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
    result: "block",
    ...overrides,
  };
}

describe("why a release is blocked", () => {
  it("says the Changes do not explain it when that is what happened", () => {
    const rendered = renderReport(
      report({
        steps: [
          {
            from: "2026-03-01",
            to: "2026-09-20",
            changes: [],
            unexplained: [
              "response-required-property-removed at POST /v1/payments: `amount`",
            ],
            issues: [],
            stale: [],
            accounted: 0,
            additive: 0,
          },
        ],
      }),
    );

    expect(rendered).toContain("the declared Changes do not fully explain this release");
  });

  /**
   * The one that was wrong. Closure passed, every Change held, and the only
   * failing layer was conformance: the document does not describe the service.
   * Nothing about compatibility was disproved, and saying otherwise would send
   * the provider to audit Change files that are fine.
   */
  it("does not claim an old caller would break when only the spec drifted", () => {
    const rendered = renderReport(
      report({
        evidence: [
          evidence("E2-closure", "pass"),
          evidence("E4-laws", "pass"),
          evidence("E7-conformance", "fail"),
        ],
        problems: [
          "create, retrieve and list a payment / create: the 201 from payments.create " +
            "does not match the contract - / required field settled_at is missing",
        ],
      }),
    );

    expect(rendered).toContain(
      "the specification does not describe the code that is running",
    );
    expect(rendered).toContain("Nothing here says an old caller would break");
    expect(rendered).not.toContain("would break an old caller.");

    // And it has to say what to do, differently for the two ways a
    // specification comes to exist.
    expect(rendered).toContain("regenerate it");
    expect(rendered).toContain("written by hand");
  });

  it("still blames compatibility when a Change genuinely failed to hold", () => {
    const rendered = renderReport(
      report({
        evidence: [evidence("E4-laws", "fail"), evidence("E7-conformance", "pass")],
        problems: ["chg_money_in_minor_units broke its round trip on 0.005"],
      }),
    );

    expect(rendered).toContain("would break an old caller");
    expect(rendered).not.toContain("the specification does not describe");
  });

  /**
   * Drift alongside a real compatibility failure is not a drift report. The
   * spec being wrong does not excuse the Change that broke, and offering
   * "regenerate your spec" as the fix would bury the more serious of the two.
   */
  it("does not soften a compatibility failure that arrives with drift", () => {
    const rendered = renderReport(
      report({
        evidence: [evidence("E4-laws", "fail"), evidence("E7-conformance", "fail")],
      }),
    );

    expect(rendered).toContain("would break an old caller");
    expect(rendered).not.toContain("the specification does not describe");
  });

  it("names a stale behavior claim as a Changes problem, not a verification one", () => {
    const rendered = renderReport(
      report({
        steps: [
          {
            from: "2026-03-01",
            to: "2026-09-20",
            changes: [],
            unexplained: [],
            issues: [],
            stale: ["request-property-removed at POST /v1/payments: `nickname`"],
            accounted: 0,
            additive: 0,
          },
        ],
        evidence: [evidence("E7-conformance", "fail")],
      }),
    );

    expect(rendered).toContain("the declared Changes do not fully explain this release");
  });
});
