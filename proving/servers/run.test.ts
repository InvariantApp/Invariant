import { describe, expect, it } from "vitest";
import {
  combineRuns,
  compareArms,
  expand,
  type PairResult,
  readJunit,
  render,
  tally,
  verdict,
} from "./pairs.ts";

describe("reading a JUnit report", () => {
  it("tells passed, failed, errored and skipped cases apart, and keeps what a failure said", () => {
    const xml = `<?xml version="1.0"?><testsuites><testsuite name="pytest">
      <testcase classname="openapi.test_alias" name="test_create" time="0.1" />
      <testcase classname="openapi.test_alias" name="test_rename" time="0.1"><failure message="assert &quot;a&quot; == 1">trace</failure></testcase>
      <testcase classname="openapi.test_query" name="test_x[True]" time="0.1"><error message="setup">trace</error></testcase>
      <testcase classname="openapi.test_query" name="test_y" time="0"><skipped message="no" /></testcase>
      <testcase classname="gitea" name="TestIssue" time="0"><failure message="Failed" type="">issue_test.go:40:&#xA;&#x9;expected 1</failure></testcase>
    </testsuite></testsuites>`;
    expect(readJunit(xml)).toEqual({
      outcomes: {
        "openapi.test_alias::test_create": "passed",
        "openapi.test_alias::test_rename": "failed",
        "openapi.test_query::test_x[True]": "failed",
        "openapi.test_query::test_y": "skipped",
        "gitea::TestIssue": "failed",
      },
      messages: {
        "openapi.test_alias::test_rename": 'assert "a" == 1',
        "openapi.test_query::test_x[True]": "setup",
        "gitea::TestIssue": "issue_test.go:40:\n\texpected 1",
      },
    });
  });
});

describe("filling in a manifest's placeholders", () => {
  it("fills every name it is given, underscores and digits included, and leaves the rest", () => {
    // Meilisearch was started with the key "{MEILI_KEY}" when names could
    // only be letters, and every test was refused.
    expect(
      expand("Token {NETBOX_TOKEN} for {url} at {port2}, not {missing}", {
        NETBOX_TOKEN: "abc",
        url: "http://127.0.0.1:1",
        port2: "2",
      }),
    ).toBe("Token abc for http://127.0.0.1:1 at 2, not {missing}");
  });
});

describe("comparing the three arms", () => {
  it("counts only tests the old server passed, and finds what the adapter broke", () => {
    const arms = {
      a: {
        outcomes: { t1: "passed", t2: "passed", t3: "passed", t4: "failed" } as const,
      },
      b: {
        outcomes: { t1: "passed", t2: "failed", t3: "failed", t4: "failed" } as const,
      },
      c: {
        outcomes: { t1: "failed", t2: "passed", t3: "failed", t4: "passed" } as const,
      },
    };
    expect(compareArms(arms)).toEqual({
      valid: 3,
      broken: ["t2", "t3"],
      served: ["t2"],
      regressions: ["t1"],
    });
  });

  it("counts no regression against an arm that never ran", () => {
    const arms = {
      a: { outcomes: { t1: "passed", t2: "passed" } as const },
      b: { outcomes: { t1: "passed", t2: "failed" } as const },
      c: { outcomes: {}, error: "the gate blocks the release" },
    };
    expect(compareArms(arms)).toEqual({
      valid: 2,
      broken: ["t2"],
      served: [],
      regressions: [],
    });
  });
});

describe("running an arm more than once", () => {
  // Immich's library scan test waits on a job that makes thumbnails, and
  // failed through the proxy once and passed the next time, against the same
  // server: a serving that depended on the run, not on the adapter.
  it("keeps what every run agreed on and sets aside what they did not", () => {
    const combined = combineRuns([
      { outcomes: { t1: "passed", t2: "failed", t3: "passed" }, messages: { t2: "no" } },
      {
        outcomes: { t1: "passed", t2: "failed", t3: "failed" },
        messages: { t2: "no", t3: "late" },
      },
    ]);
    expect(combined).toEqual({
      outcomes: { t1: "passed", t2: "failed", t3: "failed" },
      messages: { t2: "no", t3: "late" },
      volatile: ["t3"],
    });
  });

  it("is an arm that did not run when any run of it did not", () => {
    expect(
      combineRuns([{ outcomes: { t1: "passed" } }, { outcomes: {}, error: "no server" }]),
    ).toEqual({ outcomes: {}, error: "no server" });
  });

  it("leaves a volatile test out of every count, whichever arm it wavered in", () => {
    const arms = {
      a: { outcomes: { t1: "passed", t2: "passed", t3: "passed" } as const },
      b: { outcomes: { t1: "failed", t2: "failed", t3: "passed" } as const },
      c: {
        outcomes: { t1: "passed", t2: "failed", t3: "failed" } as const,
        volatile: ["t2", "t3"],
      },
    };
    expect(compareArms(arms)).toEqual({
      valid: 1,
      broken: ["t1"],
      served: ["t1"],
      regressions: [],
      volatile: ["t2", "t3"],
    });
  });
});

function pair(
  project: string,
  language: string,
  outcomes: { a: string[]; b: string[]; c: string[] },
): PairResult {
  const arm = (passed: string[]) => ({
    outcomes: Object.fromEntries(
      ["t1", "t2", "t3"].map((id) => [id, passed.includes(id) ? "passed" : "failed"]),
    ) as PairResult["arms"]["a"]["outcomes"],
  });
  const arms = { a: arm(outcomes.a), b: arm(outcomes.b), c: arm(outcomes.c) };
  return {
    project,
    language,
    from: "1",
    to: "2",
    changes: 1,
    gate: {
      changesFrom: "recorded",
      drafted: 0,
      result: "pass",
      unexplained: [],
      unservable: [],
      accounted: 0,
    },
    arms,
    ...compareArms(arms),
  };
}

describe("what the pairs prove", () => {
  const served = pair("gitea", "Go", {
    a: ["t1", "t2"],
    b: ["t1"],
    c: ["t1", "t2"],
  });
  const unserved = pair("netbox", "Python", {
    a: ["t1", "t2"],
    b: ["t1"],
    c: ["t1"],
  });
  const vacuous = pair("qdrant", "Rust", {
    a: ["t1", "t2"],
    b: ["t1", "t2"],
    c: ["t1", "t2"],
  });

  it("calls a pair whose release broke nothing vacuous, whatever the adapter did", () => {
    expect(verdict(served)).toBe("served");
    expect(verdict(unserved)).toBe("unserved");
    expect(verdict(vacuous)).toBe("vacuous");
  });

  it("counts a project once one of its breaking releases is served in full", () => {
    const another = pair("gitea", "Go", { a: ["t1", "t2"], b: [], c: ["t1"] });
    expect(tally([served, another, unserved, vacuous])).toEqual({
      proven: ["gitea"],
      languages: ["Go"],
      breaking: 3,
      servedPairs: 1,
      broken: 4,
      served: 2,
      regressions: 0,
      vacuous: 1,
      volatile: 0,
    });
  });

  it("reports every pair, the skipped projects and why a broken test is unserved", () => {
    const text = render(
      [
        {
          ...unserved,
          arms: {
            ...unserved.arms,
            c: { ...unserved.arms.c, messages: { t2: "KeyError: 'name'\nmore" } },
          },
        },
      ],
      [{ name: "keycloak", language: "Java", reason: "no suite runs black-box" }],
    );
    expect(text).toContain(
      "0 projects proven in 0 languages; 0 of 1 breaking release pair served in full, 0 of 1 broken test, 0 regressions.",
    );
    expect(text).toContain("| keycloak | Java | no suite runs black-box |");
    expect(text).toContain("- `t2`: KeyError: 'name'");
  });

  it("says what a Go test compared, where it opens with the line it failed on", () => {
    const text = render([
      {
        ...unserved,
        arms: {
          ...unserved.arms,
          c: {
            ...unserved.arms.c,
            messages: {
              t2: '=== RUN   TestCommitStatus\n    status_test.go:64:\n        \tError Trace:\tstatus_test.go:64\n        \tError:      \tNot equal:\n        \t            \texpected: "warning"\n        \t            \tactual  : "success"',
            },
          },
        },
      },
    ]);
    expect(text).toContain('- `t2`: expected "warning", got "success"');
  });
});
