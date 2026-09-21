/**
 * What the proxy adds to a request's latency (launch gate L19).
 *
 * The upstream and the proxy each run in their own process, and the client in
 * this one, so no two of them share an event loop and the number is the
 * proxy's rather than contention's. Requests are sent at a fixed rate, not as
 * fast as answers come back: a closed loop slows down when the proxy does and
 * hides exactly the latency this is meant to find.
 *
 * Three series, each over the same connection pool: the upstream directly,
 * the proxy for a current caller (nothing to adapt, streamed through), and the
 * proxy for an old caller (the body read, every item adapted, written again).
 * What is gated is the old caller's p99 over the direct p99.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { HEADER, OLD } from "./program.ts";

export interface Series {
  p50Ms: number;
  p99Ms: number;
  errors: number;
}

export interface OverheadResult {
  rps: number;
  seconds: number;
  bodyBytes: number;
  direct: Series;
  current: Series;
  adapted: Series;
  /** The adapted p99 over the direct p99. */
  addedP99Ms: number;
}

/**
 * What L19 holds the proxy to: at `rps` requests a second of a `bodyBytes`
 * list whose every item is adapted, no more than `addedP99Ms` over going
 * straight to the upstream. The design's in-process budget is a millisecond;
 * the proxy adds a hop and a second HTTP parse on top, and the budget is set
 * to catch a cost that has changed kind on a shared runner, not one that has
 * drifted by a fraction.
 */
export const BUDGET = { rps: 200, items: 40, seconds: 5, addedP99Ms: 10 } as const;

const HERE = import.meta.dirname;

function start(
  script: string,
  args: string[],
): Promise<{ child: ChildProcess; line: string }> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", join(HERE, script), ...args],
    {
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  return new Promise((resolve, reject) => {
    child.once("exit", (code) => reject(new Error(`${script} exited with ${code}`)));
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).once(
      "line",
      (line) => resolve({ child, line }),
    );
  });
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? Number.NaN;
}

/** Sends `rps` requests a second for `seconds`, each on schedule whatever the last did. */
async function drive(
  url: string,
  headers: Record<string, string>,
  rps: number,
  seconds: number,
): Promise<Series> {
  const total = rps * seconds;
  const interval = 1000 / rps;
  const started = performance.now();
  const latencies: number[] = [];
  let errors = 0;
  const pending: Promise<void>[] = [];
  for (let index = 0; index < total; index += 1) {
    const due = started + index * interval;
    const wait = due - performance.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    pending.push(
      (async () => {
        const sent = performance.now();
        try {
          const response = await fetch(url, { headers });
          await response.arrayBuffer();
          if (!response.ok) errors += 1;
          latencies.push(performance.now() - sent);
        } catch {
          errors += 1;
        }
      })(),
    );
  }
  await Promise.all(pending);
  latencies.sort((a, b) => a - b);
  const round = (ms: number) => Math.round(ms * 100) / 100;
  return {
    p50Ms: round(percentile(latencies, 0.5)),
    p99Ms: round(percentile(latencies, 0.99)),
    errors,
  };
}

export async function measureOverhead(
  shape: { rps: number; items: number; seconds: number } = BUDGET,
): Promise<OverheadResult> {
  const upstream = await start("upstream.mts", [String(shape.items)]);
  const [upstreamUrl, bytes] = upstream.line.split(" ") as [string, string];
  const proxy = await start("proxy.mts", [upstreamUrl]);
  try {
    const target = `${proxy.line}/v1/payments`;
    // A proxy that passed the answer through untouched would measure fast and
    // prove nothing, so the answer is checked before anything is timed.
    const sample = (await (
      await fetch(target, { headers: { [HEADER]: OLD } })
    ).json()) as {
      data: { amount?: number; status?: string }[];
    };
    if (sample.data[0]?.amount === undefined || sample.data[0]?.status !== "paid") {
      throw new Error(
        "the proxy did not adapt the answer, so its overhead would mean nothing",
      );
    }
    // Connections and code paths warm, so the first second is not measured.
    await drive(`${upstreamUrl}/v1/payments`, {}, shape.rps, 1);
    await drive(target, { [HEADER]: OLD }, shape.rps, 1);
    const direct = await drive(
      `${upstreamUrl}/v1/payments`,
      {},
      shape.rps,
      shape.seconds,
    );
    const current = await drive(target, {}, shape.rps, shape.seconds);
    const adapted = await drive(target, { [HEADER]: OLD }, shape.rps, shape.seconds);
    return {
      rps: shape.rps,
      seconds: shape.seconds,
      bodyBytes: Number(bytes),
      direct,
      current,
      adapted,
      addedP99Ms: Math.round((adapted.p99Ms - direct.p99Ms) * 100) / 100,
    };
  } finally {
    proxy.child.removeAllListeners("exit");
    upstream.child.removeAllListeners("exit");
    proxy.child.kill();
    upstream.child.kill();
  }
}
