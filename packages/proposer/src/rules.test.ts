/**
 * The deterministic judge, and the one thing it must never do.
 *
 * Its contract is not "be useful". It is "be right about whatever you speak to,
 * and say nothing otherwise", because everything downstream treats its answers
 * as settled and skips the model entirely. A confidently wrong answer here is
 * the most expensive kind in the system.
 *
 * Every case below is one the judge got wrong at full confidence before the
 * suffix table was split apart. They came out of the evaluation corpus, which
 * is what the corpus is for.
 */
import { describe, expect, it } from "vitest";
import type { FieldShape } from "./candidates.ts";
import { RulesJudge } from "./rules.ts";

function field(name: string, overrides: Partial<FieldShape> = {}): FieldShape {
  return {
    name,
    pointer: `/${name}`,
    type: "integer",
    format: undefined,
    enumValues: undefined,
    description: undefined,
    required: true,
    nullable: false,
    ...overrides,
  };
}

async function ask(
  removed: string,
  candidates: string[],
  descriptions: Record<string, string> = {},
) {
  const describe_ = (name: string) =>
    descriptions[name] === undefined ? {} : { description: descriptions[name] };

  const [result] = await new RulesJudge().align([
    {
      kind: "alignment",
      schema: "Probe",
      operations: ["probe.create request"],
      removed: field(removed, describe_(removed)),
      candidates: candidates.map((name) => field(name, describe_(name))),
    },
  ]);
  return result?.answer;
}

describe("the rules judge", () => {
  it("settles a plain unit re-encoding", async () => {
    const answer = await ask("amount", ["amount_cents", "currency"]);

    expect(answer?.abstained).toBe(false);
    expect(answer?.successor).toBe("amount_cents");
  });

  it("knows a field that kept its name", async () => {
    // The original version of this bug: a timestamp suffix outranked the field
    // simply still being there.
    const answer = await ask("reading", ["reading_at", "reading"]);

    expect(answer?.successor).toBe("reading");
    expect(answer?.confidence).toBe(1);
  });

  /**
   * A timestamp of a thing is not the thing.
   *
   * `seats` is a count and `seats_at` is a time. Stripping `_at` to make the
   * names match produced a perfect stem match and an answer at full
   * confidence, for a pair that are not the same field at all.
   */
  it("does not mistake a timestamp for what it is a timestamp of", async () => {
    const answer = await ask("seats", ["seats_at", "seat_count"]);
    expect(answer?.abstained).toBe(true);
  });

  it("does not mistake an identifier for what it identifies", async () => {
    const answer = await ask("customer", ["customer_id", "account"]);
    expect(answer?.abstained).toBe(true);
  });

  /**
   * Two candidates extending the same name cannot be told apart by morphology.
   *
   * `lag` beside `lag_seconds` and `lag_messages` could be a duration or a
   * count. The only reason to prefer the first is that this judge recognises
   * `seconds` as a unit, which is a fact about its own suffix table rather
   * than about the API being described.
   */
  it("abstains when several candidates extend the removed name", async () => {
    const answer = await ask("lag", ["lag_seconds", "lag_messages"]);
    expect(answer?.abstained).toBe(true);
  });

  it("uses the description when a suffix alone would not be enough", async () => {
    const same = "When the payment was created, as a Unix timestamp.";
    const answer = await ask("created", ["created_at", "updated_at"], {
      created: same,
      created_at: same,
    });

    // The same sentence describing both is evidence about meaning rather than
    // spelling, and it is what separates this from `seats` and `seats_at`.
    expect(answer?.abstained).toBe(false);
    expect(answer?.successor).toBe("created_at");
  });

  it("will not take a timestamp suffix on its own as a match", async () => {
    // The same names, with nobody having said the two mean the same thing.
    const answer = await ask("created", ["created_at", "updated_at"]);
    expect(answer?.abstained).toBe(true);
  });

  it("abstains when nothing resembles the removed field", async () => {
    const answer = await ask("tax_rate", ["shipping_method", "carrier"]);
    expect(answer?.abstained).toBe(true);
  });

  it("abstains rather than choose between two equally close names", async () => {
    const answer = await ask("total", ["subtotal", "grand_total"]);
    expect(answer?.abstained).toBe(true);
  });
});
