/**
 * What Invariant treats as breaking.
 *
 * oasdiff's levels describe how confident it is that a change breaks someone,
 * given only the specification. Invariant needs a different question answered:
 * could an existing consumer notice? So every ERR counts, and a pinned set of
 * WARNs counts too, because oasdiff downgrades those only for lack of evidence
 * in the spec rather than because they are safe.
 *
 * The set is explicit and pinned rather than derived, so upgrading oasdiff can
 * never silently widen or narrow what a release is allowed to ship.
 */
import type { DiffEntry } from "./oasdiff.ts";

export const LEVEL_ERR = 3;
export const LEVEL_WARN = 2;
export const LEVEL_INFO = 1;

/** WARN-level ids Invariant still treats as breaking. */
export const BREAKING_WARN_IDS: ReadonlySet<string> = new Set([
  "request-property-removed",
  "request-parameter-removed",
  "request-property-became-nullable",
  "response-property-became-nullable",
  "request-body-became-required",
  "api-operation-id-removed",
]);

/**
 * INFO-level ids that Invariant also refuses to ignore. Adding a required
 * response property is additive for a tolerant reader but changes the contract
 * a strict one validates against, and Invariant promises the old contract
 * exactly.
 */
export const BREAKING_INFO_IDS: ReadonlySet<string> = new Set([
  "response-required-property-added",
  "response-property-enum-value-removed",
]);

export function isBreaking(entry: DiffEntry): boolean {
  if (entry.level >= LEVEL_ERR) return true;
  if (entry.level === LEVEL_WARN) return BREAKING_WARN_IDS.has(entry.id);
  return BREAKING_INFO_IDS.has(entry.id);
}

export function breakingEntries(entries: readonly DiffEntry[]): DiffEntry[] {
  return entries.filter(isBreaking);
}

export function additiveEntries(entries: readonly DiffEntry[]): DiffEntry[] {
  return entries.filter((entry) => !isBreaking(entry));
}

export function describeEntry(entry: DiffEntry): string {
  return `${entry.id} at ${entry.operation} ${entry.path}: ${entry.text}`;
}

/** A stable digest of the policy, recorded in a bundle's gate result. */
export function policyDigestInput(): string {
  return JSON.stringify({
    err: "all",
    warn: [...BREAKING_WARN_IDS].sort(),
    info: [...BREAKING_INFO_IDS].sort(),
  });
}
