/**
 * E9: what production reported after the release.
 *
 * Every other layer of evidence is produced before anything is deployed, which
 * makes them all predictions. This is the only one that is an observation, and
 * it is the only one that can say the predictions were right.
 *
 * It is deliberately a rate rather than a count. "Fourteen failed responses" is
 * not actionable: fourteen out of twenty is an emergency and fourteen out of
 * four million is a rounding error, and a provider reading a bare count cannot
 * tell which they have. So attempts are counted alongside failures, and the
 * number that gets reported is the one with a denominator.
 *
 * Nothing here can block a release. A release is very often the fix for what
 * this is reporting, and a gate that refused to let a fix through because
 * production was unhealthy would be actively harmful.
 */
import { readFile } from "node:fs/promises";
import { isJsonObject } from "@invariant-app/ir";
import { type Evidence, inputsDigest } from "@invariant-app/verifier";

/** One adapted request, response or outbound payload, as the runtime reported it. */
export interface OutcomeRecord {
  contract: string;
  operation: string;
  direction: "request" | "response" | "outbound";
  outcome: "adapted" | "refused" | "failed";
  count: number;
  reason?: string;
}

/**
 * The design's SLO: response transform errors under 0.01% of adapted responses.
 *
 * A response failure is the expensive kind. The operation already happened, so
 * a side effect has occurred and the caller is being handed an error for work
 * that succeeded. A request failure costs a retry and nothing else.
 */
export const RESPONSE_FAILURE_SLO = 0.0001;

export interface ContractHealth {
  contract: string;
  /** Responses rewritten successfully. */
  responsesAdapted: number;
  /** Responses that could not be expressed in the caller's contract. */
  responsesFailed: number;
  requestsAdapted: number;
  requestsRefused: number;
  /** Why requests were refused, most frequent first. */
  refusals: { reason: string; count: number }[];
}

function parse(value: unknown): OutcomeRecord | undefined {
  if (!isJsonObject(value)) return undefined;
  const { contract, operation, direction, outcome, count, reason } = value;
  if (
    typeof contract !== "string" ||
    typeof operation !== "string" ||
    (direction !== "request" && direction !== "response" && direction !== "outbound") ||
    (outcome !== "adapted" && outcome !== "refused" && outcome !== "failed") ||
    typeof count !== "number"
  ) {
    return undefined;
  }
  return {
    contract,
    operation,
    direction,
    outcome,
    count,
    ...(typeof reason === "string" ? { reason } : {}),
  };
}

/**
 * Reads an outcome ledger, ignoring lines it cannot read.
 *
 * Appended to by a running service and read by a tool, so a half-written last
 * line is ordinary. Refusing the whole file over one truncated record would
 * throw away every observation this system has.
 */
export async function readOutcomes(path: string): Promise<OutcomeRecord[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }

  const records: OutcomeRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const record = parse(JSON.parse(line));
      if (record) records.push(record);
    } catch {
      // A partial line at the end of a file being appended to.
    }
  }
  return records;
}

/** Folds a ledger into one row per contract. */
export function health(records: Iterable<OutcomeRecord>): ContractHealth[] {
  const byContract = new Map<string, ContractHealth>();
  const reasons = new Map<string, Map<string, number>>();

  for (const record of records) {
    let entry = byContract.get(record.contract);
    if (!entry) {
      entry = {
        contract: record.contract,
        responsesAdapted: 0,
        responsesFailed: 0,
        requestsAdapted: 0,
        requestsRefused: 0,
        refusals: [],
      };
      byContract.set(record.contract, entry);
    }

    // A webhook or callback payload fails after the fact, as a response does:
    // the work it reports on has already happened.
    if (record.direction === "response" || record.direction === "outbound") {
      if (record.outcome === "adapted") entry.responsesAdapted += record.count;
      else entry.responsesFailed += record.count;
      continue;
    }

    if (record.outcome === "adapted") {
      entry.requestsAdapted += record.count;
      continue;
    }

    entry.requestsRefused += record.count;
    const bucket = reasons.get(record.contract) ?? new Map<string, number>();
    const reason = record.reason ?? "unknown";
    bucket.set(reason, (bucket.get(reason) ?? 0) + record.count);
    reasons.set(record.contract, bucket);
  }

  for (const [contract, bucket] of reasons) {
    const entry = byContract.get(contract);
    if (!entry) continue;
    entry.refusals = [...bucket]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  }

  return [...byContract.values()].sort((a, b) => a.contract.localeCompare(b.contract));
}

function percent(part: number, whole: number): string {
  if (whole === 0) return "0%";
  const value = (part / whole) * 100;
  return value < 0.01 && value > 0 ? "under 0.01%" : `${value.toFixed(2)}%`;
}

/**
 * Turns observed health into evidence, one record per contract still served.
 *
 * A contract with no records at all gets a `skipped` record rather than a
 * passing one. No telemetry and no problems are the same silence, and a
 * release that reported them the same way would let a sink that was never
 * wired up read as a clean bill of health.
 */
export function outcomeEvidence(
  served: readonly string[],
  records: readonly OutcomeRecord[],
): Evidence[] {
  const byContract = new Map(health(records).map((entry) => [entry.contract, entry]));

  return served.map((contract) => {
    const found = byContract.get(contract);
    // Silence means no records at all. A contract where every single request
    // was refused is not silent, it is the loudest thing this file can say,
    // and reading it as "nothing reported" is exactly how a kill switch left
    // on by accident would go unnoticed.
    if (!found) {
      return {
        kind: "E9-runtime" as const,
        subject: contract,
        result: "skipped" as const,
        inputsDigest: inputsDigest(contract),
        tool: "invariant runtime",
        summary:
          "nothing reported. Either no caller used this contract, or the usage " +
          "sink is not wired up, and this cannot tell which",
      };
    }

    const responses = found.responsesAdapted + found.responsesFailed;
    const rate = responses === 0 ? 0 : found.responsesFailed / responses;
    const breached = rate > RESPONSE_FAILURE_SLO;

    const detail: string[] = [];
    if (found.responsesFailed > 0) {
      detail.push(
        `${found.responsesFailed} of ${responses} responses could not be expressed ` +
          `in this contract (${percent(found.responsesFailed, responses)}, against ` +
          `an objective of 0.01%). The operation had already run each time.`,
      );
    }
    for (const refusal of found.refusals) {
      detail.push(`${refusal.count} requests refused: ${refusal.reason}`);
    }

    return {
      kind: "E9-runtime" as const,
      subject: contract,
      result: breached ? ("fail" as const) : ("pass" as const),
      inputsDigest: inputsDigest(contract, found),
      tool: "invariant runtime",
      summary:
        `${found.requestsAdapted} requests and ${found.responsesAdapted} responses ` +
        `adapted, ${found.responsesFailed} responses failed ` +
        `(${percent(found.responsesFailed, responses)})` +
        (found.requestsRefused > 0 ? `, ${found.requestsRefused} requests refused` : ""),
      ...(detail.length > 0 ? { detail } : {}),
    };
  });
}
