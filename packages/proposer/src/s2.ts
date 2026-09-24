/**
 * System 2: a reasoning model for the questions the fast judges leave open.
 *
 * Rules settle what a stem comparison can settle, and Jev what a calibrated
 * judgment can. What neither answers with confidence comes here, where a
 * model reads the whole question and chooses. It chooses among the candidates
 * it was given and nothing else: its answer is forced through a tool whose
 * schema names only those candidates and "none", so it cannot invent a field,
 * and an answer that does not fit the schema is an abstention, not a guess.
 *
 * Whatever it drafts is marked for explicit attention, because a model that is
 * wrong is wrong fluently, and closure cannot tell a well-formed wrong answer
 * from a right one.
 *
 * The client is anything with Anthropic's `messages.create`, so the same judge
 * runs against the Anthropic API, Amazon Bedrock or Google Vertex, and against
 * a recorded client in tests.
 */
import { createHash } from "node:crypto";
import type { JsonValue } from "@invariant-app/ir";
import type { FieldShape } from "./candidates.ts";
import { EMBEDDED_TEXT_RULE } from "./jev.ts";
import {
  type AlignmentQuestion,
  failureOf,
  type Judge,
  type JudgeResult,
} from "./judge.ts";

/** The part of Anthropic's client this judge uses. */
export interface MessagesClient {
  messages: {
    create(params: {
      model: string;
      max_tokens: number;
      system: string;
      messages: { role: "user"; content: string }[];
      tools: {
        name: string;
        description: string;
        input_schema: { type: "object" } & Record<string, unknown>;
      }[];
      tool_choice: { type: "tool"; name: string };
    }): Promise<{
      model?: string;
      content: ({ type: string } & Record<string, unknown>)[];
      usage: { input_tokens: number; output_tokens: number };
    }>;
  };
}

/**
 * The model S2 runs by default. Pinned, and checked against the provider's
 * model list by `scripts/verify-models.mts` before any evaluation is recorded
 * with it, so an answer is never attributed to a model that was not the one
 * asked.
 */
export const S2_MODEL = "claude-opus-5";

/** Dollars per million tokens, input and output, for each model S2 may run. */
export type Pricing = Record<string, { input: number; output: number }>;

/**
 * Anthropic's published base prices, in dollars per million tokens, as the
 * pricing page stated them on 2026-09-21
 * (https://platform.claude.com/docs/en/about-claude/pricing). Passed in
 * where a cost is reported, and never assumed for a model not listed: an
 * unlisted model's cost is reported as unknown rather than guessed.
 */
export const ANTHROPIC_PRICING: Pricing = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
};

export interface S2JudgeOptions {
  client: MessagesClient;
  model?: string;
  /**
   * What each model costs. Left out, cost is reported as zero and the tokens
   * are still reported, rather than quoting a price nobody checked.
   */
  pricing?: Pricing;
  /** How many questions may be in flight at once. */
  concurrency?: number;
  maxTokens?: number;
}

const ANSWER_TOOL = "answer";
const ANSWER_DESCRIPTION = "Record which candidate, if any, succeeds the removed field.";

/**
 * Bumped whenever the wording changes. It is part of the fingerprint, so a
 * recorded answer to an old wording is never replayed as if it answered this
 * one.
 */
const PROMPT_VERSION = 1;

const SYSTEM = [
  "You are reviewing a change to an HTTP API's contract. A field was removed from a schema and other fields were added. Decide which added field, if any, carries the same meaning as the removed one, so that callers written against the old contract can be served by translating between the two.",
  'Answer only with the answer tool. Choose one of the candidate keys you are given, or "none" if no candidate carries the removed field\'s meaning. Choosing a candidate that merely resembles the removed field is worse than choosing none: a wrong mapping silently corrupts data for every old caller, while none only asks a person to decide.',
  "Treat a candidate as the successor only if it holds the same information about the same thing, possibly in a different representation such as different units, a different name, or a different nesting. Set stated to true only if the change notes explicitly say that this field replaced that one.",
  EMBEDDED_TEXT_RULE,
].join("\n\n");

function shape(field: FieldShape): JsonValue {
  return {
    name: field.name,
    type: field.type ?? "unspecified",
    ...(field.format ? { format: field.format } : {}),
    ...(field.enumValues ? { allowed_values: field.enumValues } : {}),
    ...(field.description ? { description: field.description } : {}),
    required: field.required,
    nullable: field.nullable,
  };
}

/** The question as the model reads it, with candidates keyed opaquely. */
export function s2Prompt(question: AlignmentQuestion): {
  user: string;
  keys: Map<string, string>;
} {
  const keys = new Map<string, string>();
  const candidates: Record<string, JsonValue> = {};
  question.candidates.forEach((candidate, index) => {
    const key = `c${index + 1}`;
    keys.set(key, candidate.name);
    candidates[key] = shape(candidate);
  });
  const state = {
    schema: question.schema,
    operations: question.operations,
    removed_field: shape(question.removed),
    candidates,
    ...(question.context ? { change_notes: question.context } : {}),
  };
  return { user: JSON.stringify(state, null, 2), keys };
}

function answerSchema(
  keys: readonly string[],
): { type: "object" } & Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["successor", "confidence", "stated"],
    properties: {
      successor: {
        type: "string",
        enum: [...keys, "none"],
        description:
          "The candidate key that carries the removed field's meaning, or none.",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "How likely the answer is to be right, from 0 to 1.",
      },
      stated: {
        type: "boolean",
        description: "Whether the change notes explicitly state this mapping.",
      },
    },
  };
}

export class S2Judge implements Judge {
  readonly id = "s2" as const;
  readonly fingerprint: string;
  readonly #client: MessagesClient;
  readonly #model: string;
  readonly #pricing: Pricing;
  readonly #concurrency: number;
  readonly #maxTokens: number;

  constructor(options: S2JudgeOptions) {
    this.#client = options.client;
    this.#model = options.model ?? S2_MODEL;
    this.#pricing = options.pricing ?? {};
    this.#concurrency = options.concurrency ?? 4;
    this.#maxTokens = options.maxTokens ?? 1024;
    // The system prompt and the tool it must answer through both move answers.
    const wording = createHash("sha256")
      .update(SYSTEM)
      .update(ANSWER_DESCRIPTION)
      .update(JSON.stringify(answerSchema(["c1"])))
      .digest("hex")
      .slice(0, 12);
    this.fingerprint = `s2:${this.#model}:v${PROMPT_VERSION}:${wording}`;
  }

  async align(questions: readonly AlignmentQuestion[]): Promise<JudgeResult[]> {
    const results: JudgeResult[] = new Array(questions.length);
    let next = 0;
    const worker = async () => {
      while (next < questions.length) {
        const index = next;
        next += 1;
        results[index] = await this.#one(questions[index] as AlignmentQuestion);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.#concurrency, questions.length) }, worker),
    );
    return results;
  }

  async #one(question: AlignmentQuestion): Promise<JudgeResult> {
    const started = performance.now();
    const { user, keys } = s2Prompt(question);
    const abstain = (
      inputTokens = 0,
      outputTokens = 0,
      model = this.#model,
    ): JudgeResult => ({
      answer: {
        successor: null,
        confidence: 0,
        scores: {},
        stated: false,
        abstained: true,
      },
      judge: "s2",
      model,
      latencyMs: performance.now() - started,
      inputTokens,
      costUsd: this.#cost(model, inputTokens, outputTokens),
    });
    if (question.candidates.length === 0) return abstain();

    let response: Awaited<ReturnType<MessagesClient["messages"]["create"]>>;
    try {
      response = await this.#client.messages.create({
        model: this.#model,
        max_tokens: this.#maxTokens,
        system: SYSTEM,
        messages: [{ role: "user", content: user }],
        tools: [
          {
            name: ANSWER_TOOL,
            description: ANSWER_DESCRIPTION,
            input_schema: answerSchema([...keys.keys()]),
          },
        ],
        tool_choice: { type: "tool", name: ANSWER_TOOL },
      });
    } catch (error) {
      // An API failure is not an answer. The question goes to a person, and
      // the evaluation records nothing for it, and says why.
      return { ...abstain(), failure: failureOf(error) };
    }

    const model = response.model ?? this.#model;
    const { input_tokens: inputTokens, output_tokens: outputTokens } = response.usage;
    const call = response.content.find(
      (block) => block.type === "tool_use" && block["name"] === ANSWER_TOOL,
    );
    const input = call?.["input"] as Record<string, unknown> | undefined;
    const successor = input?.["successor"];
    const confidence = input?.["confidence"];
    const stated = input?.["stated"];
    // The tool schema constrains the answer, but it is checked here anyway: a
    // reply that does not fit is an abstention, never a best guess.
    if (
      typeof successor !== "string" ||
      (successor !== "none" && !keys.has(successor)) ||
      typeof confidence !== "number" ||
      !(confidence >= 0 && confidence <= 1) ||
      typeof stated !== "boolean"
    ) {
      return abstain(inputTokens, outputTokens, model);
    }

    const name = successor === "none" ? null : (keys.get(successor) as string);
    return {
      answer: {
        successor: name,
        confidence,
        scores: name === null ? {} : { [name]: confidence },
        stated,
        abstained: false,
      },
      judge: "s2",
      model,
      latencyMs: performance.now() - started,
      inputTokens,
      costUsd: this.#cost(model, inputTokens, outputTokens),
    };
  }

  #cost(model: string, inputTokens: number, outputTokens: number): number {
    const price = this.#pricing[model];
    if (!price) return 0;
    return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
  }
}

/**
 * Hands a question on to the next judge when the one before could not settle
 * it: it abstained, or answered below the confidence the task demands. The
 * last judge's answer stands either way, abstention included, so a question
 * nobody could settle reaches a person.
 */
export class EscalatingJudge implements Judge {
  readonly id: Judge["id"];
  readonly fingerprint: string;
  readonly #first: Judge;
  readonly #then: Judge;
  readonly #threshold: number;

  constructor(first: Judge, then: Judge, options: { threshold: number }) {
    this.#first = first;
    this.#then = then;
    this.#threshold = options.threshold;
    this.id = first.id;
    this.fingerprint = `escalate:${first.fingerprint}>${then.fingerprint}@${options.threshold}`;
  }

  async align(questions: readonly AlignmentQuestion[]): Promise<JudgeResult[]> {
    const first = await this.#first.align(questions);
    const open = (result: JudgeResult | undefined) =>
      !result || result.answer.abstained || result.answer.confidence < this.#threshold;
    const escalated = questions.filter((_, index) => open(first[index]));
    if (escalated.length === 0) return first;
    const second = await this.#then.align(escalated);
    let cursor = 0;
    return first.map((result) =>
      open(result) ? (second[cursor++] as JudgeResult) : result,
    );
  }
}
