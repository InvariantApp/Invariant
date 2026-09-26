/**
 * The soak's arithmetic, kept pure so the tests read the same rules the
 * harness runs: what each request asks of the upstream, how often the proxy
 * is disturbed, and what the measurements add up to.
 */

/**
 * What one request does to the proxy. The upstream reads it from a header
 * the proxy passes on like any other, and the caller acts on the last two.
 *
 * - `stall`: the upstream never answers; the proxy must give up and say so.
 * - `reset`: the upstream drops the connection as soon as it has the request.
 * - `cut`: the upstream sends half a body and drops the connection.
 * - `slow`: the upstream sends its body in pieces, over most of a second.
 * - `late`: the upstream waits before it answers at all.
 * - `oversized`: the upstream answers with more than the proxy will buffer.
 * - `trickle`: the caller sends its body in pieces.
 * - `bloated`: the caller sends more than the proxy will buffer.
 */
export type Mode =
  | "normal"
  | "stall"
  | "reset"
  | "cut"
  | "slow"
  | "late"
  | "oversized"
  | "trickle"
  | "bloated";

/** Per thousand requests. A mode that needs a body falls back to normal on a GET. */
export const MODE_WEIGHTS: Readonly<Record<Mode, number>> = {
  normal: 800,
  stall: 10,
  reset: 20,
  cut: 20,
  slow: 40,
  late: 30,
  oversized: 20,
  trickle: 40,
  bloated: 20,
};

export const CHAOS_HEADER = "soak-chaos";

/** The header the fixture provider's callers name their contract with. */
export const VERSION_HEADER = "acme-version";

/** The fixture provider's contracts: two released, and the one being built. */
export const CONTRACTS = {
  oldest: "2026-01-15",
  previous: "2026-03-01",
  current: "2026-09-20",
} as const;

export type Contract = (typeof CONTRACTS)[keyof typeof CONTRACTS];

export type OperationKind = "list" | "retrieve" | "create" | "refund";

export interface Operation {
  kind: OperationKind;
  method: "GET" | "POST";
  /** The path as the caller's contract names it, which the oracle looks up. */
  template: string;
  /** The path the caller sends. */
  path: string;
}

/** A seeded generator, so a run can be repeated request for request. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T extends string>(weights: Readonly<Record<T, number>>, roll: number): T {
  const entries = Object.entries(weights) as [T, number][];
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let left = roll * total;
  for (const [key, weight] of entries) {
    left -= weight;
    if (left < 0) return key;
  }
  return (entries.at(-1) as [T, number])[0];
}

const CONTRACT_WEIGHTS: Readonly<Record<Contract, number>> = {
  [CONTRACTS.oldest]: 45,
  [CONTRACTS.previous]: 40,
  [CONTRACTS.current]: 15,
};

const OPERATION_WEIGHTS: Readonly<Record<OperationKind, number>> = {
  list: 45,
  retrieve: 30,
  create: 20,
  refund: 5,
};

export interface Planned {
  contract: Contract;
  operation: Operation;
  mode: Mode;
  /** The body the caller sends, for a POST. */
  body?: Record<string, unknown>;
}

/**
 * The next request: a contract, an operation in it, and what goes wrong,
 * among the modes allowed, which a run narrows to find which one a failure
 * needs.
 */
export function plan(
  next: () => number,
  sequence: number,
  modes: readonly Mode[] = Object.keys(MODE_WEIGHTS) as Mode[],
): Planned {
  const contract = pick(CONTRACT_WEIGHTS, next());
  const kind = pick(OPERATION_WEIGHTS, next());
  const oldest = contract === CONTRACTS.oldest;
  const collection = oldest ? "/v1/charges" : "/v1/payments";
  // One in ten looks up something that is not there, for the 404.
  const id = next() < 0.1 ? `pay_missing_${sequence}` : `pay_${sequence % 500}`;
  const operation: Operation =
    kind === "list"
      ? {
          kind,
          method: "GET",
          template: collection,
          path: `${collection}?limit=${1 + Math.floor(next() * 20)}`,
        }
      : kind === "retrieve"
        ? {
            kind,
            method: "GET",
            template: `${collection}/{id}`,
            path: `${collection}/${id}`,
          }
        : kind === "create"
          ? { kind, method: "POST", template: collection, path: collection }
          : { kind, method: "POST", template: "/v1/refunds", path: "/v1/refunds" };
  let mode = pick(MODE_WEIGHTS, next());
  if (
    !modes.includes(mode) ||
    ((mode === "trickle" || mode === "bloated") && operation.method !== "POST")
  ) {
    mode = "normal";
  }
  const cents = 100 + Math.floor(next() * 99_900);
  const amount = cents / 100;
  const currency = (["usd", "eur", "gbp"] as const)[Math.floor(next() * 3)];
  const description = next() < 0.3 ? null : `Order ${sequence}`;
  const body: Record<string, unknown> | undefined =
    kind === "create"
      ? contract === CONTRACTS.oldest
        ? { amount, currency, source: "tok_visa", description }
        : contract === CONTRACTS.previous
          ? { amount, currency, payment_method: { token: "tok_visa" }, description }
          : {
              amount_cents: cents,
              currency,
              payment_method: { token: "tok_visa" },
              capture_method: "automatic",
              description,
            }
      : kind === "refund"
        ? contract === CONTRACTS.oldest
          ? { charge: `pay_${sequence % 500}` }
          : contract === CONTRACTS.previous
            ? { payment: `pay_${sequence % 500}`, amount }
            : { payment: `pay_${sequence % 500}`, amount_cents: cents }
        : undefined;
  return { contract, operation, mode, ...(body ? { body } : {}) };
}

/** What the proxy's kill switch reads, in the order the soak flips through it. */
export const FLAG_STATES: readonly Record<string, unknown>[] = [
  {},
  { disabledChanges: ["chg_payment_status_vocabulary"] },
  {},
  { disabledContracts: [CONTRACTS.oldest] },
  {},
  { allDisabled: true },
];

export interface Schedule {
  durationMs: number;
  checkpointMs: number;
  flipMs: number;
  reloadMs: number;
  restartMs: number;
  warmupMs: number;
}

const MINUTE = 60_000;

/**
 * How often each disturbance comes, for a run of a given length. A day's run
 * restarts the proxy every four hours, so each process lives long enough for
 * its memory to show a trend; a short run compresses everything so each
 * disturbance still happens.
 */
export function scheduleFor(durationMs: number): Schedule {
  return {
    durationMs,
    checkpointMs: Math.max(MINUTE, Math.min(15 * MINUTE, durationMs / 10)),
    flipMs: Math.max(10_000, Math.min(2 * MINUTE, durationMs / 12)),
    reloadMs: Math.max(10_000, Math.min(3 * MINUTE, durationMs / 8)),
    restartMs: Math.max(MINUTE, Math.min(240 * MINUTE, durationMs / 2)),
    warmupMs: Math.max(30_000, Math.min(10 * MINUTE, durationMs / 10)),
  };
}

/** Least-squares slope of y over x, or undefined with fewer than two points. */
export function slope(points: readonly { x: number; y: number }[]): number | undefined {
  if (points.length < 2) return undefined;
  const n = points.length;
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / n;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / n;
  let top = 0;
  let bottom = 0;
  for (const point of points) {
    top += (point.x - meanX) * (point.y - meanY);
    bottom += (point.x - meanX) ** 2;
  }
  return bottom === 0 ? undefined : top / bottom;
}

export interface RssSample {
  /** Milliseconds since the run started. */
  at: number;
  /** Which process of the proxy, counting restarts. */
  incarnation: number;
  /** Since this process started. */
  age: number;
  rssMb: number;
}

/**
 * How fast the proxy's memory grows, in MB per hour, judged on the floor
 * each minute reaches: a collector's sawtooth rises and falls within a
 * minute, and what a leak raises is the floor. Samples in each process's
 * warm-up are left out, and the longest process is the one judged.
 */
export function rssTrend(
  samples: readonly RssSample[],
  warmupMs: number,
): { incarnation: number; windowMs: number; mbPerHour: number | undefined } | undefined {
  const byIncarnation = new Map<number, RssSample[]>();
  for (const sample of samples) {
    if (sample.age < warmupMs) continue;
    byIncarnation.set(sample.incarnation, [
      ...(byIncarnation.get(sample.incarnation) ?? []),
      sample,
    ]);
  }
  let best: { incarnation: number; windowMs: number; points: RssSample[] } | undefined;
  for (const [incarnation, points] of byIncarnation) {
    const windowMs = (points.at(-1)?.at ?? 0) - (points[0]?.at ?? 0);
    if (!best || windowMs > best.windowMs) best = { incarnation, windowMs, points };
  }
  if (!best) return undefined;
  const floors = new Map<number, { x: number; y: number }>();
  for (const sample of best.points) {
    const minute = Math.floor(sample.at / MINUTE);
    const floor = floors.get(minute);
    if (!floor || sample.rssMb < floor.y)
      floors.set(minute, { x: minute, y: sample.rssMb });
  }
  const perMinute = slope([...floors.values()]);
  return {
    incarnation: best.incarnation,
    windowMs: best.windowMs,
    mbPerHour: perMinute === undefined ? undefined : perMinute * 60,
  };
}

/** A percentile of a list of numbers, nearest rank. */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** What L11 asks of a run, stated once for the harness, the scoreboard and the docs. */
export const BUDGET = {
  /**
   * Fourteen hours, the user's call on 2026-09-26: a 14.5-hour run was clean
   * throughout, and its later hours only repeat the same disturbances on the
   * same schedule, while the memory trend is judged over one proxy process,
   * which restarts every four hours.
   */
  hours: 14,
  rps: 50,
  /** Of the stated rate, what the run has to have sent. */
  rpsShare: 0.98,
  /** Growth of the proxy's memory floor after warm-up. */
  rssMbPerHour: 1,
  /** A trend is judged only over a window at least this long. */
  trendWindowMs: 60 * MINUTE,
  /** The most the proxy may hold. */
  rssMaxMb: 256,
} as const;

export interface Verdict {
  met: boolean;
  /** Each criterion, and whether this run met it. */
  criteria: { name: string; met: boolean; value: string }[];
}

export interface Measured {
  hours: number;
  rps: { stated: number; achieved: number };
  violations: number;
  /** Requests that got no answer at all, outside a restart and a body the upstream cut. */
  unanswered: number;
  crashes: number;
  rss: {
    maxMb: number;
    trend?: { windowMs: number; mbPerHour: number | undefined } | undefined;
  };
  sockets: { leaked: number | undefined };
}

/** L11, criterion by criterion. */
export function judge(measured: Measured): Verdict {
  const trend = measured.rss.trend;
  const judgedTrend =
    trend !== undefined &&
    trend.mbPerHour !== undefined &&
    trend.windowMs >= BUDGET.trendWindowMs;
  const criteria = [
    {
      name: `ran ${BUDGET.hours} hours`,
      met: measured.hours >= BUDGET.hours,
      value: `${round(measured.hours, 2)} hours`,
    },
    {
      name: `held ${BUDGET.rps} requests a second`,
      met:
        measured.rps.stated >= BUDGET.rps &&
        measured.rps.achieved >= measured.rps.stated * BUDGET.rpsShare,
      value: `${round(measured.rps.achieved, 1)} of ${measured.rps.stated} stated`,
    },
    {
      name: "no response fails the old contract",
      met: measured.violations === 0,
      value: `${measured.violations} violations`,
    },
    {
      name: "every request is answered, outside a restart",
      met: measured.unanswered === 0,
      value: `${measured.unanswered} unanswered`,
    },
    {
      name: "the proxy never crashed",
      met: measured.crashes === 0,
      value: `${measured.crashes} crashes`,
    },
    {
      name: `memory floor grows under ${BUDGET.rssMbPerHour} MB an hour after warm-up`,
      met: judgedTrend && (trend?.mbPerHour ?? Infinity) <= BUDGET.rssMbPerHour,
      value: judgedTrend
        ? `${round(trend?.mbPerHour ?? 0, 2)} MB an hour over ${round((trend?.windowMs ?? 0) / 3_600_000, 1)} hours`
        : `not judged: ${trend ? `${round(trend.windowMs / 60_000, 1)} minutes` : "no window"} after warm-up, under the hour a trend needs`,
    },
    {
      name: `memory stays under ${BUDGET.rssMaxMb} MB`,
      met: measured.rss.maxMb <= BUDGET.rssMaxMb,
      value: `${round(measured.rss.maxMb, 1)} MB at most`,
    },
    {
      name: "no socket leaked",
      met: measured.sockets.leaked === 0,
      value:
        measured.sockets.leaked === undefined
          ? "not measured on this platform"
          : `${measured.sockets.leaked} left open`,
    },
  ];
  return { met: criteria.every((criterion) => criterion.met), criteria };
}

/** What a run writes to `results.json`, and what the scoreboard reads of it. */
export interface SoakResults {
  startedAt: string;
  finishedAt: string;
  hours: number;
  seed: number;
  schedule: Schedule;
  rps: { stated: number; achieved: number };
  requests: { issued: number; completed: number; shed: number };
  violations: { responses: number; requests: number; samples: string[] };
  transport: {
    duringRestart: number;
    streamedCut: number;
    otherwise: number;
    samples: string[];
  };
  outcomes: Record<string, number>;
  disturbances: {
    flagFlips: number;
    reloads: { written: number; broken: number; served: number; kept: number };
    restarts: number;
    crashes: number;
  };
  rss: {
    maxMb: number;
    trend: ReturnType<typeof rssTrend>;
    samples: number;
  };
  sockets: {
    baseline: number | undefined;
    max: number;
    final: number | undefined;
    leaked: number | undefined;
    upstreamLeftOpen: number;
  };
  verdict: Verdict;
}

export function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
