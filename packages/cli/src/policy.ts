/**
 * The part of the gate a provider configures.
 *
 * Almost nothing is. An unexplained breaking change and a failed verification
 * always block, because a gate that can be told to wave those through is not a
 * gate. What `invariant.yaml` decides is how strictly two judgements are
 * enforced: a Change that loses information and nobody has said is fine, and a
 * Change nothing can serve while somebody is still being served by the old
 * contract.
 *
 * Both settings were parsed and then never read, so a provider who wrote
 * `block` got `warn`. That is worse than having no setting, because it looks
 * like a decision was made.
 */
import { derive, missingAcknowledgement } from "@invariant/compiler";
import type { Change } from "@invariant/ir";
import type { GateLevel, InvariantConfig } from "./config.ts";
import { DEFAULT_WINDOW_DAYS } from "./retire.ts";
import type { UsageRecord } from "./usage.ts";

export interface PolicyOutcome {
  /** Reasons this release is blocked by the repository's own policy. */
  blocks: string[];
  warnings: string[];
}

const DAY_SECONDS = 86_400;

function route(
  level: GateLevel,
  message: string,
  outcome: PolicyOutcome,
  pending: boolean,
): void {
  // A step already released was weighed when it was made. Blocking this
  // release over it would refuse a change for something it did not do.
  if (level === "block" && pending) outcome.blocks.push(message);
  else if (level !== "allow") outcome.warnings.push(message);
}

/**
 * Contracts somebody has been served on within the retirement window.
 *
 * The same window `invariant retire` uses, so a contract this calls active is
 * exactly one that command would refuse to retire.
 */
export function activeContracts(
  config: InvariantConfig,
  usage: readonly UsageRecord[],
  now: number = Math.floor(Date.now() / 1000),
): string[] {
  const cutoff = now - DEFAULT_WINDOW_DAYS * DAY_SECONDS;
  const served = new Set(config.releasedSpecs.keys());
  const active = new Set<string>();
  for (const record of usage) {
    if (served.has(record.contract) && record.lastSeen >= cutoff)
      active.add(record.contract);
  }
  return [...active].sort();
}

/**
 * Applies the configured levels to this release's Changes.
 *
 * `usage` is undefined when no ledger exists, which is not the same as an
 * empty one: a provider who never wired up the counters has not shown that
 * nobody is left, and is told so rather than being given a pass.
 */
export function applyGatePolicy(
  config: InvariantConfig,
  steps: { changes: readonly Change[]; pending: boolean }[],
  usage: readonly UsageRecord[] | undefined,
  now?: number,
): PolicyOutcome {
  const outcome: PolicyOutcome = { blocks: [], warnings: [] };
  const active = usage === undefined ? undefined : activeContracts(config, usage, now);

  for (const { change, pending } of steps.flatMap((step) =>
    step.changes.map((change) => ({ change, pending: step.pending })),
  )) {
    // A change that cannot be served exactly has to say so in its own file.
    // Deriving the class and then letting it pass unmentioned would put the
    // judgement in the tool rather than with the person accountable for it.
    const derived = derive(change);
    if (missingAcknowledgement(change, derived)) {
      route(
        config.gate.declaredLossy,
        `${change.id} is ${derived.runtime} and does not acknowledge it. ` +
          `Add loss_acknowledged: true, having read why: ${derived.reasons[0] ?? ""}`,
        outcome,
        pending,
      );
    }

    if (derived.runtime !== "none") continue;
    outcome.warnings.push(
      `${change.id} cannot be served to an old caller at all. ${derived.reasons[0] ?? ""}`,
    );

    // A behaviour change is served by the provider's own code branching on
    // its flag, which is exactly what it declares. Only a change nothing can
    // serve at all is weighed against who is still calling.
    if (!pending || change.ops.some((op) => op.op === "behavior")) continue;
    const level = config.gate.unmigratableWithActiveConsumers;
    if (level === "allow") continue;

    if (active === undefined) {
      outcome.warnings.push(
        `${change.id} breaks every caller still on an older contract, and there is ` +
          "no usage ledger to say whether any are left. Wire the runtime's counters " +
          "to invariant/usage.jsonl, or pass --usage, before relying on this.",
      );
    } else if (active.length > 0) {
      route(
        level,
        `${change.id} cannot be served to an old caller, and contract ` +
          `${active.join(", ")} ${active.length === 1 ? "has" : "have"} been used in ` +
          `the last ${DEFAULT_WINDOW_DAYS} days.`,
        outcome,
        pending,
      );
    }
  }

  return outcome;
}
