/** Renders a run as something a person can argue with. */
import type { Metrics, OwnershipVerdict } from "./metrics.ts";

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function renderMetrics(label: string, metrics: Metrics): string {
  return [
    `${label}:`,
    `  answered ${metrics.answered}/${metrics.total} (${percent(metrics.coverage)} coverage)`,
    `  right on what it answered: ${percent(metrics.selectiveAccuracy)}`,
    `  right on the whole corpus:  ${percent(metrics.overallAccuracy)}`,
    `  answered and wrong:         ${metrics.confidentlyWrong}`,
    `  median latency ${metrics.p50LatencyMs.toFixed(0)}ms, cost $${metrics.totalCostUsd.toFixed(4)}`,
  ].join("\n");
}

export function renderVerdict(verdict: OwnershipVerdict): string {
  const headline =
    verdict.verdict === "owns"
      ? "may draft Changes for review"
      : verdict.verdict === "assists"
        ? "may rank and route, but not decide"
        : "is not used for this question";
  return `${verdict.judge}: ${verdict.verdict} - ${headline}\n  because it ${verdict.reason}`;
}
