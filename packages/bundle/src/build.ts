/**
 * The Evolution Bundle: everything a release claims, in one addressable object.
 *
 * The bundle is not the primitive. The Change is, and it lives in the
 * provider's repository where a person reviewed and merged it. What the bundle
 * adds is distribution: a consumer, a registry, or a migration run needs the
 * whole release in one object that says what it is, proves nobody edited it,
 * and can be rebuilt from source to check that claim.
 *
 * Reproducibility is the property that matters most, and it is a consequence of
 * the shape rather than a promise about the process. Same contracts, same
 * Changes, same compiled program produce the same canonical bytes and therefore
 * the same digest. Nothing derived from the moment of building - no timestamp,
 * no hostname, no ordering that depends on a filesystem - is allowed inside the
 * part that is digested, because any one of them would make "rebuild it and
 * compare" impossible and leave the signature as the only thing anyone could
 * check.
 */
import { canonicalize, digestOf } from "@invariant/contract";
import type { Change, CompiledProgram, JsonValue } from "@invariant/ir";
import type { Evidence } from "@invariant/verifier";
import { type DsseEnvelope, PREDICATE_TYPE, sign, verify } from "./dsse.ts";

export const BUNDLE_VERSION = 1;

export interface BundleSource {
  repo: string;
  commit: string;
  /** Pull request number, when the release came from one. */
  pr?: number;
}

export interface ContractRef {
  label: string;
  digest: string;
}

export interface EvolutionBundle {
  bundleVersion: number;
  api: string;
  from: ContractRef;
  to: ContractRef;
  source: BundleSource;
  /** Every Change in this step, in the order they apply going forward. */
  changes: Change[];
  evidence: Evidence[];
  compiled: { programDigest: string };
  gate: { result: "pass" | "warn" | "block"; unexplained: string[] };
}

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleError";
  }
}

/**
 * The in-toto Statement a bundle is signed as.
 *
 * The subject is the bundle's own digest, so the statement is about a specific
 * object rather than about "the latest release", and a verifier that knows
 * nothing about API evolution can still check that the thing it holds is the
 * thing that was signed.
 */
export interface Statement {
  _type: "https://in-toto.io/Statement/v1";
  subject: { name: string; digest: { sha256: string } }[];
  predicateType: string;
  predicate: EvolutionBundle;
}

export interface BuildInput {
  api: string;
  from: ContractRef;
  to: ContractRef;
  source: BundleSource;
  changes: readonly Change[];
  evidence: readonly Evidence[];
  program: CompiledProgram;
  gate: { result: "pass" | "warn" | "block"; unexplained: readonly string[] };
}

/**
 * A release that is blocked does not get a bundle.
 *
 * Publishing one would put a signature on an object whose own gate says it
 * should not ship, and a signature says "this is what we released" to everyone
 * downstream. Refusing here keeps the signature meaning that.
 */
export function buildBundle(input: BuildInput): {
  bundle: EvolutionBundle;
  digest: string;
} {
  if (input.gate.result === "block") {
    throw new BundleError(
      "this release is blocked, so there is nothing to publish. " +
        `Unresolved: ${input.gate.unexplained.join("; ") || "see the check report"}`,
    );
  }
  if (input.changes.length === 0) {
    throw new BundleError(
      "a bundle with no Changes describes nothing. An additive-only release " +
        "advances the current contract in place rather than minting a step.",
    );
  }

  const bundle: EvolutionBundle = {
    bundleVersion: BUNDLE_VERSION,
    api: input.api,
    from: input.from,
    to: input.to,
    source: input.source,
    changes: [...input.changes],
    // Sorted by a total order over the record's own content. Evidence arrives
    // in whatever order the layers ran, and that order can depend on the
    // filesystem, which would make two builds of the same release differ.
    evidence: [...input.evidence].sort(compareEvidence),
    compiled: { programDigest: digestOf(input.program as unknown as JsonValue) },
    gate: { result: input.gate.result, unexplained: [...input.gate.unexplained] },
  };

  return { bundle, digest: digestOf(bundle as unknown as JsonValue) };
}

function compareEvidence(a: Evidence, b: Evidence): number {
  return (
    a.kind.localeCompare(b.kind) ||
    a.subject.localeCompare(b.subject) ||
    a.inputsDigest.localeCompare(b.inputsDigest)
  );
}

export function statementFor(bundle: EvolutionBundle, digest: string): Statement {
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      {
        name: `${bundle.api}/${bundle.to.label}`,
        digest: { sha256: digest.replace(/^sha256:/, "") },
      },
    ],
    predicateType: PREDICATE_TYPE,
    predicate: bundle,
  };
}

export function signBundle(
  bundle: EvolutionBundle,
  digest: string,
  privateKeyPem: string,
): DsseEnvelope {
  return sign(
    canonicalize(statementFor(bundle, digest) as unknown as JsonValue),
    privateKeyPem,
  );
}

/**
 * Opens an envelope, and refuses it unless everything about it holds together.
 *
 * Three things are checked and all three matter. A trusted key signed it, or it
 * is not from anyone. The statement says it is an evolution bundle, so a
 * signature over some other kind of attestation cannot be presented as one. And
 * the digest the statement names is the digest the bundle actually has, so a
 * payload cannot be swapped underneath a subject that still looks right.
 */
export function openBundle(
  envelope: DsseEnvelope,
  trustedPublicKeysPem: readonly string[],
): { bundle: EvolutionBundle; digest: string; keyid: string } {
  const { payload, keyid } = verify(envelope, trustedPublicKeysPem);

  let statement: Statement;
  try {
    statement = JSON.parse(payload) as Statement;
  } catch {
    throw new BundleError("the signed payload is not JSON");
  }

  if (statement.predicateType !== PREDICATE_TYPE) {
    throw new BundleError(
      `this is an attestation of type ${statement.predicateType}, not an evolution bundle`,
    );
  }

  const bundle = statement.predicate;
  if (bundle?.bundleVersion !== BUNDLE_VERSION) {
    throw new BundleError(
      `this bundle is version ${bundle?.bundleVersion}, and this build understands version ${BUNDLE_VERSION}`,
    );
  }

  const digest = digestOf(bundle as unknown as JsonValue);
  const claimed = statement.subject?.[0]?.digest?.sha256;
  if (claimed === undefined || `sha256:${claimed}` !== digest) {
    throw new BundleError(
      `the statement is about sha256:${claimed ?? "nothing"} but the bundle inside it digests to ${digest}`,
    );
  }

  return { bundle, digest, keyid };
}

/**
 * Whether rebuilding from source produced the same object.
 *
 * This is what a registry runs on publish. A bundle nobody can rebuild is a
 * bundle nobody can audit: the signature would prove who sent it and nothing at
 * all about whether it describes the release it claims to.
 */
export function reproduces(
  bundle: EvolutionBundle,
  rebuilt: EvolutionBundle,
): {
  same: boolean;
  differences: string[];
} {
  const left = canonicalize(bundle as unknown as JsonValue);
  const right = canonicalize(rebuilt as unknown as JsonValue);
  if (left === right) return { same: true, differences: [] };

  const differences: string[] = [];
  for (const key of Object.keys(bundle) as (keyof EvolutionBundle)[]) {
    const a = canonicalize(bundle[key] as unknown as JsonValue);
    const b = canonicalize(rebuilt[key] as unknown as JsonValue);
    if (a !== b) differences.push(key);
  }
  return { same: false, differences };
}
