/**
 * Rig B's results, and what they add up to. Pure, so the scoreboard and the
 * tests read the same arithmetic the harness writes.
 *
 * The rig runs Stripe's own SDK suites against stripe-mock three times per
 * pair of consecutive specification commits, and records every exchange the
 * SDK made. What it counts is not whether the suites went green, which says
 * little when the mock's answers are canned and the SDKs are leniently typed,
 * but two things an old caller would actually suffer:
 *
 *   - a request the mock refused with a 400, because the new specification no
 *     longer accepts what the old SDK sends, and
 *   - an answer the old SDK received that the old specification does not
 *     allow, judged by the independent oracle of rig C, not by the code under
 *     test.
 *
 * Each is counted over what arm a, the old SDK against the mock on its own
 * specification, already showed. A 400 the old mock gives too is the suite's
 * own (a test of an error path), and an answer the old mock gives that its own
 * specification does not allow is a disagreement between the mock and the
 * oracle, reported as calibration rather than blamed on the release.
 */

/** One request and its answer, as a recording forwarder saw them. */
export interface Exchange {
  /** Which request this was, in the order the forwarder received them. */
  seq: number;
  method: string;
  path: string;
  status: number;
  /** The JSON answer, parsed, when the answer was JSON. */
  body?: unknown;
  /** The contract the proxy answered for, from its `invariant-contract` header. */
  contract?: string;
  /** The API version the SDK asked for, from its `Stripe-Version` header. */
  version?: string;
}

/** What one arm's suites and exchanges came to. */
export interface ArmTally {
  /** Test id to outcome, over both suites, ids prefixed with the suite. */
  outcomes: Record<string, "passed" | "failed" | "skipped">;
  /** Per suite: how many passed and failed, or why it did not run. */
  suites: Record<string, { passed: number; failed: number; error?: string }>;
  exchanges: number;
  /** 400s the mock answered, by site (`METHOD /template`). */
  mock400: Record<string, number>;
  /** Old-contract violations in what the SDK received, by `site status pointer: message`. */
  violations: Record<string, number>;
  /** Answers the oracle had no schema for, or could not match to an operation. */
  unjudged: number;
  /** Exchanges asking for an API version other than the SDK's own, set aside. */
  otherVersion?: number;
  /** Set when the arm could not run at all. */
  error?: string;
}

/** What the product made of the pair, read the way `invariant check` reports it. */
export interface StripeGate {
  result: "pass" | "warn" | "block";
  /** Changes the proposer drafted. */
  drafted: number;
  /** Open decisions the auto-provider answered, every answer labelled synthetic. */
  decided: number;
  unexplained: string[];
  unservable: string[];
}

export interface Commit {
  commit: string;
  apiVersion: string;
  /** The contract label the pair's program gives this commit. */
  label: string;
}

export interface StripePair {
  from: Commit;
  to: Commit;
  /** The SDK releases run, pinned to the old commit's API version. */
  sdks: Record<string, string>;
  gate: StripeGate;
  arms: { a: ArmTally; b: ArmTally; c: ArmTally };
  /** Sites the program changes for the old contract. */
  programSites: number;
  /** Exchanges in arm c the proxy changed, and the distinct sites they were at. */
  adapted: { exchanges: number; sites: string[] };
}

export interface StripeResults {
  stripeMock: string;
  pairs: StripePair[];
}

/** How far `arm` goes past `baseline`, key by key. */
export function excess(
  arm: Record<string, number>,
  baseline: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(arm)) {
    const over = count - (baseline[key] ?? 0);
    if (over > 0) out[key] = over;
  }
  return out;
}

const total = (counts: Record<string, number>): number =>
  Object.values(counts).reduce((sum, count) => sum + count, 0);

export interface PairVerdict {
  /** 400s and violations beyond arm a's, with no adapter and with one. */
  b400: number;
  bViolations: number;
  c400: number;
  cViolations: number;
  /** Arm a's own violations: the mock and the oracle disagreeing, not the release. */
  calibration: number;
  /**
   * `vacuous`: the old SDK meets nothing wrong on the new specification with
   * no adapter, so the pair proves nothing about one. `served`: arm c ran and
   * shows no 400 and no violation beyond arm a's. `unserved`: anything else,
   * including a gate that blocked and so left nothing to run.
   */
  verdict: "vacuous" | "served" | "unserved";
}

export function judge(pair: StripePair): PairVerdict {
  const { a, b, c } = pair.arms;
  const b400 = total(excess(b.mock400, a.mock400));
  const bViolations = total(excess(b.violations, a.violations));
  const c400 = total(excess(c.mock400, a.mock400));
  const cViolations = total(excess(c.violations, a.violations));
  const calibration = total(a.violations);
  const verdict =
    a.error || b.error || a.exchanges === 0
      ? "vacuous"
      : b400 + bViolations === 0
        ? "vacuous"
        : !c.error && c400 + cViolations === 0
          ? "served"
          : "unserved";
  return { b400, bViolations, c400, cViolations, calibration, verdict };
}

/** Passed over run, across suites, for one arm. */
export function suiteGreen(arm: ArmTally): { passed: number; ran: number } {
  const counts = Object.values(arm.suites);
  const passed = counts.reduce((sum, suite) => sum + suite.passed, 0);
  return { passed, ran: passed + counts.reduce((sum, suite) => sum + suite.failed, 0) };
}

/** The consecutive commits the pairs run over, which the gate line names. */
export const REQUIRED_PAIRS = 6;

export interface L5Tally {
  pairs: number;
  /** Pairs whose arm c ran: the gate compiled a program and the suites ran through it. */
  ran: number;
  served: number;
  vacuous: number;
  c400: number;
  cViolations: number;
  b400: number;
  bViolations: number;
  adaptedExchanges: number;
  adaptedSites: number;
  programSites: number;
  /** Tests passing through the proxy, of those run, over every pair. */
  passed: number;
  run: number;
  first?: string;
  last?: string;
}

export function tally(results: StripeResults): L5Tally {
  const verdicts = results.pairs.map((pair) => ({ pair, verdict: judge(pair) }));
  const green = results.pairs.map((pair) => suiteGreen(pair.arms.c));
  return {
    pairs: results.pairs.length,
    ran: results.pairs.filter((pair) => !pair.arms.c.error).length,
    served: verdicts.filter(({ verdict }) => verdict.verdict === "served").length,
    vacuous: verdicts.filter(({ verdict }) => verdict.verdict === "vacuous").length,
    c400: verdicts.reduce((sum, { verdict }) => sum + verdict.c400, 0),
    cViolations: verdicts.reduce((sum, { verdict }) => sum + verdict.cViolations, 0),
    b400: verdicts.reduce((sum, { verdict }) => sum + verdict.b400, 0),
    bViolations: verdicts.reduce((sum, { verdict }) => sum + verdict.bViolations, 0),
    adaptedExchanges: results.pairs.reduce(
      (sum, pair) => sum + pair.adapted.exchanges,
      0,
    ),
    adaptedSites: results.pairs.reduce((sum, pair) => sum + pair.adapted.sites.length, 0),
    programSites: results.pairs.reduce((sum, pair) => sum + pair.programSites, 0),
    passed: green.reduce((sum, entry) => sum + entry.passed, 0),
    run: green.reduce((sum, entry) => sum + entry.ran, 0),
    ...(results.pairs[0] ? { first: results.pairs[0].from.commit.slice(0, 7) } : {}),
    ...(results.pairs.at(-1)
      ? { last: results.pairs.at(-1)?.to.commit.slice(0, 7) as string }
      : {}),
  };
}

/**
 * Met when six consecutive pairs all ran through the proxy with no 400 and no
 * old-contract violation beyond arm a's, and the run proves something: at
 * least one pair where the old SDK meets a violation without the adapter, and
 * the proxy changed at least one answer. A run where every pair is vacuous is
 * six green suites that never needed the product.
 */
export function met(counted: L5Tally): boolean {
  return (
    counted.pairs >= REQUIRED_PAIRS &&
    counted.ran === counted.pairs &&
    counted.c400 === 0 &&
    counted.cViolations === 0 &&
    counted.vacuous < counted.pairs &&
    counted.adaptedExchanges > 0
  );
}

export function headline(counted: L5Tally): string {
  if (counted.pairs === 0) return "";
  return (
    `${counted.pairs} pairs of consecutive stripe/openapi commits (${counted.first}..${counted.last}), ` +
    `${counted.ran} with a program the gate compiled: ${counted.c400} mock 400s and ` +
    `${counted.cViolations} old-contract violations through the proxy, against ` +
    `${counted.b400} and ${counted.bViolations} without it; ${counted.served} served, ` +
    `${counted.vacuous} proving nothing; ${counted.adaptedExchanges} answers adapted at ` +
    `${counted.adaptedSites} of ${counted.programSites} sites the programs change; ` +
    `suites ${counted.passed} of ${counted.run} tests passing through the proxy`
  );
}

/** The report a person reads, one section per pair. */
export function render(results: StripeResults): string {
  const counted = tally(results);
  const lines = [
    "# Rig B: Stripe's SDK suites against stripe-mock",
    "",
    "Generated by `node --import tsx proving/stripe/run.mts`. Every pair runs",
    "stripe-python's and stripe-node's own suites, at the release pinned to the",
    "old commit's API version, against stripe-mock on the old specification (a),",
    "on the new one (b), and on the new one through the proxy running the",
    "program the gate compiled (c). Counts are over what arm a already showed.",
    "",
    `stripe-mock ${results.stripeMock}. ${headline(counted) || "No pairs ran."}.`,
    "",
    "| Pair | API versions | Gate | 400s b / c | Violations b / c | Adapted | Suites c | Verdict |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const pair of results.pairs) {
    const verdict = judge(pair);
    const green = suiteGreen(pair.arms.c);
    lines.push(
      `| ${pair.from.commit.slice(0, 7)}..${pair.to.commit.slice(0, 7)} ` +
        `| ${pair.from.apiVersion} -> ${pair.to.apiVersion} ` +
        `| ${pair.gate.result} (${pair.gate.drafted} drafted, ${pair.gate.decided} decided synthetically) ` +
        `| ${verdict.b400} / ${pair.arms.c.error ? "-" : verdict.c400} ` +
        `| ${verdict.bViolations} / ${pair.arms.c.error ? "-" : verdict.cViolations} ` +
        `| ${pair.adapted.exchanges} answers at ${pair.adapted.sites.length} of ${pair.programSites} sites ` +
        `| ${pair.arms.c.error ? "-" : `${green.passed} of ${green.ran}`} ` +
        `| ${verdict.verdict} |`,
    );
  }
  for (const pair of results.pairs) {
    const verdict = judge(pair);
    const notes: string[] = [];
    for (const [name, arm] of Object.entries(pair.arms)) {
      if (arm.error) notes.push(`- arm ${name} did not run: ${arm.error.split("\n")[0]}`);
    }
    if (pair.gate.unexplained.length > 0) {
      notes.push(
        `- the gate found ${pair.gate.unexplained.length} breaking deltas no Change explains, first: ${pair.gate.unexplained[0]}`,
      );
    }
    if (pair.gate.unservable.length > 0) {
      notes.push(
        `- ${pair.gate.unservable.length} problems applying the Changes, first: ${pair.gate.unservable[0]}`,
      );
    }
    const worst = (counts: Record<string, number>) =>
      Object.entries(counts)
        .sort(([, x], [, y]) => y - x)
        .slice(0, 5)
        .map(([key, count]) => `  - ${count} x ${key}`);
    const c400 = excess(pair.arms.c.mock400, pair.arms.a.mock400);
    const cViolations = excess(pair.arms.c.violations, pair.arms.a.violations);
    const bViolations = excess(pair.arms.b.violations, pair.arms.a.violations);
    if (Object.keys(c400).length > 0)
      notes.push("- 400s through the proxy:", ...worst(c400));
    if (Object.keys(cViolations).length > 0) {
      notes.push("- violations through the proxy:", ...worst(cViolations));
    }
    if (Object.keys(bViolations).length > 0) {
      notes.push("- violations without the proxy:", ...worst(bViolations));
    }
    if (verdict.calibration > 0) {
      notes.push(
        `- ${verdict.calibration} answers the old mock gave that its own specification does not allow, set aside as calibration`,
      );
    }
    if (notes.length === 0) continue;
    lines.push(
      "",
      `## ${pair.from.commit.slice(0, 7)}..${pair.to.commit.slice(0, 7)}`,
      "",
      ...notes,
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Path templates of a specification, matched against concrete paths the way
 * OpenAPI describes, and independently of the runtime's router: a template
 * with more literal segments wins, so `/v1/customers/search` is not taken for
 * a customer called "search".
 */
export function templateMatcher(
  paths: readonly string[],
): (method: string, path: string) => string | undefined {
  const compiled = paths
    .map((template) => {
      const segments = template.split("/");
      const pattern = segments
        .map((segment) =>
          segment
            .split(/(\{[^}]+\})/)
            .map((part) =>
              part.startsWith("{")
                ? "[^/]+"
                : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            )
            .join(""),
        )
        .join("/");
      const literal = segments.filter((segment) => !segment.includes("{")).length;
      return { template, regex: new RegExp(`^${pattern}$`), literal };
    })
    .sort((x, y) => y.literal - x.literal);
  return (_method, path) => compiled.find((entry) => entry.regex.test(path))?.template;
}

/** A JSON pointer with array indexes folded, so one violation per list counts once per place. */
export function place(pointer: string): string {
  return pointer.replace(/\/\d+(?=\/|$)/g, "/*") || "/";
}

/** Changed at all, as JSON: status, or the answer's body. */
export function differs(inner: Exchange, outer: Exchange): boolean {
  return (
    inner.status !== outer.status ||
    JSON.stringify(inner.body ?? null) !== JSON.stringify(outer.body ?? null)
  );
}

/**
 * The sites a program changes for one contract: a route that moved, or a
 * site with any instruction on its request, envelope or answers. Read from
 * the program as compiled, keyed `METHOD /template` of the current contract.
 */
export function programSites(program: unknown, label: string): string[] {
  const contracts = (program as { contracts?: Record<string, unknown> } | undefined)
    ?.contracts;
  const contract = contracts?.[label] as
    | {
        routes?: { to: { method: string; path: string } }[];
        sites?: Record<string, Record<string, unknown>>;
      }
    | undefined;
  if (!contract) return [];
  const sites = new Set<string>();
  for (const route of contract.routes ?? []) {
    sites.add(`${route.to.method.toUpperCase()} ${route.to.path}`);
  }
  for (const [key, site] of Object.entries(contract.sites ?? {})) {
    const request = Array.isArray(site["request"]) ? site["request"] : [];
    const envelope = site["envelope"] as { instrs?: unknown[] } | undefined;
    const responses =
      typeof site["response"] === "object" && site["response"] !== null
        ? Object.values(site["response"] as Record<string, unknown>)
        : [];
    const status = Array.isArray(site["status"]) ? site["status"] : [];
    const changes =
      request.length > 0 ||
      (envelope?.instrs?.length ?? 0) > 0 ||
      status.length > 0 ||
      responses.some((block) => Array.isArray(block) && block.length > 0);
    if (!changes) continue;
    const space = key.indexOf(" ");
    sites.add(`${key.slice(0, space).toUpperCase()} ${key.slice(space + 1)}`);
  }
  return [...sites].sort();
}
