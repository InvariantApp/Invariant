/**
 * `invariant retire`: stopping the work nobody needs any more.
 *
 * Every compatibility layer ever built has the same ending, which is that it
 * never ends. Transforms accumulate because nobody can prove a consumer stopped
 * needing one, so every old contract is served forever and the cost of the
 * first breaking change is paid again on every release after it.
 *
 * The counters are what make the ending possible. The adapter already touches
 * exactly the fields a Change describes, so it knows whether anyone is still
 * being served by it. When nobody has been for long enough, this says so, and
 * what a provider merges is the removal.
 *
 * It only ever proposes. Deciding that silence means absence is a judgement
 * about a business, not about a program: a consumer that calls once a quarter
 * is idle for eighty-nine days and then very much not idle. So the window is
 * the provider's, the evidence is shown alongside the recommendation, and the
 * removal is a commit somebody makes.
 */
import { readFile, writeFile } from "node:fs/promises";
import type { InvariantConfig } from "./config.ts";
import type { UsageRecord } from "./usage.ts";

export class RetireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetireError";
  }
}

export interface ContractUsage {
  contract: string;
  /** Distinct consumers seen on this contract within the window. */
  consumers: string[];
  /** Total transforms applied. */
  count: number;
  /** Seconds since the epoch, or undefined when never seen at all. */
  lastSeen: number | undefined;
}

export type RetireVerdict =
  /** Someone is using it. */
  | "active"
  /** Nobody has for longer than the window. */
  | "idle"
  /** Nobody ever has, which is not the same thing. */
  | "never-seen";

export interface ContractReport {
  contract: string;
  verdict: RetireVerdict;
  usage: ContractUsage;
  /** Days since anything was seen, or undefined when nothing ever was. */
  quietDays: number | undefined;
  /** Why the verdict is what it is, for a person deciding. */
  reason: string;
}

export interface RetireReport {
  api: string;
  /** How long a contract has to be quiet before it is reported as idle. */
  windowDays: number;
  contracts: ContractReport[];
  /** Contracts safe to stop serving, oldest first. */
  retirable: string[];
  /** The one that cannot be retired however quiet it is. */
  current: string;
}

const DAY_SECONDS = 86_400;

export const DEFAULT_WINDOW_DAYS = 30;

/**
 * Whether each served contract is still carrying anyone.
 *
 * `never-seen` is kept apart from `idle` on purpose. A contract with no
 * recorded traffic at all is far more likely to mean the counters were never
 * wired up than that every consumer left, and retiring an old contract because
 * of a missing sink would break exactly the integrations this exists to
 * protect.
 */
export function assessRetirement(
  config: InvariantConfig,
  usage: readonly UsageRecord[],
  options: { windowDays?: number; now?: number } = {},
): RetireReport {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const cutoff = now - windowDays * DAY_SECONDS;

  const served = [...config.releasedSpecs.keys()].sort();
  const current = served[served.length - 1] ?? "";

  const byContract = new Map<string, ContractUsage>();
  for (const label of served) {
    byContract.set(label, {
      contract: label,
      consumers: [],
      count: 0,
      lastSeen: undefined,
    });
  }

  for (const record of usage) {
    const entry = byContract.get(record.contract);
    if (!entry) continue;
    entry.count += record.count;
    entry.lastSeen = Math.max(entry.lastSeen ?? 0, record.lastSeen);
    if (!entry.consumers.includes(record.consumer)) entry.consumers.push(record.consumer);
  }

  const contracts: ContractReport[] = served.map((label) => {
    const entry = byContract.get(label) as ContractUsage;
    entry.consumers.sort();

    // The newest served contract is what a caller who says nothing gets, so it
    // is not a candidate however quiet it looks.
    if (label === current) {
      return {
        contract: label,
        verdict: "active",
        usage: entry,
        quietDays: undefined,
        reason: "this is the contract a caller who declares nothing is served",
      };
    }

    if (entry.lastSeen === undefined) {
      return {
        contract: label,
        verdict: "never-seen",
        usage: entry,
        quietDays: undefined,
        reason:
          "nothing has ever been recorded against it, which is more likely to " +
          "mean the counters are not reaching this tool than that every " +
          "consumer left. Check the usage sink before retiring it.",
      };
    }

    const quietDays = Math.floor((now - entry.lastSeen) / DAY_SECONDS);
    if (entry.lastSeen >= cutoff) {
      return {
        contract: label,
        verdict: "active",
        usage: entry,
        quietDays,
        reason:
          `${entry.consumers.length} ${entry.consumers.length === 1 ? "consumer" : "consumers"} ` +
          `still served, last ${quietDays === 0 ? "today" : `${quietDays} days ago`}`,
      };
    }

    return {
      contract: label,
      verdict: "idle",
      usage: entry,
      quietDays,
      reason:
        `nothing served for ${quietDays} days, against a window of ${windowDays}. ` +
        `${entry.consumers.length} ${entry.consumers.length === 1 ? "consumer" : "consumers"} used it before that.`,
    };
  });

  /**
   * Only a prefix can be retired, and only in order.
   *
   * Contracts form a chain, and the program for an old one is built by walking
   * every step from it to current. Removing a middle step would break the
   * chain for everything older than it, so the first contract anyone is still
   * using stops the list there even if something older is quieter.
   */
  const retirable: string[] = [];
  for (const report of contracts) {
    if (report.verdict !== "idle") break;
    retirable.push(report.contract);
  }

  return { api: config.api, windowDays, contracts, retirable, current };
}

/**
 * Removes a retired contract from the ones the provider serves.
 *
 * Edited as text rather than reserialised. A provider's configuration file has
 * their comments in it, and a tool that reformats the whole thing to change one
 * line produces a pull request nobody can review.
 */
export async function retireContracts(
  configPath: string,
  labels: readonly string[],
): Promise<{ removed: string[]; text: string }> {
  const original = await readFile(configPath, "utf8");
  let text = original;
  const removed: string[] = [];

  // A label can appear twice: once as a contract being served, and once as the
  // one a caller who declares nothing falls back to. Removing the first
  // without the second leaves every such caller pointed at a contract that no
  // longer exists, which is a worse outage than the one retirement was meant
  // to avoid. The provider picks the new default, so this refuses instead.
  for (const label of labels) {
    const fallback = new RegExp(
      `kind:\\s*default[\\s\\S]{0,200}?label:\\s*["']?${escapeLabel(label)}["']?`,
      "m",
    );
    if (fallback.test(original)) {
      throw new RetireError(
        `${label} is the contract a caller who declares nothing is served, so ` +
          "removing it would break every one of them. Point `identity` at a " +
          "newer contract first, then retire this one.",
      );
    }
  }

  for (const label of labels) {
    // The line that maps this label to its specification, with whatever
    // indentation and quoting the provider wrote.
    const pattern = new RegExp(
      `^[ \\t]*["']?${escapeLabel(label)}["']?[ \\t]*:.*\\r?\\n`,
      "m",
    );
    if (!pattern.test(text)) continue;
    text = text.replace(pattern, "");
    removed.push(label);
  }

  if (removed.length === 0) {
    throw new RetireError(
      `none of ${labels.join(", ")} appear under spec.released in ${configPath}`,
    );
  }

  await writeFile(configPath, text, "utf8");
  return { removed, text };
}

/** A contract label inside a pattern, with nothing in it treated as syntax. */
function escapeLabel(label: string): string {
  return label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function renderRetirement(report: RetireReport): string {
  const lines: string[] = [`Contract retirement - ${report.api}`, ""];

  for (const entry of report.contracts) {
    const mark =
      entry.verdict === "idle" ? "-" : entry.verdict === "never-seen" ? "?" : "+";
    lines.push(`  ${mark} ${entry.contract}: ${entry.reason}`);
  }

  lines.push("");
  if (report.retirable.length === 0) {
    const waiting = report.contracts.filter((entry) => entry.verdict === "active");
    lines.push(
      waiting.length > 1
        ? `Nothing to retire: ${waiting[0]?.contract} is still carrying traffic.`
        : "Nothing to retire.",
    );
    return lines.join("\n");
  }

  lines.push(
    `Safe to stop serving: ${report.retirable.join(", ")}`,
    "",
    "Removing these drops their transforms from the next compiled program, so",
    "every release after it costs less. Run with --write to edit invariant.yaml,",
    "then open it as a pull request like any other change.",
  );

  return lines.join("\n");
}
