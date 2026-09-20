/**
 * E9, the only evidence in this system that is an observation.
 *
 * Everything else is produced before anything is deployed, which makes it all
 * prediction. This is the layer that can say the predictions held, and the two
 * ways it could be useless are both worth pinning down: reporting a count with
 * no denominator, which nobody can act on, and reporting silence as health,
 * which is how a sink that was never wired up reads as a clean bill.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  health,
  type OutcomeRecord,
  outcomeEvidence,
  RESPONSE_FAILURE_SLO,
  readOutcomes,
} from "./outcomes.ts";

let scratch: string | undefined;

afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function record(over: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    contract: "2026-01-15",
    operation: "post /v1/payments",
    direction: "response",
    outcome: "adapted",
    count: 1,
    ...over,
  };
}

describe("what production reported", () => {
  it("reports a rate, not a count", () => {
    const [evidence] = outcomeEvidence(
      ["2026-01-15"],
      [
        record({ outcome: "adapted", count: 9_999 }),
        record({ outcome: "failed", count: 1 }),
      ],
    );

    // 1 in 10,000 is exactly the objective, so it holds. What matters is that
    // the denominator is there at all: the same single failure out of twenty
    // is an emergency, and a bare "1 failed" cannot tell the two apart.
    expect(evidence?.result).toBe("pass");
    expect(evidence?.summary).toContain("9999 responses");
    expect(evidence?.summary).toContain("1 responses failed");
  });

  it("fails when response failures pass the objective", () => {
    const [evidence] = outcomeEvidence(
      ["2026-01-15"],
      [
        record({ outcome: "adapted", count: 1_000 }),
        record({ outcome: "failed", count: 1 }),
      ],
    );

    expect(1 / 1001 > RESPONSE_FAILURE_SLO).toBe(true);
    expect(evidence?.result).toBe("fail");
    // And it has to say what it actually cost, because a response failure is
    // not a retry. The work was done and the caller got an error for it.
    expect(evidence?.detail?.join(" ")).toContain("had already run");
  });

  /**
   * The failure that would make this evidence worse than none.
   *
   * A provider who never wired up the sink, and a contract nobody calls any
   * more, produce exactly the same file: an empty one. Reporting that as a
   * pass would put a clean bill of health in a bundle on the strength of
   * having looked at nothing.
   */
  it("does not read silence as health", () => {
    const [evidence] = outcomeEvidence(["2026-01-15"], []);

    expect(evidence?.result).toBe("skipped");
    expect(evidence?.result).not.toBe("pass");
    expect(evidence?.summary).toContain("cannot tell which");
  });

  /**
   * The mirror of the one above, and a bug this test found.
   *
   * A contract where every single request was refused has zero successes, and
   * an earlier version treated that as having heard nothing. It is the loudest
   * thing this file can say: it is what a global kill switch left on by
   * accident looks like, and reporting it as silence is how that goes unnoticed
   * for a week.
   */
  it("does not read total refusal as silence", () => {
    const [evidence] = outcomeEvidence(
      ["2026-01-15"],
      [
        record({
          direction: "request",
          outcome: "refused",
          count: 4_000,
          reason: "UnsupportedContractError",
        }),
      ],
    );

    expect(evidence?.result).not.toBe("skipped");
    expect(evidence?.summary).toContain("4000 requests refused");
  });

  it("separates a refused request from a failed response", () => {
    const [evidence] = outcomeEvidence(
      ["2026-01-15"],
      [
        record({ direction: "request", outcome: "adapted", count: 50 }),
        record({
          direction: "request",
          outcome: "refused",
          count: 7,
          reason: "UnsupportedContractError",
        }),
        record({ outcome: "adapted", count: 50 }),
      ],
    );

    // No response failed, so nothing breached: a refused request cost a retry,
    // not a side effect. But seven callers were turned away, which is how a
    // kill switch left on by accident looks, so it is still reported.
    expect(evidence?.result).toBe("pass");
    expect(evidence?.summary).toContain("7 requests refused");
    expect(evidence?.detail?.join(" ")).toContain("UnsupportedContractError");
  });

  it("keeps each contract's health separate", () => {
    const rows = health([
      record({ contract: "2026-01-15", outcome: "failed", count: 3 }),
      record({ contract: "2026-03-01", outcome: "adapted", count: 4 }),
    ]);

    expect(rows.map((row) => row.contract)).toEqual(["2026-01-15", "2026-03-01"]);
    expect(rows[0]?.responsesFailed).toBe(3);
    expect(rows[1]?.responsesFailed).toBe(0);
  });

  it("reads a ledger whose last line was half written", async () => {
    scratch = await mkdtemp(join(tmpdir(), "invariant-outcomes-"));
    const path = join(scratch, "outcomes.jsonl");
    await writeFile(
      path,
      `${JSON.stringify(record({ count: 5 }))}\n{"contract":"2026-01-15","opera`,
      "utf8",
    );

    // A file being appended to by a running service. Throwing away every
    // observation over one truncated line would be the wrong trade by far.
    const records = await readOutcomes(path);
    expect(records).toHaveLength(1);
    expect(records[0]?.count).toBe(5);
  });

  it("returns nothing at all when there is no ledger", async () => {
    expect(await readOutcomes("/nonexistent/outcomes.jsonl")).toEqual([]);
  });
});
