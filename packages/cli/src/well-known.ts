/**
 * `invariant well-known`: the document a provider serves at
 * `https://<their domain>/.well-known/invariant.json`, so a consumer can
 * trust a published release without trusting the service it came from.
 *
 * It is made from what the provider already has: the API's id from
 * invariant.yaml, and the public half of each key it signs with. Given the
 * document published today, it keeps every key already listed, with the time
 * it was added and any revocation, because a key dropped from the document
 * stops vouching for everything it ever signed, and that should be a
 * decision rather than a side effect of regenerating a file.
 */
import { createPrivateKey, createPublicKey } from "node:crypto";
import {
  buildWellKnown,
  parseWellKnown,
  type WellKnownDocument,
  type WellKnownKeyInput,
} from "@invariant-app/bundle";
import type { InvariantConfig } from "./config.ts";

export class WellKnownCommandError extends Error {
  override name = "WellKnownCommandError";
}

export interface WellKnownOptions {
  /** Public keys to list, in PEM form. */
  keys: string[];
  /** The private key releases are signed with, whose public half is listed too. */
  signingKeyPem?: string;
  /** The document published today, as text. */
  previous?: string;
  /** Key ids to mark revoked: nothing they signed is trusted from then on. */
  revoke?: string[];
  /** Key ids that stop signing now; what they signed stays trusted. */
  retire?: string[];
  /** The service bundles are published to, when not the hosted one. */
  bundlesUrl?: string;
  now?: Date;
}

export function wellKnownDocument(
  config: Pick<InvariantConfig, "api">,
  options: WellKnownOptions,
): WellKnownDocument {
  const now = options.now ?? new Date();
  let previous: WellKnownDocument | undefined;
  if (options.previous !== undefined) {
    try {
      previous = parseWellKnown(JSON.parse(options.previous));
    } catch (error) {
      throw new WellKnownCommandError(
        `the document given with --from cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const keys: WellKnownKeyInput[] = options.keys.map((pem) => ({ publicKeyPem: pem }));
  if (options.signingKeyPem) {
    // Only the public half is ever written; the private key is read to find it.
    const publicKeyPem = createPublicKey(createPrivateKey(options.signingKeyPem))
      .export({ type: "spki", format: "pem" })
      .toString();
    keys.push({ publicKeyPem });
  }
  let document = buildWellKnown({
    apis: [config.api],
    keys,
    ...(previous ? { previous } : {}),
    ...(options.bundlesUrl ? { bundlesUrl: options.bundlesUrl } : {}),
    now,
  });
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const listed = new Set(document.keys.map((key) => key.keyid));
  for (const keyid of [...(options.revoke ?? []), ...(options.retire ?? [])]) {
    if (!listed.has(keyid)) {
      throw new WellKnownCommandError(
        `${keyid} is not a key the document lists; it lists ${[...listed].join(", ") || "none"}`,
      );
    }
  }
  document = {
    ...document,
    keys: document.keys.map((key) => {
      const next = { ...key };
      if (options.revoke?.includes(key.keyid)) next.revoked = true;
      if (options.retire?.includes(key.keyid) && next.not_after === undefined) {
        next.not_after = stamp;
      }
      return next;
    }),
  };
  if (document.keys.length === 0) {
    throw new WellKnownCommandError(
      "there is no key to list: pass --key with a public key, or set INVARIANT_SIGNING_KEY",
    );
  }
  return parseWellKnown(document);
}
