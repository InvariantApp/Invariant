/**
 * The sponsored link: how a provider invites a consumer to connect.
 *
 * A provider mints a URL and sends it to a customer. The customer opens it,
 * installs the app on the repositories they choose, and the installation is
 * bound to that customer's account with that provider. Nothing else about the
 * customer's code ever reaches the provider - the binding exists so counters
 * and migrations can be attributed, not so anyone can look.
 *
 * The link is a bearer token in a URL, which means it will end up in a browser
 * history, a support ticket and somebody's Slack. So it is signed rather than
 * random, carries an expiry, and grants exactly one thing: the right to bind an
 * installation to one named consumer of one named API. Anyone holding it can do
 * that and nothing else.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export class LinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkError";
  }
}

export interface LinkClaims {
  api: string;
  /** The provider's own identifier for this customer. */
  consumer: string;
  /** Seconds since the epoch. */
  expiresAt: number;
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64url");
}

/**
 * Mints a link.
 *
 * The expiry is inside the signed payload rather than beside it, so it cannot
 * be edited by whoever holds the link.
 */
export function mintLink(
  claims: Omit<LinkClaims, "expiresAt">,
  options: { secret: string; ttlSeconds?: number; now?: number },
): string {
  if (!options.secret) throw new LinkError("a link cannot be minted without a secret");

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const body = encode({
    ...claims,
    expiresAt: now + (options.ttlSeconds ?? 7 * 24 * 60 * 60),
  } satisfies LinkClaims);

  return `${body}.${sign(body, options.secret)}`;
}

/**
 * Reads a link, and refuses it unless every part holds.
 *
 * Expiry is checked after the signature. Checking it first would let an
 * unsigned guess learn whether a payload it made up was in date, which is a
 * small leak and an unnecessary one.
 */
export function redeemLink(
  token: string,
  options: { secret: string; now?: number },
): LinkClaims {
  const separator = token.lastIndexOf(".");
  if (separator <= 0) throw new LinkError("this link is not in the expected form");

  const body = token.slice(0, separator);
  const provided = token.slice(separator + 1);

  const expected = Buffer.from(sign(body, options.secret), "utf8");
  const actual = Buffer.from(provided, "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new LinkError("this link was not issued by this service, or has been edited");
  }

  let claims: LinkClaims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as LinkClaims;
  } catch {
    throw new LinkError("this link is signed but its contents cannot be read");
  }

  if (
    claims === null ||
    typeof claims !== "object" ||
    typeof claims.api !== "string" ||
    typeof claims.consumer !== "string" ||
    typeof claims.expiresAt !== "number"
  ) {
    throw new LinkError("this link is missing something it needs");
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (claims.expiresAt <= now) {
    const days = Math.floor((now - claims.expiresAt) / 86_400);
    throw new LinkError(
      `this link expired ${days === 0 ? "today" : `${days} days ago`}. Ask for a new one.`,
    );
  }

  return claims;
}

/**
 * What connecting grants, written where a consumer can read it.
 *
 * Kept in code beside the thing it describes so the two cannot drift. A
 * permission added to the app manifest without a line here is a permission
 * nobody told the consumer about.
 */
export const REQUESTED_PERMISSIONS = [
  { scope: "metadata", access: "read", why: "to see which repositories exist" },
  {
    scope: "contents",
    access: "write",
    why: "to push a branch with the migration on it",
  },
  {
    scope: "pull_requests",
    access: "write",
    why: "to open that branch as a pull request",
  },
  {
    scope: "checks",
    access: "read",
    why: "to see whether your own CI passed, before marking the pull request ready",
  },
] as const;

/**
 * What is deliberately not asked for.
 *
 * Stated rather than implied. `workflows` would allow editing what runs in the
 * consumer's CI; `actions` would allow reading its secrets and logs. Neither is
 * needed to open a pull request, and asking for either would make this a much
 * larger thing to say yes to.
 */
export const REFUSED_PERMISSIONS = [
  "workflows",
  "actions",
  "administration",
  "members",
] as const;
