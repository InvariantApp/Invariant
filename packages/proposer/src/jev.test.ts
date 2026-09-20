/**
 * The difference between an outage and a misconfiguration.
 *
 * A request that fails should abstain: an outage must not be read as the model
 * saying "no successor", and the pipeline has a next stage for exactly that.
 * A client that cannot be built is not an outage, it is a missing credential,
 * and abstaining on it produces a whole run of rules-only numbers wearing the
 * hybrid judge's name.
 *
 * That happened. A run over 686 real pairs reported identical totals with and
 * without the model because the key never reached it, and nothing in the run
 * said so. A stale pass is worse than no result, which is the same reason the
 * evaluation cache is keyed on each judge's fingerprint.
 */
import { describe, expect, it } from "vitest";
import { JevJudge } from "./jev.ts";
import type { AlignmentQuestion } from "./judge.ts";

function question(): AlignmentQuestion {
  const field = (name: string) => ({
    name,
    pointer: `/${name}`,
    type: "string",
    format: undefined,
    enumValues: undefined,
    description: undefined,
    required: true,
    nullable: false,
  });
  return {
    kind: "alignment",
    schema: "#/components/schemas/Thing",
    operations: ["things.create"],
    removed: field("amount"),
    candidates: [field("amount_cents")],
  } as AlignmentQuestion;
}

describe("telling an outage apart from a misconfiguration", () => {
  it("abstains when a request fails, rather than answering no", async () => {
    const judge = new JevJudge({
      client: {
        systemOne: () => Promise.reject(new Error("503 from upstream")),
      } as never,
    });

    const [result] = await judge.align([question()]);
    expect(result?.answer.abstained).toBe(true);
    // Abstaining is not the same as deciding there is no successor: the
    // pipeline must be free to ask someone else.
    expect(result?.answer.successor).toBe(null);
  });

  it("refuses to run at all when the client cannot be built", async () => {
    const judge = new JevJudge({
      get client(): never {
        throw new Error("TYPESAFE_API_KEY is not set");
      },
    } as never);

    // Loudly, because the alternative is a report of rules-only numbers
    // labelled as though the model had been asked.
    await expect(judge.align([question()])).rejects.toThrow(/TYPESAFE_API_KEY/);
  });
});
