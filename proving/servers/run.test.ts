import { describe, expect, it } from "vitest";
import { compareArms, readJunit } from "./run.mts";

describe("reading a JUnit report", () => {
  it("tells passed, failed, errored and skipped cases apart", () => {
    const xml = `<?xml version="1.0"?><testsuites><testsuite name="pytest">
      <testcase classname="openapi.test_alias" name="test_create" time="0.1" />
      <testcase classname="openapi.test_alias" name="test_rename" time="0.1"><failure message="boom">trace</failure></testcase>
      <testcase classname="openapi.test_query" name="test_x[True]" time="0.1"><error message="setup">trace</error></testcase>
      <testcase classname="openapi.test_query" name="test_y" time="0"><skipped message="no" /></testcase>
    </testsuite></testsuites>`;
    expect(readJunit(xml)).toEqual({
      "openapi.test_alias::test_create": "passed",
      "openapi.test_alias::test_rename": "failed",
      "openapi.test_query::test_x[True]": "failed",
      "openapi.test_query::test_y": "skipped",
    });
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
});
