/**
 * What the L9 journeys add up to: per operating system, how many ran, how
 * many ended with the check blocking the release, and the 95th percentile of
 * the time it took. The gate is ten runs on each of the three, every one
 * blocked, p95 under ten minutes.
 */
export interface Journey {
  os: string;
  seconds: number;
  ok: boolean;
  problem?: string;
}

export interface JourneySummary {
  budgetSeconds: number;
  runsNeeded: number;
  systems: Record<string, { runs: number; blocked: number; p95Seconds: number | null }>;
  problems: string[];
}

export const SYSTEMS = ["linux", "darwin", "win32"] as const;
export const BUDGET_SECONDS = 600;
export const RUNS_NEEDED = 10;

/** Nearest-rank: the smallest value at least 95% of the runs are at or under. */
export function p95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1] as number;
}

export function summarize(journeys: readonly Journey[]): JourneySummary {
  const systems: JourneySummary["systems"] = {};
  for (const os of SYSTEMS) {
    const mine = journeys.filter((journey) => journey.os === os);
    const blocked = mine.filter((journey) => journey.ok);
    systems[os] = {
      runs: mine.length,
      blocked: blocked.length,
      // Every run counts toward the time, a failed one at its time of failing.
      p95Seconds: p95(mine.map((journey) => journey.seconds)),
    };
  }
  return {
    budgetSeconds: BUDGET_SECONDS,
    runsNeeded: RUNS_NEEDED,
    systems,
    problems: journeys.flatMap((journey) =>
      journey.problem ? [`${journey.os}: ${journey.problem.split("\n")[0]}`] : [],
    ),
  };
}

export function met(summary: JourneySummary): boolean {
  return SYSTEMS.every((os) => {
    const system = summary.systems[os];
    return (
      system !== undefined &&
      system.runs >= summary.runsNeeded &&
      system.blocked === system.runs &&
      system.p95Seconds !== null &&
      system.p95Seconds < summary.budgetSeconds
    );
  });
}
