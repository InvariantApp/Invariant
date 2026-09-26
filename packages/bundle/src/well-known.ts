/**
 * `/.well-known/invariant.json`: the keys a provider signs releases with,
 * served from the provider's own domain.
 *
 * A consumer who runs a migration from a published bundle has to know the
 * bundle came from the provider. The service that distributes bundles cannot
 * be the one to say so: a registry that decides which keys are trusted can be
 * made to trust any key, by a bug, an insider, or whoever breaks into it. So
 * the keys live where only the provider can put them, on a domain whose TLS
 * certificate says it is theirs, and the service is only a cache that a
 * reader checks against them. A bundle signed by a key the provider does not
 * list is refused, however it arrived.
 *
 * This module is the document and the rule, with no network: what the
 * document says, whether one is well formed, which of its keys may vouch for
 * a given bundle, and opening a bundle on that basis. Fetching it is the
 * caller's, so a caller decides how it reaches the network and a test never
 * does.
 */
import { createPublicKey, type KeyObject } from "node:crypto";
import { type EvolutionBundle, openBundle } from "./build.ts";
import { type DsseEnvelope, keyIdOf } from "./dsse.ts";

/** Where the document is served, on the provider's own domain. */
export const WELL_KNOWN_PATH = "/.well-known/invariant.json";

/** The version of the document this build writes and understands. */
export const WELL_KNOWN_VERSION = 1;

export interface WellKnownKey {
  /** `sha256:` and the hex SHA-256 of the key's SPKI DER form, as a bundle's signature names it. */
  keyid: string;
  /** The public key, PEM encoded (SPKI). */
  public_key: string;
  /** When the key was first used to sign, RFC 3339. Nothing signed before it is the key's. */
  added_at: string;
  /** When the key stopped signing, RFC 3339. What it signed before stays valid. */
  not_after?: string;
  /** The key is withdrawn: nothing it ever signed is trusted, whenever it was signed. */
  revoked?: boolean;
  /** Why, for whoever reads the refusal. */
  revoked_reason?: string;
  /** The APIs this key signs for, when not all of the document's. */
  apis?: string[];
}

export interface WellKnownDocument {
  version: typeof WELL_KNOWN_VERSION;
  /** The APIs this domain publishes, by the id their bundles carry. */
  apis: string[];
  keys: WellKnownKey[];
  /** Where this provider's bundles are published, when not the hosted service. */
  bundles?: { url: string };
}

export class WellKnownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WellKnownError";
  }
}

/** Refused because the provider's own document does not vouch for the signer. */
export class UntrustedBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UntrustedBundleError";
  }
}

const API_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const KEY_ID = /^sha256:[0-9a-f]{64}$/;
// RFC 3339 with a zone, which Date.parse alone would not insist on: a time
// with no zone means something different on every machine that reads it.
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown, what: string): string {
  if (
    typeof value !== "string" ||
    !TIMESTAMP.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new WellKnownError(
      `${what} must be an RFC 3339 time with a zone, such as 2026-09-01T00:00:00Z, not ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function apiIds(value: unknown, what: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || !API_ID.test(entry))
  ) {
    throw new WellKnownError(
      `${what} must be a list of API ids, each lowercase letters, digits and dashes`,
    );
  }
  return [...(value as string[])];
}

/** A PEM public key read as one this build verifies with. */
function publicKey(pem: string, what: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new WellKnownError(`${what} is not a PEM public key`);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new WellKnownError(
      `${what} is ${key.asymmetricKeyType ?? "an unknown type"}, and bundles are signed with Ed25519`,
    );
  }
  return key;
}

/**
 * Reads a document, refusing anything a reader could misread. A field this
 * version does not know is ignored, so a later version can add one without
 * breaking the readers already out there; one it knows must be exactly what
 * it says, and a key must be the key its id names.
 */
export function parseWellKnown(value: unknown): WellKnownDocument {
  if (!isObject(value)) throw new WellKnownError("the document is not a JSON object");
  if (value["version"] !== WELL_KNOWN_VERSION) {
    throw new WellKnownError(
      `the document is version ${JSON.stringify(value["version"])}, and this build reads version ${WELL_KNOWN_VERSION}`,
    );
  }
  const apis = apiIds(value["apis"], "apis");
  if (!Array.isArray(value["keys"])) throw new WellKnownError("keys must be a list");
  const seen = new Set<string>();
  const keys = value["keys"].map((raw, index): WellKnownKey => {
    const what = `keys[${index}]`;
    if (!isObject(raw)) throw new WellKnownError(`${what} is not an object`);
    if (typeof raw["keyid"] !== "string" || !KEY_ID.test(raw["keyid"])) {
      throw new WellKnownError(`${what}.keyid must be sha256: and 64 hex digits`);
    }
    if (typeof raw["public_key"] !== "string") {
      throw new WellKnownError(`${what}.public_key must be a PEM public key`);
    }
    const computed = keyIdOf(publicKey(raw["public_key"], `${what}.public_key`));
    // The id is derived from the key, so one that disagrees is a document
    // someone edited by hand and got wrong, or one built to confuse a reader
    // that matches signatures by id.
    if (computed !== raw["keyid"]) {
      throw new WellKnownError(
        `${what}.keyid is ${raw["keyid"]}, but its public_key is ${computed}`,
      );
    }
    if (seen.has(computed)) throw new WellKnownError(`${what} lists ${computed} twice`);
    seen.add(computed);
    const key: WellKnownKey = {
      keyid: computed,
      public_key: raw["public_key"],
      added_at: timestamp(raw["added_at"], `${what}.added_at`),
    };
    if (raw["not_after"] !== undefined) {
      key.not_after = timestamp(raw["not_after"], `${what}.not_after`);
      if (Date.parse(key.not_after) <= Date.parse(key.added_at)) {
        throw new WellKnownError(`${what}.not_after is not after its added_at`);
      }
    }
    if (raw["revoked"] !== undefined) {
      if (typeof raw["revoked"] !== "boolean") {
        throw new WellKnownError(`${what}.revoked must be true or false`);
      }
      key.revoked = raw["revoked"];
    }
    if (raw["revoked_reason"] !== undefined) {
      if (typeof raw["revoked_reason"] !== "string") {
        throw new WellKnownError(`${what}.revoked_reason must be text`);
      }
      key.revoked_reason = raw["revoked_reason"];
    }
    if (raw["apis"] !== undefined) {
      key.apis = apiIds(raw["apis"], `${what}.apis`);
      const unknown = key.apis.filter((api) => !apis.includes(api));
      if (unknown.length > 0) {
        throw new WellKnownError(
          `${what}.apis names ${unknown.join(", ")}, which the document's apis do not`,
        );
      }
    }
    return key;
  });
  const document: WellKnownDocument = { version: WELL_KNOWN_VERSION, apis, keys };
  if (value["bundles"] !== undefined) {
    const bundles = value["bundles"];
    if (!isObject(bundles) || typeof bundles["url"] !== "string") {
      throw new WellKnownError(
        "bundles must be { url }, the service bundles are published to",
      );
    }
    let url: URL;
    try {
      url = new URL(bundles["url"]);
    } catch {
      throw new WellKnownError(`bundles.url is not a URL: ${bundles["url"]}`);
    }
    if (url.protocol !== "https:") throw new WellKnownError("bundles.url must be https");
    document.bundles = { url: bundles["url"] };
  }
  return document;
}

/** Why one of the document's keys cannot vouch for a bundle, or nothing when it can. */
export function keyRefusal(
  key: WellKnownKey,
  at: { api: string; signedAt: Date },
): string | undefined {
  if (key.revoked) {
    return `the provider revoked it${key.revoked_reason ? ` (${key.revoked_reason})` : ""}, so nothing it signed is trusted`;
  }
  if (key.apis && !key.apis.includes(at.api)) {
    return `the provider lists it for ${key.apis.join(", ")}, not ${at.api}`;
  }
  const time = at.signedAt.getTime();
  if (time < Date.parse(key.added_at)) {
    return `the bundle was published at ${at.signedAt.toISOString()}, before the key was added (${key.added_at})`;
  }
  if (key.not_after !== undefined && time > Date.parse(key.not_after)) {
    return `the bundle was published at ${at.signedAt.toISOString()}, after the key stopped signing (${key.not_after})`;
  }
  return undefined;
}

/**
 * Opens a bundle only if a key the provider's own document lists, and that
 * could sign for this API when it was signed, signed it. The refusals say
 * which rule failed, since "untrusted" alone leaves a consumer nothing to
 * tell the provider.
 *
 * `signedAt` is when the bundle was published. A bundle carries no time of
 * its own, deliberately, since a time would make it impossible to rebuild, so
 * this is the time the distributing service recorded, or now. That only
 * matters for a key past its `not_after`; a key that leaked is `revoked`,
 * which refuses everything it signed whatever time anyone claims.
 */
export function openWithWellKnown(
  envelope: DsseEnvelope,
  document: WellKnownDocument,
  at: { api: string; signedAt: Date; source: string },
): { bundle: EvolutionBundle; digest: string; keyid: string } {
  if (!document.apis.includes(at.api)) {
    throw new UntrustedBundleError(
      `${at.source} does not list the API ${at.api}; it lists ${document.apis.join(", ")}`,
    );
  }
  const signers = Array.isArray(envelope?.signatures)
    ? envelope.signatures.map((signature) => String(signature?.keyid))
    : [];
  const trusted: string[] = [];
  const refusals: string[] = [];
  for (const keyid of signers) {
    const key = document.keys.find((entry) => entry.keyid === keyid);
    if (!key) {
      refusals.push(`${keyid} is not a key ${at.source} lists`);
      continue;
    }
    const refusal = keyRefusal(key, at);
    if (refusal) refusals.push(`${keyid}: ${refusal}`);
    else trusted.push(key.public_key);
  }
  if (trusted.length === 0) {
    throw new UntrustedBundleError(
      `refused: no key the provider vouches for signed this bundle, whatever served it. ${refusals.join("; ") || "It carries no signatures."}`,
    );
  }
  const opened = openBundle(envelope, trusted);
  if (opened.bundle.api !== at.api) {
    throw new UntrustedBundleError(
      `refused: the bundle is for ${opened.bundle.api}, not ${at.api}`,
    );
  }
  return opened;
}

export interface WellKnownKeyInput {
  publicKeyPem: string;
  addedAt?: string;
  notAfter?: string;
  revoked?: boolean;
  revokedReason?: string;
}

/**
 * The document a provider publishes: the keys given, and every key of
 * `previous` kept, so a key rotated out still vouches for what it signed and
 * a revocation is never undone by regenerating the file. A key already listed
 * keeps its `added_at`; a new one is added `now`.
 */
export function buildWellKnown(input: {
  apis: readonly string[];
  keys: readonly WellKnownKeyInput[];
  previous?: WellKnownDocument;
  bundlesUrl?: string;
  now?: Date;
}): WellKnownDocument {
  const now = (input.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const keys = new Map<string, WellKnownKey>();
  for (const key of input.previous?.keys ?? []) keys.set(key.keyid, { ...key });
  for (const given of input.keys) {
    const pem = createPublicKey(given.publicKeyPem)
      .export({ type: "spki", format: "pem" })
      .toString();
    const keyid = keyIdOf(publicKey(pem, "a key"));
    const existing = keys.get(keyid);
    const key: WellKnownKey = existing ?? { keyid, public_key: pem, added_at: now };
    if (given.addedAt !== undefined) key.added_at = given.addedAt;
    if (given.notAfter !== undefined) key.not_after = given.notAfter;
    if (given.revoked) key.revoked = true;
    if (given.revokedReason !== undefined) key.revoked_reason = given.revokedReason;
    keys.set(keyid, key);
  }
  const apis = [...new Set([...(input.previous?.apis ?? []), ...input.apis])].sort();
  const document: Record<string, unknown> = {
    version: WELL_KNOWN_VERSION,
    apis,
    keys: [...keys.values()].sort(
      (a, b) => a.added_at.localeCompare(b.added_at) || a.keyid.localeCompare(b.keyid),
    ),
  };
  const bundles = input.bundlesUrl ?? input.previous?.bundles?.url;
  if (bundles !== undefined) document["bundles"] = { url: bundles };
  // Built through the reader, so what is printed is what every reader accepts.
  return parseWellKnown(document);
}
