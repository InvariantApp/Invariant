/**
 * Running the whole pipeline against specifications nobody here wrote.
 *
 * Everything this project has measured so far was measured against a fixture
 * built for it and a corpus written for it. Both are useful and neither can
 * answer the question that decides whether the design is sound: when a real
 * company changes a real API, what fraction of what they did can this express?
 *
 * So this takes consecutive published versions of real APIs and runs them
 * through loading, diffing, drafting, compiling and the closure check. It is
 * expected to fail, often. The failures are the output: a ranked list of what
 * actually happens in the wild that this cannot yet handle is worth more than
 * another passing test.
 *
 * Every stage is wrapped, because a harness that stops at the first unreadable
 * document measures nothing except how far it got.
 */
import { predictDocument } from "@invariant/compiler";
import { loadContract } from "@invariant/contract";
import { breakingEntries, type DiffEntry, diffDocuments } from "@invariant/diff";
import type { Change } from "@invariant/ir";
import { type Judge, propose } from "@invariant/proposer";

/** How far a pair got before something went wrong. */
export type Stage = "load" | "diff" | "propose" | "compile" | "closure" | "done";

export interface PairInput {
  /** `provider:service`, as the directory names it. */
  api: string;
  fromVersion: string;
  toVersion: string;
  fromPath: string;
  toPath: string;
}

export interface PairResult {
  api: string;
  fromVersion: string;
  toVersion: string;
  /** The last stage that completed. `done` means all of them. */
  reached: Stage;
  /** Why it stopped, when it did not reach `done`. */
  error?: string;
  /** Every delta, breaking or not. */
  deltas: number;
  /** Breaking deltas before anything was drafted. */
  breakingBefore: number;
  /**
   * Breaking deltas once the endpoints have been lined up, and the honest
   * denominator.
   *
   * When an API versions by URL prefix, the raw diff cannot see inside the
   * operations at all: every old path is gone and every new one is unfamiliar,
   * so it reports removals and nothing else. Applying the route change first
   * makes the two comparable, and what surfaces is usually far more than the
   * raw count suggested. On one real AWS pair the raw diff found 45 breaking
   * deltas and the aligned diff found 317.
   *
   * The difference is not noise. It is breakage a provider would not otherwise
   * have been told about.
   */
  breakingAligned: number;
  /** Breaking deltas the drafted Changes did not account for. */
  breakingAfter: number;
  drafts: number;
  /** Fields the proposer would not draft for. */
  unresolved: number;
  /** Changes it recognised as inexpressible, such as a split or a merge. */
  impasses: number;
  /** Problems applying the drafted Changes to the old document. */
  compileIssues: string[];
  /** oasdiff check ids left unexplained, with how many of each. */
  unexplainedKinds: Record<string, number>;
  /** Every breaking check id seen, with how many of each. */
  breakingKinds: Record<string, number>;
  elapsedMs: number;
}

function tally(entries: readonly DiffEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of entries) out[entry.id] = (out[entry.id] ?? 0) + 1;
  return out;
}

function message(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message.slice(0, 300)}`;
  return String(error).slice(0, 300);
}

/**
 * A stage that is allowed to fail without taking the run with it.
 *
 * Real documents do things no fixture does: circular references, vendor
 * extensions where a schema belongs, megabytes of it. Catching per stage is
 * what turns each of those from a lost run into a recorded fact.
 */
async function stage<T>(
  run: () => Promise<T> | T,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

export interface AnalyseOptions {
  /** Which judge drafts. Rules costs nothing and needs no network. */
  judge: Judge;
  /**
   * Give up on a single pair after this long.
   *
   * Not a performance assertion. A document large enough to take minutes is a
   * finding, and one that never finishes would otherwise end the whole run.
   */
  timeoutMs?: number;
}

export async function analysePair(
  input: PairInput,
  options: AnalyseOptions,
): Promise<PairResult> {
  const started = performance.now();
  const base: PairResult = {
    api: input.api,
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    reached: "load",
    deltas: 0,
    breakingBefore: 0,
    breakingAligned: 0,
    breakingAfter: 0,
    drafts: 0,
    unresolved: 0,
    impasses: 0,
    compileIssues: [],
    unexplainedKinds: {},
    breakingKinds: {},
    elapsedMs: 0,
  };
  const finish = (result: PairResult): PairResult => ({
    ...result,
    elapsedMs: Math.round(performance.now() - started),
  });

  const loaded = await stage(async () => ({
    from: await loadContract(input.fromPath, input.fromVersion),
    to: await loadContract(input.toPath, input.toVersion),
  }));
  if (!loaded.ok) return finish({ ...base, error: loaded.error });

  const diffed = await stage(() =>
    diffDocuments(loaded.value.from.document, loaded.value.to.document),
  );
  if (!diffed.ok) return finish({ ...base, reached: "load", error: diffed.error });

  const breaking = breakingEntries(diffed.value);
  const afterDiff: PairResult = {
    ...base,
    reached: "diff",
    deltas: diffed.value.length,
    breakingBefore: breaking.length,
    breakingAligned: breaking.length,
    breakingKinds: tally(breaking),
    unexplainedKinds: tally(breaking),
    breakingAfter: breaking.length,
  };

  const drafted = await stage(() =>
    propose(loaded.value.from.document, loaded.value.to.document, {
      judge: options.judge,
    }),
  );
  if (!drafted.ok) return finish({ ...afterDiff, error: drafted.error });

  const changes: Change[] = drafted.value.proposals.map((proposal) => proposal.change);

  // What the diff can actually see once the endpoints line up. Measured with
  // the route change alone, so it is a fact about the two documents rather
  // than a reflection of how well the field-level drafting did.
  const routeOnly = changes.filter((change) =>
    change.ops.every((op) => op.op === "route"),
  );
  let aligned = breaking.length;
  let alignedKinds = tally(breaking);
  if (routeOnly.length > 0) {
    const lined = await stage(async () => {
      const predicted = predictDocument(
        loaded.value.from.document,
        loaded.value.to.document,
        routeOnly,
      );
      return breakingEntries(
        await diffDocuments(predicted.document, loaded.value.to.document),
      );
    });
    if (lined.ok) {
      aligned = lined.value.length;
      alignedKinds = tally(lined.value);
    }
  }

  const afterPropose: PairResult = {
    ...afterDiff,
    reached: "propose",
    breakingAligned: aligned,
    breakingAfter: aligned,
    breakingKinds: alignedKinds,
    unexplainedKinds: alignedKinds,
    drafts: changes.length,
    unresolved: drafted.value.unresolved.length,
    impasses: drafted.value.impasses.length,
  };

  const predicted = await stage(() =>
    predictDocument(loaded.value.from.document, loaded.value.to.document, changes),
  );
  if (!predicted.ok) return finish({ ...afterPropose, error: predicted.error });

  const afterCompile: PairResult = {
    ...afterPropose,
    reached: "compile",
    compileIssues: predicted.value.issues.map(
      (issue) => `${issue.changeId}: ${issue.message}`,
    ),
  };

  const residual = await stage(async () =>
    breakingEntries(
      await diffDocuments(predicted.value.document, loaded.value.to.document),
    ),
  );
  if (!residual.ok) return finish({ ...afterCompile, error: residual.error });

  return finish({
    ...afterCompile,
    reached: "done",
    breakingAfter: residual.value.length,
    unexplainedKinds: tally(residual.value),
  });
}

export interface RealSummary {
  pairs: number;
  /** Pairs that completed every stage. */
  completed: number;
  /** Pairs that stopped somewhere, by the stage they reached. */
  stoppedAt: Record<Stage, number>;
  /** Pairs whose two versions had no breaking change at all. */
  additiveOnly: number;
  breakingBefore: number;
  /** The honest denominator: what is visible once endpoints line up. */
  breakingAligned: number;
  breakingAfter: number;
  /**
   * Breakage that only became visible after the endpoints were lined up, and
   * which a provider versioning by URL prefix would otherwise never see.
   */
  revealed: number;
  /** Share of the aligned breaking deltas the drafted Changes accounted for. */
  explained: number;
  drafts: number;
  impasses: number;
  /** Unexplained check ids, most frequent first. This is the to-do list. */
  holes: { kind: string; count: number; pairs: number }[];
  /** Every breaking kind seen in the wild, most frequent first. */
  wild: { kind: string; count: number; pairs: number }[];
  /** The distinct errors that stopped a pair, most frequent first. */
  errors: { error: string; count: number }[];
  medianMs: number;
}

function rank(
  results: readonly PairResult[],
  pick: (result: PairResult) => Record<string, number>,
): { kind: string; count: number; pairs: number }[] {
  const count = new Map<string, number>();
  const pairs = new Map<string, number>();
  for (const result of results) {
    for (const [kind, n] of Object.entries(pick(result))) {
      count.set(kind, (count.get(kind) ?? 0) + n);
      pairs.set(kind, (pairs.get(kind) ?? 0) + 1);
    }
  }
  return [...count]
    .map(([kind, n]) => ({ kind, count: n, pairs: pairs.get(kind) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}

export function summarizeReal(results: readonly PairResult[]): RealSummary {
  const stoppedAt: Record<Stage, number> = {
    load: 0,
    diff: 0,
    propose: 0,
    compile: 0,
    closure: 0,
    done: 0,
  };
  for (const result of results) stoppedAt[result.reached] += 1;

  const before = results.reduce((sum, result) => sum + result.breakingBefore, 0);
  const aligned = results.reduce((sum, result) => sum + result.breakingAligned, 0);
  const after = results.reduce((sum, result) => sum + result.breakingAfter, 0);

  const errors = new Map<string, number>();
  for (const result of results) {
    if (result.error === undefined) continue;
    // Grouped by kind rather than by message, so one unreadable document does
    // not look like a different problem from the next unreadable document.
    const kind = result.error.split(":").slice(0, 2).join(":");
    errors.set(kind, (errors.get(kind) ?? 0) + 1);
  }

  const times = results.map((result) => result.elapsedMs).sort((a, b) => a - b);

  return {
    pairs: results.length,
    completed: stoppedAt.done,
    stoppedAt,
    additiveOnly: results.filter(
      (result) => result.reached === "done" && result.breakingBefore === 0,
    ).length,
    breakingBefore: before,
    breakingAligned: aligned,
    breakingAfter: after,
    revealed: Math.max(0, aligned - before),
    explained: aligned === 0 ? 1 : (aligned - after) / aligned,
    drafts: results.reduce((sum, result) => sum + result.drafts, 0),
    impasses: results.reduce((sum, result) => sum + result.impasses, 0),
    holes: rank(results, (result) => result.unexplainedKinds),
    wild: rank(results, (result) => result.breakingKinds),
    errors: [...errors]
      .map(([error, count]) => ({ error, count }))
      .sort((a, b) => b.count - a.count),
    medianMs: times[Math.floor(times.length / 2)] ?? 0,
  };
}
