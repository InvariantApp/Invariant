/**
 * What a release is allowed to count as proof.
 *
 * Nine kinds, each naming something a machine checked or a person did. The
 * list is closed on purpose: "the model was confident" is not on it, and there
 * is no kind that could carry it. Everything a reviewer sees in a pull request
 * traces back to one of these records, and every record names the inputs it
 * ran against so a claim cannot outlive the thing it was about.
 */
import { createHash } from "node:crypto";

export type EvidenceKind =
  /** The Change files parse as this version of the IR. */
  | "E1-schema"
  /** The declared Changes explain the whole breaking diff. */
  | "E2-closure"
  /** No schema-valid input reaches an undefined case. */
  | "E3-totality"
  /** Round trips hold, and each direction lands inside its own contract. */
  | "E4-laws"
  /** A chained program equals applying each step in turn. */
  | "E5-chain"
  /** The old build and the new build plus the adapter behave the same. */
  | "E6-differential"
  /** What the code actually returns matches what the specification claims. */
  | "E7-conformance"
  /** A person with write access merged it. */
  | "E8-merge"
  /** What production has since reported about it. */
  | "E9-runtime";

export type EvidenceResult = "pass" | "fail" | "skipped";

export interface Evidence {
  kind: EvidenceKind;
  /** A Change id, or the contract step this is about. */
  subject: string;
  result: EvidenceResult;
  /** Digest of exactly what was checked, so a stale record cannot be reused. */
  inputsDigest: string;
  /** What produced it. */
  tool: string;
  /** One line a reviewer can read. */
  summary: string;
  /** Detail worth keeping when it failed, or when it took work to pass. */
  detail?: string[];
}

/**
 * The digest that binds a record to its inputs.
 *
 * Two runs over the same specifications and the same Changes produce the same
 * digest, which is what lets a bundle be rebuilt and compared. A record whose
 * digest does not match the release it is attached to is not evidence about
 * that release.
 */
export function inputsDigest(...parts: unknown[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(JSON.stringify(part ?? null));
  return `sha256:${hash.digest("hex")}`;
}

export function passed(evidence: readonly Evidence[]): boolean {
  return evidence.every((entry) => entry.result !== "fail");
}

/** The kinds that must have run and passed before a release can be signed. */
export const REQUIRED_KINDS: readonly EvidenceKind[] = [
  "E1-schema",
  "E2-closure",
  "E3-totality",
  "E4-laws",
  "E5-chain",
];

export function missingRequired(evidence: readonly Evidence[]): EvidenceKind[] {
  const present = new Set(
    evidence.filter((entry) => entry.result === "pass").map((entry) => entry.kind),
  );
  return REQUIRED_KINDS.filter((kind) => !present.has(kind));
}
