/**
 * Accepting a webhook, and the several ways not to.
 *
 * This endpoint is public, unauthenticated and reachable by anyone who finds
 * the URL. Everything downstream of it - cloning a consumer's repository,
 * running a migration, opening a pull request - is work someone else's request
 * can cause, so the whole security of the delivery path is decided here.
 *
 * Three checks, and each one covers something the others do not. The signature
 * proves GitHub sent it. The timestamp stops a captured request being replayed
 * a week later. The delivery id stops the same one being replayed a second
 * later, which the timestamp cannot.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export class WebhookError extends Error {
  /** Status to answer with. 4xx means do not retry; GitHub honours that. */
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "WebhookError";
    this.status = status;
  }
}

export interface WebhookRequest {
  /** The raw bytes as received. Re-serialising before checking defeats this. */
  body: string;
  headers: {
    "x-hub-signature-256"?: string | undefined;
    "x-github-event"?: string | undefined;
    "x-github-delivery"?: string | undefined;
  };
}

export interface VerifiedWebhook {
  event: string;
  delivery: string;
  payload: Record<string, unknown>;
}

/**
 * Remembers which deliveries have been handled.
 *
 * GitHub retries, and a retry carries the same delivery id, so "have I seen
 * this" is the difference between opening one pull request and opening five.
 * In one process this is a Map; a deployment with more than one needs the same
 * thing somewhere shared, which is why it is an interface rather than a
 * variable.
 */
export interface DeliveryLog {
  seen(delivery: string): Promise<boolean>;
  record(delivery: string): Promise<void>;
}

/** The in-process log, bounded so a long-running service cannot grow forever. */
export function memoryDeliveryLog(limit = 10_000): DeliveryLog {
  const seen = new Set<string>();
  return {
    seen: async (delivery) => seen.has(delivery),
    record: async (delivery) => {
      if (seen.size >= limit) {
        // Oldest first. Insertion order is what a Set iterates in.
        const oldest = seen.values().next();
        if (!oldest.done) seen.delete(oldest.value);
      }
      seen.add(delivery);
    },
  };
}

/**
 * Compares two signatures without leaking which byte differed.
 *
 * A plain `===` on a hex string returns as soon as it finds a difference, and
 * the time that takes is a measurement of how much of the prefix was right.
 * Guessing a signature one byte at a time is a known attack, and this is a
 * cheap way not to be vulnerable to it.
 */
function signaturesMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  // Different lengths cannot be compared in constant time, and a wrong length
  // is a wrong signature anyway.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function signPayload(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

export interface VerifyOptions {
  secret: string;
  /**
   * Where handled delivery ids are kept, which is the replay protection.
   * GitHub sends no timestamp header, so an age check cannot be done here;
   * `isFresh` exists for a caller that can find one inside a payload.
   */
  log?: DeliveryLog;
}

/**
 * Verifies a delivery and returns what it carried, or refuses it.
 *
 * The order matters: nothing is parsed until the signature has been checked,
 * so a hostile body never reaches a parser on the strength of being
 * well-formed.
 */
export async function verifyWebhook(
  request: WebhookRequest,
  options: VerifyOptions,
): Promise<VerifiedWebhook> {
  if (!options.secret) {
    throw new WebhookError(
      500,
      "no webhook secret is configured, so nothing can be trusted",
    );
  }

  const provided = request.headers["x-hub-signature-256"];
  if (!provided) {
    throw new WebhookError(401, "this request carries no signature");
  }
  if (!signaturesMatch(signPayload(request.body, options.secret), provided)) {
    throw new WebhookError(401, "the signature does not match the body");
  }

  const event = request.headers["x-github-event"];
  const delivery = request.headers["x-github-delivery"];
  if (!event || !delivery) {
    throw new WebhookError(400, "this request is missing its event or delivery id");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(request.body);
  } catch {
    throw new WebhookError(400, "the body is signed but is not JSON");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new WebhookError(400, "the body is not an object");
  }

  const log = options.log;
  if (log) {
    // Checked after the signature, so an unauthenticated caller cannot fill
    // the log with ids it made up.
    if (await log.seen(delivery)) {
      throw new WebhookError(200, `delivery ${delivery} has already been handled`);
    }
    await log.record(delivery);
  }

  return { event, delivery, payload: payload as Record<string, unknown> };
}

/**
 * Whether a delivery is recent enough to act on.
 *
 * Kept separate because GitHub does not send a timestamp header: the age has to
 * come from a field inside the payload, and which field depends on the event.
 * A caller that cannot find one is better served by saying so than by a helper
 * that silently treats "no timestamp" as "fresh".
 */
export function isFresh(
  sentAt: number | undefined,
  options: { maxAgeMs?: number; now?: number } = {},
): boolean {
  if (sentAt === undefined) return false;
  const now = options.now ?? Date.now();
  const maxAge = options.maxAgeMs ?? 5 * 60_000;
  // A delivery from the future is as suspect as one from last week.
  return sentAt <= now + 60_000 && now - sentAt <= maxAge;
}
