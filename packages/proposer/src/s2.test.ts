/**
 * The S2 judge, against a recorded client: what it sends, and how it reads
 * an answer back, including every way an answer can fail to be one.
 */
import { describe, expect, it } from "vitest";
import type { FieldShape } from "./candidates.ts";
import type { AlignmentQuestion, Judge, JudgeResult } from "./judge.ts";
import { EscalatingJudge, type MessagesClient, S2Judge, s2Prompt } from "./s2.ts";

const field = (name: string, extra: Partial<FieldShape> = {}): FieldShape => ({
  name,
  pointer: `/${name}`,
  type: "integer",
  format: undefined,
  enumValues: undefined,
  description: undefined,
  required: false,
  nullable: false,
  ...extra,
});

const question = (candidates = ["amount_cents", "tax"]): AlignmentQuestion => ({
  kind: "alignment",
  schema: "Payment",
  operations: ["post /v1/payments"],
  removed: field("amount", { type: "number", description: "Amount in dollars." }),
  candidates: candidates.map((name) => field(name)),
  context: "Amounts are now in minor units.",
});

type Params = Parameters<MessagesClient["messages"]["create"]>[0];

function recorded(
  answer: (params: Params) => Record<string, unknown> | "throw" | "no-tool",
): { client: MessagesClient; sent: Params[] } {
  const sent: Params[] = [];
  return {
    sent,
    client: {
      messages: {
        async create(params) {
          sent.push(params);
          const input = answer(params);
          if (input === "throw") throw new Error("overloaded");
          return {
            model: params.model,
            content:
              input === "no-tool"
                ? [{ type: "text", text: "I think it is amount_cents." }]
                : [{ type: "tool_use", id: "t1", name: "answer", input }],
            usage: { input_tokens: 1200, output_tokens: 40 },
          };
        },
      },
    },
  };
}

describe("the S2 judge", () => {
  it("names the chosen candidate, and prices what it used", async () => {
    const { client, sent } = recorded(() => ({
      successor: "c1",
      confidence: 0.93,
      stated: true,
    }));
    const judge = new S2Judge({
      client,
      model: "claude-test",
      pricing: { "claude-test": { input: 5, output: 25 } },
    });
    const [result] = await judge.align([question()]);
    expect(result?.answer).toEqual({
      successor: "amount_cents",
      confidence: 0.93,
      scores: { amount_cents: 0.93 },
      stated: true,
      abstained: false,
    });
    expect(result?.judge).toBe("s2");
    expect(result?.inputTokens).toBe(1200);
    expect(result?.costUsd).toBeCloseTo((1200 * 5 + 40 * 25) / 1_000_000);
    // The answer is forced through the tool, and the tool names only the
    // candidates it was given.
    expect(sent[0]?.tool_choice).toEqual({ type: "tool", name: "answer" });
    const schema = sent[0]?.tools[0]?.input_schema as unknown as {
      properties: { successor: { enum: string[] } };
    };
    expect(schema.properties.successor.enum).toEqual(["c1", "c2", "none"]);
  });

  it("answers none as no successor", async () => {
    const { client } = recorded(() => ({
      successor: "none",
      confidence: 0.8,
      stated: false,
    }));
    const [result] = await new S2Judge({ client }).align([question()]);
    expect(result?.answer.successor).toBeNull();
    expect(result?.answer.abstained).toBe(false);
  });

  it("abstains, rather than guessing, on any answer that is not one", async () => {
    for (const reply of [
      { successor: "c9", confidence: 0.9, stated: false },
      { successor: "amount_cents", confidence: 0.9, stated: false },
      { successor: "c1", confidence: 1.4, stated: false },
      { successor: "c1", confidence: 0.9 },
      "no-tool" as const,
      "throw" as const,
    ]) {
      const { client } = recorded(() => reply);
      const [result] = await new S2Judge({ client }).align([question()]);
      expect(result?.answer.abstained, JSON.stringify(reply)).toBe(true);
      expect(result?.answer.successor).toBeNull();
    }
  });

  it("does not ask when there is nothing to choose from", async () => {
    const { client, sent } = recorded(() => ({
      successor: "none",
      confidence: 1,
      stated: false,
    }));
    const [result] = await new S2Judge({ client }).align([question([])]);
    expect(result?.answer.abstained).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("keys candidates opaquely, and tells the model what embedded instructions are", () => {
    const { user, keys } = s2Prompt(question());
    expect([...keys]).toEqual([
      ["c1", "amount_cents"],
      ["c2", "tax"],
    ]);
    const state = JSON.parse(user) as { candidates: Record<string, { name: string }> };
    expect(Object.keys(state.candidates)).toEqual(["c1", "c2"]);
  });

  it("answers every question of a batch, in order, whatever order they finish in", async () => {
    const { client } = recorded((params) => ({
      successor: params.messages[0]?.content.includes(
        '"removed_field": {\n    "name": "b"',
      )
        ? "none"
        : "c1",
      confidence: 0.9,
      stated: false,
    }));
    const questions = ["a", "b", "c"].map((name) => ({
      ...question(),
      removed: field(name),
    }));
    const results = await new S2Judge({ client, concurrency: 2 }).align(questions);
    expect(results.map((result) => result.answer.successor)).toEqual([
      "amount_cents",
      null,
      "amount_cents",
    ]);
  });

  it("changes its fingerprint with the model it runs", () => {
    const { client } = recorded(() => ({}));
    expect(new S2Judge({ client, model: "a" }).fingerprint).not.toBe(
      new S2Judge({ client, model: "b" }).fingerprint,
    );
  });
});

describe("escalating", () => {
  const fixed = (id: Judge["id"], answers: Partial<JudgeResult["answer"]>[]): Judge => ({
    id,
    fingerprint: id,
    async align(questions) {
      return questions.map((_, index) => ({
        answer: {
          successor: "x",
          confidence: 0.99,
          scores: {},
          stated: false,
          abstained: false,
          ...answers[index],
        },
        judge: id,
        model: undefined,
        latencyMs: 0,
        inputTokens: 0,
        costUsd: 0,
      }));
    },
  });

  it("hands on only what the first judge could not settle, and keeps the order", async () => {
    const first = fixed("jev", [{}, { abstained: true }, { confidence: 0.6 }, {}]);
    const asked: number[] = [];
    const then: Judge = {
      id: "s2",
      fingerprint: "s2",
      async align(questions) {
        asked.push(questions.length);
        return fixed("s2", []).align(questions);
      },
    };
    const results = await new EscalatingJudge(first, then, { threshold: 0.9 }).align(
      [1, 2, 3, 4].map(() => question()),
    );
    expect(asked).toEqual([2]);
    expect(results.map((result) => result.judge)).toEqual(["jev", "s2", "s2", "jev"]);
  });
});
