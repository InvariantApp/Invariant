/**
 * Analyses exactly one pair and prints the result as one line of JSON.
 *
 * It exists so that a single pathological pair cannot end the run. The differ
 * is a Go subprocess whose appetite tracks the size of the difference, and two
 * real Stripe specifications a month apart wanted more than three gigabytes.
 * In one process that is the run gone, and on a small machine it is the
 * machine gone. In its own process it is one line saying so.
 */
import { analysePair } from "@invariant/eval";
import type { AlignmentQuestion, Judge, JudgeResult } from "@invariant/proposer";
import { HybridJudge, JevJudge, RulesJudge } from "@invariant/proposer";

/**
 * Counts what would be asked and answers nothing.
 *
 * Running a model across a corpus this size is worth knowing the price of
 * before paying it. Same pipeline, same questions, no requests.
 */
class CountingJudge implements Judge {
  readonly id = "rules" as const;
  readonly fingerprint = "counting:v1";
  asked = 0;

  align(questions: readonly AlignmentQuestion[]): Promise<JudgeResult[]> {
    this.asked += questions.length;
    return Promise.resolve(
      questions.map(() => ({
        answer: {
          successor: null,
          confidence: 0,
          scores: {},
          stated: false,
          abstained: true,
        },
        judge: "rules" as const,
        model: undefined,
        latencyMs: 0,
        inputTokens: 0,
        costUsd: 0,
      })),
    );
  }
}

const [mode, api, fromVersion, toVersion, fromPath, toPath] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
  string,
];

const counter = new CountingJudge();
const judge: Judge =
  mode === "hybrid"
    ? new HybridJudge(new RulesJudge(), new JevJudge())
    : mode === "count"
      ? counter
      : new RulesJudge();

const started = Date.now();
const result = await analysePair(
  { api, fromVersion, toVersion, fromPath, toPath },
  { judge },
);

// A sentinel, because anything the loaded specifications provoke on stdout
// would otherwise be indistinguishable from the result.
process.stdout.write(
  `\n__PAIR__${JSON.stringify({ ...result, elapsedMs: Date.now() - started, asked: counter.asked })}\n`,
);
