/**
 * What running adapters did, taken out of the process.
 *
 * The runtime reports every applied Change and every adapted request,
 * response and payload through two callbacks, and deliberately does nothing
 * else with them: it has no file or network access. This is what those
 * callbacks are connected to.
 *
 * Three rules shape all of it, because it runs inside a provider's service.
 *
 * It never throws into the caller. A sink that fails is reported through
 * `onError` and its rows are kept for the next attempt; the request that
 * produced them was served either way.
 *
 * It is bounded. Counters are folded into hourly buckets in memory, so the
 * cost is the number of distinct (consumer, contract, change, hour) keys
 * rather than the number of requests, and past `maxKeys` new keys are counted
 * as dropped instead of growing without limit. A provider with millions of
 * consumer keys loses precision, never memory.
 *
 * It carries no bodies and no field values. A consumer's key is hashed before
 * it is held, and an outcome's reason is the runtime's own message.
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  ControlPlaneClient,
  Heartbeat,
  IngestBatch,
  OutcomeRow,
  UsageRow,
} from "@invariant-app/client";
import type { OutcomeEvent, UsageEvent } from "@invariant-app/runtime";

export { type JsonlOptions, jsonlSink } from "./jsonl.ts";
export { type Meter, meterSink } from "./meter.ts";

/** A batch of counters, each row a count for one hour. */
export interface Batch {
  usage: UsageRow[];
  outcomes: OutcomeRow[];
}

/** Somewhere counters are sent. */
export interface Sink {
  name: string;
  /** Resolves once the batch is kept; rejects with why it was not. */
  write(batch: Batch): Promise<void>;
  close?(): Promise<void>;
}

export interface TelemetryOptions {
  sinks: Sink[];
  /** How often counters are sent. Default one minute. */
  flushMs?: number;
  /** Most distinct counters held between sends. Default 50,000. */
  maxKeys?: number;
  /**
   * Mixed into every consumer key before it is hashed, when the provider
   * would rather the control plane could not recompute which consumer a hash
   * is. Without it the provider can look a consumer up by hashing its key.
   */
  consumerSalt?: string;
  onError?: (message: string) => void;
  /** Milliseconds since the epoch. Substituted in tests. */
  now?: () => number;
}

export interface Telemetry {
  /** Connect to the runtime's `onUsage`. */
  onUsage(event: UsageEvent): void;
  /** Connect to the runtime's `onOutcome`. */
  onOutcome(event: OutcomeEvent): void;
  /** Send what has been counted so far, to every sink. Never rejects. */
  flush(): Promise<void>;
  /** Flush, stop the timer and close every sink. Never rejects. */
  close(): Promise<void>;
  /** Counters not kept because `maxKeys` was reached, since start. */
  readonly dropped: number;
}

/** A consumer's key as it leaves the process: 32 hex characters of SHA-256. */
export function hashConsumer(key: string, salt = ""): string {
  return createHash("sha256").update(salt).update(key).digest("hex").slice(0, 32);
}

const HOUR_MS = 3_600_000;
const SEP = "\u0000";

export function createTelemetry(options: TelemetryOptions): Telemetry {
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 50_000;
  const report = options.onError ?? (() => {});
  const usage = new Map<string, number>();
  const outcomes = new Map<string, number>();
  let dropped = 0;
  let flushing: Promise<void> | undefined;

  const hour = () => Math.floor(now() / HOUR_MS) * 3600;
  const count = (into: Map<string, number>, key: string, by: number) => {
    const held = into.get(key);
    if (held === undefined && usage.size + outcomes.size >= maxKeys) {
      dropped += by;
      return;
    }
    into.set(key, (held ?? 0) + by);
  };

  const timer = setInterval(() => {
    void flush();
  }, options.flushMs ?? 60_000);
  timer.unref?.();

  function drain(): Batch {
    const batch: Batch = { usage: [], outcomes: [] };
    for (const [key, total] of usage) {
      const [consumer, contract, changeId, at] = key.split(SEP) as [
        string,
        string,
        string,
        string,
      ];
      batch.usage.push({
        ...(consumer === "" ? {} : { consumer }),
        contract,
        changeId,
        hour: Number(at),
        count: total,
      });
    }
    for (const [key, total] of outcomes) {
      const [contract, operation, direction, outcome, reason, at] = key.split(SEP) as [
        string,
        string,
        OutcomeRow["direction"],
        OutcomeRow["outcome"],
        string,
        string,
      ];
      batch.outcomes.push({
        contract,
        operation,
        direction,
        outcome,
        ...(reason === "" ? {} : { reason }),
        hour: Number(at),
        count: total,
      });
    }
    usage.clear();
    outcomes.clear();
    return batch;
  }

  async function flush(): Promise<void> {
    // One flush at a time: a slow sink must not have a second batch drained
    // underneath it and sent out of order.
    if (flushing) return flushing;
    const batch = drain();
    if (batch.usage.length === 0 && batch.outcomes.length === 0) return;
    flushing = (async () => {
      await Promise.all(
        options.sinks.map(async (sink) => {
          try {
            await sink.write(batch);
          } catch (error) {
            report(
              `telemetry sink ${sink.name} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }),
      );
    })().finally(() => {
      flushing = undefined;
    });
    return flushing;
  }

  return {
    onUsage(event) {
      try {
        const consumer =
          event.consumer === undefined
            ? ""
            : hashConsumer(event.consumer, options.consumerSalt);
        const at = hour();
        for (const [changeId, times] of event.changes) {
          if (times > 0) {
            count(usage, [consumer, event.contract, changeId, at].join(SEP), times);
          }
        }
      } catch (error) {
        report(`telemetry could not count usage: ${String(error)}`);
      }
    },
    onOutcome(event) {
      try {
        const key = [
          event.contract,
          event.operation.slice(0, 200),
          event.direction,
          event.outcome,
          (event.reason ?? "").slice(0, 500),
          hour(),
        ].join(SEP);
        count(outcomes, key, 1);
      } catch (error) {
        report(`telemetry could not count an outcome: ${String(error)}`);
      }
    },
    flush,
    async close() {
      clearInterval(timer);
      // Whatever was counted while a send was under way is sent after it.
      while (flushing) await flushing;
      await flush();
      await Promise.all(
        options.sinks.map(async (sink) => {
          try {
            await sink.close?.();
          } catch (error) {
            report(`telemetry sink ${sink.name} did not close: ${String(error)}`);
          }
        }),
      );
    },
    get dropped() {
      return dropped;
    },
  };
}

export interface ControlPlaneSinkOptions {
  /**
   * Most rows kept for a retry while the control plane cannot be reached.
   * Past it the oldest are dropped. Default 100,000.
   */
  maxPendingRows?: number;
}

/** The contract's limit on rows per request. */
const ROWS_PER_REQUEST = 5000;

/**
 * Counters sent to the control plane.
 *
 * Each request carries an idempotency key that stays with its rows until they
 * are accepted, so a retry after a timeout that did in fact arrive is counted
 * once. Rows the service could not accept for a reason a retry would not
 * change are dropped and reported, rather than retried forever.
 */
export function controlPlaneSink(
  client: ControlPlaneClient,
  options: ControlPlaneSinkOptions = {},
): Sink {
  const maxPending = options.maxPendingRows ?? 100_000;
  const pending: { key: string; batch: IngestBatch; rows: number }[] = [];
  const rowsHeld = () => pending.reduce((sum, entry) => sum + entry.rows, 0);

  const retryable = (error: unknown) => {
    const status = (error as { status?: number }).status;
    return status === undefined || status === 0 || status === 429 || status >= 500;
  };

  return {
    name: "control-plane",
    async write(batch) {
      const rows = [
        ...batch.usage.map((row) => ({ usage: row })),
        ...batch.outcomes.map((row) => ({ outcome: row })),
      ];
      for (let at = 0; at < rows.length; at += ROWS_PER_REQUEST) {
        const slice = rows.slice(at, at + ROWS_PER_REQUEST);
        const usage = slice.flatMap((row) => ("usage" in row ? [row.usage] : []));
        const outcomes = slice.flatMap((row) => ("outcome" in row ? [row.outcome] : []));
        pending.push({
          key: randomUUID(),
          batch: {
            ...(usage.length > 0 ? { usage } : {}),
            ...(outcomes.length > 0 ? { outcomes } : {}),
          },
          rows: slice.length,
        });
      }
      let lost = 0;
      while (rowsHeld() > maxPending && pending.length > 0) {
        lost += pending.shift()?.rows ?? 0;
      }

      const failures: string[] = [];
      if (lost > 0)
        failures.push(`${lost} rows dropped while the control plane was away`);
      while (pending.length > 0) {
        const next = pending[0] as (typeof pending)[number];
        try {
          await client.ingest(next.batch, { idempotencyKey: next.key });
          pending.shift();
        } catch (error) {
          if (retryable(error)) {
            failures.push(
              `${rowsHeld()} rows kept for the next attempt: ${error instanceof Error ? error.message : String(error)}`,
            );
            break;
          }
          pending.shift();
          failures.push(
            `${next.rows} rows refused and dropped: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (failures.length > 0) throw new Error(failures.join("; "));
    },
  };
}

export interface HeartbeatOptions {
  client: ControlPlaneClient;
  /** Describes what is running; read again on every beat, so a reload shows. */
  describe: () => Omit<Heartbeat, "instance" | "startedAt">;
  /** Default five minutes. */
  everyMs?: number;
  onError?: (message: string) => void;
  now?: () => number;
}

/**
 * Says, on start and then periodically, that a runtime is running and with
 * which program. Returns a function that stops it. Never throws.
 */
export function startHeartbeat(options: HeartbeatOptions): () => void {
  const instance = randomUUID();
  const startedAt = Math.floor((options.now ?? Date.now)() / 1000);
  const beat = async () => {
    try {
      await options.client.heartbeat({ instance, startedAt, ...options.describe() });
    } catch (error) {
      options.onError?.(
        `heartbeat failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  void beat();
  const timer = setInterval(() => void beat(), options.everyMs ?? 300_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
