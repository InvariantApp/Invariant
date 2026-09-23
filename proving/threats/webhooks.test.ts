/**
 * The two ways a stranger's request can cause work in the GitHub integration:
 * a webhook delivery, and a sponsored link.
 *
 * Each test is a request an attacker could actually make: one they captured
 * and send again, one they edited, one they signed with a secret they guessed.
 * The verifiers are the real ones the service mounts, given secrets made for
 * the run.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  isFresh,
  LinkError,
  memoryDeliveryLog,
  mintLink,
  redeemLink,
  signPayload,
  verifyWebhook,
  WebhookError,
} from "@invariant-app/github";
import { describe, expect, it } from "vitest";

const secret = randomBytes(32).toString("hex");

/** A delivery as GitHub sends one, signed with the service's secret. */
function delivery(
  payload: unknown,
  event = "installation",
  id: string = randomUUID(),
  signingSecret = secret,
) {
  const body = JSON.stringify(payload);
  return {
    body,
    headers: {
      "x-hub-signature-256": signPayload(body, signingSecret),
      "x-github-event": event,
      "x-github-delivery": id,
    },
  };
}

const INSTALLED = {
  action: "created",
  installation: { id: 42, account: { login: "globex" } },
  sender: { login: "someone" },
};

/** What the verifier says about a request: the event it accepted, or its refusal. */
async function outcome(
  request: Parameters<typeof verifyWebhook>[0],
  log = memoryDeliveryLog(),
): Promise<string | number> {
  try {
    return (await verifyWebhook(request, { secret, log })).event;
  } catch (error) {
    expect(error).toBeInstanceOf(WebhookError);
    return (error as WebhookError).status;
  }
}

describe("a replayed webhook", () => {
  it("is handled once when it is sent again exactly as captured", async () => {
    const log = memoryDeliveryLog();
    const captured = delivery(INSTALLED);
    expect(await outcome(captured, log)).toBe("installation");
    // 200, so GitHub stops retrying, and no payload for the caller to act on.
    expect(await outcome(captured, log)).toBe(200);
  });

  it("is handled once when it is sent again under a delivery id of the sender's choosing", async () => {
    // GitHub signs the body and nothing else. Before the fix a captured
    // delivery with a fresh `X-GitHub-Delivery` passed every check and was
    // handled a second time.
    const log = memoryDeliveryLog();
    const captured = delivery(INSTALLED);
    expect(await outcome(captured, log)).toBe("installation");
    const replayed = {
      ...captured,
      headers: { ...captured.headers, "x-github-delivery": randomUUID() },
    };
    expect(await outcome(replayed, log)).toBe(200);
  });

  it("is handled once when it is sent again as a different event", async () => {
    // The event name is not signed either, so the same body could be offered
    // as `installation_repositories` to a handler that reads it differently.
    const log = memoryDeliveryLog();
    const captured = delivery(INSTALLED);
    expect(await outcome(captured, log)).toBe("installation");
    const relabelled = {
      ...captured,
      headers: {
        ...captured.headers,
        "x-github-event": "installation_repositories",
        "x-github-delivery": randomUUID(),
      },
    };
    expect(await outcome(relabelled, log)).toBe(200);
  });

  it("does not let unsigned requests fill the log and shut out a real delivery", async () => {
    const log = memoryDeliveryLog(8);
    const real = delivery(INSTALLED);
    for (let index = 0; index < 50; index += 1) {
      const forged = {
        ...real,
        headers: { ...real.headers, "x-hub-signature-256": `sha256=${"0".repeat(64)}` },
      };
      expect(await outcome(forged, log)).toBe(401);
    }
    expect(await outcome(real, log)).toBe("installation");
  });
});

describe("a stale webhook", () => {
  const now = Date.parse("2026-09-23T12:00:00Z");

  it.each([
    ["sent a week ago", now - 7 * 24 * 60 * 60_000, false],
    ["sent six minutes ago", now - 6 * 60_000, false],
    ["dated two minutes from now", now + 2 * 60_000, false],
    ["with no time at all", undefined, false],
    ["sent a minute ago", now - 60_000, true],
  ])("%s is judged fresh: %s", (_name, sentAt, fresh) => {
    expect(isFresh(sentAt, { now })).toBe(fresh);
  });
});

describe("a forged or edited webhook", () => {
  it.each([
    [
      "a body edited after signing",
      () => {
        const real = delivery(INSTALLED);
        return {
          ...real,
          body: real.body.replace('"globex"', '"initech"'),
        };
      },
      401,
    ],
    [
      "a body signed with a guessed secret",
      () =>
        delivery(
          INSTALLED,
          "installation",
          randomUUID(),
          randomBytes(32).toString("hex"),
        ),
      401,
    ],
    [
      "no signature at all",
      () => {
        const real = delivery(INSTALLED);
        return {
          ...real,
          headers: { ...real.headers, "x-hub-signature-256": undefined },
        };
      },
      401,
    ],
    [
      "the right signature in upper case",
      () => {
        const real = delivery(INSTALLED);
        const signature = real.headers["x-hub-signature-256"];
        return {
          ...real,
          headers: {
            ...real.headers,
            "x-hub-signature-256": `sha256=${signature.slice(7).toUpperCase()}`,
          },
        };
      },
      401,
    ],
    ["a signed body that is not an object", () => delivery([INSTALLED]), 400],
  ])("refuses %s", async (_name, make, status) => {
    expect(await outcome(make())).toBe(status);
  });

  it("refuses everything when no secret is configured, rather than trusting anything", async () => {
    const refusal = await verifyWebhook(delivery(INSTALLED), { secret: "" }).catch(
      (error: unknown) => error,
    );
    expect((refusal as WebhookError).status).toBe(500);
  });
});

describe("a sponsored link", () => {
  const now = 1_800_000_000;
  const link = mintLink(
    { api: "acme-payments", consumer: "globex" },
    { secret, now, ttlSeconds: 3600 },
  );
  const [body, signature] = link.split(".") as [string, string];
  const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
  const resigned = (edit: Record<string, unknown>) =>
    `${Buffer.from(JSON.stringify({ ...claims, ...edit }), "utf8").toString("base64url")}.${signature}`;

  it("grants what it names while it is in date", () => {
    expect(redeemLink(link, { secret, now })).toMatchObject({
      api: "acme-payments",
      consumer: "globex",
    });
  });

  it("stops working when it expires, however often it has been used", () => {
    // Redeeming binds one installation to one named consumer and nothing else,
    // so a link that leaked can be replayed only for that, and only until it
    // expires. Whether it may be redeemed more than once is decided where it
    // is redeemed, in the service.
    expect(redeemLink(link, { secret, now: now + 60 })).toBeTruthy();
    expect(redeemLink(link, { secret, now: now + 120 })).toBeTruthy();
    expect(() => redeemLink(link, { secret, now: now + 3600 })).toThrow(LinkError);
    expect(() => redeemLink(link, { secret, now: now + 30 * 86_400 })).toThrow(/expired/);
  });

  it.each([
    ["for another consumer", { consumer: "initech" }],
    ["for another API", { api: "acme-billing" }],
    ["with its expiry pushed out a year", { expiresAt: now + 365 * 86_400 }],
  ])("refuses the same signature over claims edited %s", (_name, edit) => {
    expect(() => redeemLink(resigned(edit), { secret, now })).toThrow(
      /not issued by this service, or has been edited/,
    );
  });

  it.each([
    [
      "minted with a guessed secret",
      () =>
        mintLink(
          { api: "acme-payments", consumer: "globex" },
          {
            secret: randomBytes(32).toString("hex"),
            now,
          },
        ),
    ],
    ["with a second signature appended", () => `${link}.${signature}`],
    ["with its signature moved in front", () => `${signature}.${body}`],
    ["with no signature", () => body],
    ["empty", () => ""],
  ])("refuses a link %s", (_name, make) => {
    expect(() => redeemLink(make(), { secret, now })).toThrow(LinkError);
  });
});
