/**
 * Counters handed to an OpenTelemetry meter, under the names the design
 * gives them (DESIGN 11.3).
 *
 * Typed by shape rather than by importing the OpenTelemetry API, so a
 * provider's own meter, of whatever version, is accepted as it is and this
 * package depends on nothing.
 */
import type { Batch, Sink } from "./index.ts";

type Attributes = Record<string, string>;

export interface Meter {
  createCounter(
    name: string,
    options?: { description?: string; unit?: string },
  ): { add(value: number, attributes?: Attributes): void };
}

export function meterSink(meter: Meter): Sink {
  const applied = meter.createCounter("invariant.change_applied", {
    description: "Times a Change was applied for a caller on an old contract.",
  });
  const adapted = meter.createCounter("invariant.adapted", {
    description: "Requests, responses and payloads adapted to a caller's contract.",
  });
  const refused = meter.createCounter("invariant.refused", {
    description: "Requests refused before the handler ran, so nothing happened.",
  });
  const failed = meter.createCounter("invariant.transform_error", {
    description:
      "Responses and payloads that could not be expressed in the caller's contract after the operation ran.",
  });

  return {
    name: "meter",
    async write(batch: Batch) {
      for (const row of batch.usage) {
        applied.add(row.count, { contract: row.contract, change: row.changeId });
      }
      for (const row of batch.outcomes) {
        const attributes = {
          contract: row.contract,
          operation: row.operation,
          direction: row.direction,
        };
        const counter =
          row.outcome === "adapted"
            ? adapted
            : row.outcome === "refused"
              ? refused
              : failed;
        counter.add(row.count, attributes);
      }
    },
  };
}
