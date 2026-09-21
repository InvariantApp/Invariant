/**
 * Signing a bundle.
 *
 * DSSE, because the alternative is signing raw JSON and hoping nobody
 * re-serializes it. DSSE's pre-authentication encoding puts the payload type
 * and both lengths in front of the bytes being signed, so a signature over a
 * bundle cannot be lifted onto a document of some other type, and no amount of
 * whitespace or key reordering downstream changes what was signed.
 *
 * The payload is an in-toto Statement, which is not invention for its own sake:
 * it means the existing attestation ecosystem can verify these without knowing
 * anything about API evolution. Ed25519 through `node:crypto`, so there is no
 * cryptographic dependency to audit and nothing to keep up to date.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";
import { BRAND } from "@invariant/ir";

export const PAYLOAD_TYPE = "application/vnd.in-toto+json";
export const PREDICATE_TYPE = BRAND.predicateType;

export interface Signature {
  /** Which key signed it. A digest of the public key, not a name anyone chose. */
  keyid: string;
  sig: string;
}

export interface DsseEnvelope {
  payload: string;
  payloadType: string;
  signatures: Signature[];
}

export class SignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignatureError";
  }
}

/**
 * DSSE pre-authentication encoding.
 *
 * `DSSEv1 <len(type)> <type> <len(body)> <body)>`, with lengths in bytes rather
 * than characters. Signing the payload alone would let a signature be replayed
 * against a different payload type, which is the whole reason this exists.
 */
export function pae(payloadType: string, payload: Buffer): Buffer {
  const type = Buffer.from(payloadType, "utf8");
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${type.length} `, "utf8"),
    type,
    Buffer.from(` ${payload.length} `, "utf8"),
    payload,
  ]);
}

/**
 * A stable name for a key, derived from the key itself.
 *
 * Deriving it means a key cannot be given a name that belongs to another one,
 * and two people who set up signing independently arrive at the same id for the
 * same key without coordinating.
 */
export function keyIdOf(publicKey: KeyObject): string {
  const der = publicKey.export({ type: "spki", format: "der" });
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

export function sign(payload: string, privateKeyPem: string): DsseEnvelope {
  let key: KeyObject;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch (error) {
    throw new SignatureError(
      `the signing key could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new SignatureError(
      `the signing key is ${key.asymmetricKeyType ?? "an unknown type"}, and bundles are signed with ed25519`,
    );
  }

  const body = Buffer.from(payload, "utf8");
  const signature = nodeSign(null, pae(PAYLOAD_TYPE, body), key);

  return {
    payload: body.toString("base64"),
    payloadType: PAYLOAD_TYPE,
    signatures: [
      { keyid: keyIdOf(createPublicKey(key)), sig: signature.toString("base64") },
    ],
  };
}

/**
 * Returns the payload only if a trusted key actually signed it.
 *
 * An envelope carrying no signature from any key in `trusted` is refused
 * outright rather than returned with a flag, because a caller who forgets to
 * check the flag ends up trusting an unsigned document, and that failure mode
 * is silent.
 */
export function verify(
  envelope: DsseEnvelope,
  trustedPublicKeysPem: readonly string[],
): { payload: string; keyid: string } {
  if (envelope.payloadType !== PAYLOAD_TYPE) {
    throw new SignatureError(
      `this envelope carries ${envelope.payloadType}, not ${PAYLOAD_TYPE}`,
    );
  }
  if (trustedPublicKeysPem.length === 0) {
    throw new SignatureError("no trusted keys were given, so nothing can be verified");
  }

  const body = Buffer.from(envelope.payload, "base64");
  const encoded = pae(envelope.payloadType, body);

  for (const pem of trustedPublicKeysPem) {
    const key = createPublicKey(pem);
    const keyid = keyIdOf(key);
    for (const signature of envelope.signatures) {
      // The key id narrows which signature to try; it is a hint, never the
      // thing being trusted. The signature itself is what has to verify.
      if (signature.keyid !== keyid) continue;
      if (nodeVerify(null, encoded, key, Buffer.from(signature.sig, "base64"))) {
        return { payload: body.toString("utf8"), keyid };
      }
      throw new SignatureError(
        `the signature from ${keyid} does not match the payload. ` +
          "Either the bundle was altered after signing, or it was signed by a different key.",
      );
    }
  }

  throw new SignatureError(
    "none of the trusted keys signed this bundle. " +
      `It carries signatures from: ${envelope.signatures.map((entry) => entry.keyid).join(", ") || "nobody"}.`,
  );
}

/** A key pair for tests and for a provider setting up their CI for the first time. */
export function generateSigningKey(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}
