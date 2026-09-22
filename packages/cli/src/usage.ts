/**
 * What production has actually exercised.
 *
 * Stripe's stated reason for never upgrading an account's API version by
 * itself is that it cannot see which fields a consumer reads. The adapter can:
 * it is already touching exactly the fields a Change describes, so counting
 * them costs nothing extra and needs no separate telemetry pipeline.
 *
 * What is recorded is deliberately thin. A hashed consumer key, a contract
 * label, a change id, a count and a time. No bodies, no field values, nothing
 * that would make this file something a provider has to think about before
 * storing. It answers one question - is anyone still relying on this? - and
 * cannot answer any other.
 */
import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { isJsonObject } from "@invariant-app/ir";

export interface UsageRecord {
  /** Hash of the consumer's key, never the key. */
  consumer: string;
  contract: string;
  changeId: string;
  count: number;
  /** Seconds since the epoch, when this was last seen. */
  lastSeen: number;
}

export function hashConsumer(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** Folds a stream of records into one row per consumer, contract and change. */
export function aggregate(records: Iterable<UsageRecord>): UsageRecord[] {
  const byKey = new Map<string, UsageRecord>();

  for (const record of records) {
    const key = `${record.consumer}\u0000${record.contract}\u0000${record.changeId}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...record });
      continue;
    }
    existing.count += record.count;
    existing.lastSeen = Math.max(existing.lastSeen, record.lastSeen);
  }

  return [...byKey.values()].sort(
    (a, b) =>
      a.contract.localeCompare(b.contract) ||
      a.changeId.localeCompare(b.changeId) ||
      a.consumer.localeCompare(b.consumer),
  );
}

function parseRecord(value: unknown): UsageRecord | undefined {
  if (!isJsonObject(value)) return undefined;
  const { consumer, contract, changeId, count, lastSeen } = value;
  if (
    typeof consumer !== "string" ||
    typeof contract !== "string" ||
    typeof changeId !== "string" ||
    typeof count !== "number" ||
    typeof lastSeen !== "number"
  ) {
    return undefined;
  }
  return { consumer, contract, changeId, count, lastSeen };
}

/**
 * Reads a usage ledger, ignoring lines it cannot read.
 *
 * A ledger is appended to by a running service and read by a tool, so a
 * half-written final line is ordinary rather than exceptional. Refusing the
 * whole file over one truncated record would take a retirement decision out of
 * a provider's hands for no reason.
 */
export async function readLedger(path: string): Promise<UsageRecord[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }

  const records: UsageRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const record = parseRecord(JSON.parse(line));
      if (record) records.push(record);
    } catch {
      // A partial line at the end of a file being appended to.
    }
  }
  return aggregate(records);
}

export async function appendLedger(
  path: string,
  records: readonly UsageRecord[],
): Promise<void> {
  if (records.length === 0) return;
  await appendFile(
    path,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
}
