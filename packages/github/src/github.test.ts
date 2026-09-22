/**
 * The delivery path, which is reachable by anyone who finds the URL.
 *
 * Everything downstream of a webhook - cloning a repository, running a
 * migration, opening a pull request - is work a stranger's request can cause.
 * Most of what follows is about refusing, because that is where the security
 * of the whole thing lives.
 */
import { createHmac } from "node:crypto";
import type { EvolutionBundle } from "@invariant-app/bundle";
import type { ManualSite } from "@invariant-app/migrate-ts";
import { describe, expect, it } from "vitest";
import { LinkError, mintLink, REFUSED_PERMISSIONS, redeemLink } from "./link.ts";
import {
  type HunkProvenance,
  type MigrationSummary,
  PR_MARKER,
  readyToPromote,
  renderPullRequestBody,
} from "./pr.ts";
import {
  memoryDeliveryLog,
  signPayload,
  verifyWebhook,
  type WebhookError,
} from "./webhook.ts";

const SECRET = "whsec_test";

function delivery(body: string, overrides: Record<string, string | undefined> = {}) {
  return {
    body,
    headers: {
      "x-hub-signature-256": signPayload(body, SECRET),
      "x-github-event": "pull_request",
      "x-github-delivery": "d-1",
      ...overrides,
    },
  };
}

describe("accepting a webhook", () => {
  it("accepts one GitHub actually signed", async () => {
    const body = JSON.stringify({ action: "closed" });
    const result = await verifyWebhook(delivery(body), { secret: SECRET });

    expect(result.event).toBe("pull_request");
    expect(result.payload["action"]).toBe("closed");
  });

  it("refuses one with no signature at all", async () => {
    const body = "{}";
    await expect(
      verifyWebhook(delivery(body, { "x-hub-signature-256": undefined }), {
        secret: SECRET,
      }),
    ).rejects.toThrow(/carries no signature/);
  });

  it("refuses one signed with the wrong secret", async () => {
    const body = JSON.stringify({ action: "closed" });
    await expect(
      verifyWebhook(
        { ...delivery(body), headers: { ...delivery(body).headers } },
        { secret: "a-different-secret" },
      ),
    ).rejects.toThrow(/does not match/);
  });

  /**
   * The attack this exists to stop.
   *
   * A body that verifies and a body that is acted on have to be the same
   * bytes. Verifying the signature and then acting on a re-parsed or
   * re-serialised version is how a signed webhook stops meaning anything.
   */
  it("refuses a body that was edited after it was signed", async () => {
    const original = JSON.stringify({ repo: "acme/api", action: "closed" });
    const tampered = JSON.stringify({ repo: "attacker/evil", action: "closed" });

    await expect(
      verifyWebhook(
        { body: tampered, headers: delivery(original).headers },
        { secret: SECRET },
      ),
    ).rejects.toThrow(/does not match the body/);
  });

  it("refuses to run at all with no secret configured", async () => {
    const body = "{}";
    // An empty secret would make every signature verify against the same
    // value, so this is the one case that must not degrade to "allow".
    await expect(verifyWebhook(delivery(body), { secret: "" })).rejects.toThrow(
      /nothing can be trusted/,
    );
  });

  it("handles a redelivery once, not twice", async () => {
    const log = memoryDeliveryLog();
    const body = JSON.stringify({ action: "opened" });

    await expect(
      verifyWebhook(delivery(body), { secret: SECRET, log }),
    ).resolves.toBeDefined();

    // GitHub retries, and a retry carries the same delivery id. Without this
    // one push becomes five pull requests.
    await expect(verifyWebhook(delivery(body), { secret: SECRET, log })).rejects.toThrow(
      /already been handled/,
    );
  });

  it("answers a redelivery with a status that stops GitHub retrying", async () => {
    const log = memoryDeliveryLog();
    const body = "{}";
    await verifyWebhook(delivery(body), { secret: SECRET, log });

    try {
      await verifyWebhook(delivery(body), { secret: SECRET, log });
      expect.unreachable("a redelivery should have been refused");
    } catch (error) {
      // Not a 4xx: nothing is wrong, it has simply been done already, and
      // telling GitHub it failed would make it try again.
      expect((error as WebhookError).status).toBe(200);
    }
  });

  it("does not let an unsigned request fill the delivery log", async () => {
    const log = memoryDeliveryLog();
    const body = "{}";

    await expect(
      verifyWebhook(delivery(body, { "x-hub-signature-256": "sha256=00" }), {
        secret: SECRET,
        log,
      }),
    ).rejects.toThrow();

    // The id it claimed was never recorded, so a genuine delivery with that id
    // is still handled.
    await expect(
      verifyWebhook(delivery(body), { secret: SECRET, log }),
    ).resolves.toBeDefined();
  });

  it("refuses a signed body that is not an object", async () => {
    const body = JSON.stringify(["not", "an", "object"]);
    await expect(verifyWebhook(delivery(body), { secret: SECRET })).rejects.toThrow(
      /not an object/,
    );
  });
});

describe("the sponsored link", () => {
  it("round trips what the provider put in it", () => {
    const token = mintLink(
      { api: "acme-payments", consumer: "acct_alpha" },
      { secret: SECRET },
    );
    const claims = redeemLink(token, { secret: SECRET });

    expect(claims.api).toBe("acme-payments");
    expect(claims.consumer).toBe("acct_alpha");
  });

  it("refuses one whose claims were edited", () => {
    const token = mintLink({ api: "acme", consumer: "acct_alpha" }, { secret: SECRET });
    const [body, signature] = token.split(".");

    // Somebody rewrites the consumer to another customer's account and keeps
    // the signature. The binding this grants is the whole point of the link.
    const edited = Buffer.from(
      JSON.stringify({
        ...(JSON.parse(Buffer.from(body as string, "base64url").toString()) as object),
        consumer: "acct_victim",
      }),
      "utf8",
    ).toString("base64url");

    expect(() => redeemLink(`${edited}.${signature}`, { secret: SECRET })).toThrow(
      LinkError,
    );
  });

  it("refuses a signed one whose contents are not claims, with a LinkError", () => {
    // Found by the trust fuzzer (proving/fuzz/trust.test.ts): `null` signed
    // correctly used to escape as a TypeError from reading `.api` off it.
    for (const contents of ["null", "7", '"acme"', "[]"]) {
      const body = Buffer.from(contents, "utf8").toString("base64url");
      const signature = createHmac("sha256", SECRET)
        .update(body, "utf8")
        .digest("base64url");
      expect(
        () => redeemLink(`${body}.${signature}`, { secret: SECRET }),
        contents,
      ).toThrow(/missing something it needs/);
    }
  });

  it("refuses one minted by somebody else", () => {
    const token = mintLink({ api: "acme", consumer: "acct_alpha" }, { secret: "theirs" });
    expect(() => redeemLink(token, { secret: SECRET })).toThrow(
      /not issued by this service/,
    );
  });

  it("expires, and says so in a way a customer can act on", () => {
    const now = 1_800_000_000;
    const token = mintLink(
      { api: "acme", consumer: "acct_alpha" },
      { secret: SECRET, ttlSeconds: 60, now },
    );

    expect(redeemLink(token, { secret: SECRET, now: now + 30 }).consumer).toBe(
      "acct_alpha",
    );
    expect(() => redeemLink(token, { secret: SECRET, now: now + 61 })).toThrow(
      /Ask for a new one/,
    );
  });

  it("cannot have its expiry moved by whoever holds it", () => {
    const now = 1_800_000_000;
    const token = mintLink(
      { api: "acme", consumer: "acct_alpha" },
      { secret: SECRET, ttlSeconds: 60, now },
    );

    // The expiry is inside the signed payload, so editing it invalidates the
    // signature rather than extending the link.
    const [body, signature] = token.split(".");
    const claims = JSON.parse(
      Buffer.from(body as string, "base64url").toString(),
    ) as Record<string, unknown>;
    claims["expiresAt"] = now + 999_999;
    const extended = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");

    expect(() => redeemLink(`${extended}.${signature}`, { secret: SECRET })).toThrow(
      LinkError,
    );
  });

  it("does not ask for anything that could change the consumer's CI", () => {
    // `workflows` would allow editing what runs in their pipeline and
    // `actions` would expose its secrets and logs. Neither is needed to open a
    // pull request.
    expect(REFUSED_PERMISSIONS).toContain("workflows");
    expect(REFUSED_PERMISSIONS).toContain("actions");
  });
});

const BUNDLE = {
  bundleVersion: 1,
  api: "acme-payments",
  from: { label: "2026-03-01", digest: "sha256:bbbb" },
  to: { label: "2026-09-20", digest: "sha256:aaaaaaaaaaaaaaaaaaaa" },
  source: { repo: "acme/payments-api", commit: "c0ffee1234", pr: 482 },
  changes: [
    {
      irVersion: 1 as const,
      id: "chg_money_in_minor_units",
      summary: "Money crosses the wire in minor units.",
      ops: [{ op: "move" as const, from: "/amount", to: "/amount_cents" }],
      provenance: {
        confirmed_by: {
          kind: "provider-merge" as const,
          commit: "abc",
          reviewer: "dana",
        },
      },
    },
  ],
  evidence: [
    {
      kind: "E4-laws" as const,
      subject: "Payment",
      result: "pass" as const,
      inputsDigest: "sha256:1",
      tool: "fast-check",
      summary: "round trips hold",
    },
  ],
  compiled: { programDigest: "sha256:cccc" },
  gate: { result: "pass" as const, unexplained: [] },
} satisfies EvolutionBundle;

function summary(overrides: Partial<MigrationSummary> = {}): MigrationSummary {
  const hunks: HunkProvenance[] = [
    {
      file: "src/billing.ts",
      changeId: "chg_money_in_minor_units",
      author: "codemod",
      reason: "renamed amount to amount_cents",
      typeChecked: true,
    },
  ];
  return {
    bundle: BUNDLE,
    repo: "customer/shop",
    from: "2026-03-01",
    hunks,
    manual: [],
    newDiagnostics: [],
    testsRun: false,
    ...overrides,
  };
}

const MANUAL: ManualSite = {
  file: "src/checkout.test.ts",
  line: 54,
  column: 5,
  changeId: "chg_money_in_minor_units",
  reason: "this reads amount through an optional chain",
  snippet: "fetched?.amount",
  offset: 0,
};

describe("the pull request a consumer reads", () => {
  it("says they do not have to merge it", async () => {
    const body = renderPullRequestBody(summary());

    // The compatibility layer is the product's promise. A migration PR that
    // reads as urgent contradicts it.
    expect(body).toContain("You do not have to merge this");
    expect(body.startsWith(PR_MARKER)).toBe(true);
  });

  /**
   * The thing this document exists to do.
   *
   * A diff that mixes a type-checked rename with a name-matched guess, and
   * presents them identically, teaches the reader to skim both.
   */
  it("puts what nobody could check above what was verified", () => {
    const body = renderPullRequestBody(
      summary({
        hunks: [
          ...summary().hunks,
          {
            file: "src/donations.ts",
            changeId: "raw-http",
            author: "codemod",
            reason: "matched by name in an untyped request body",
            typeChecked: false,
          },
        ],
      }),
    );

    expect(body).toContain("Please look at these");
    expect(body.indexOf("Please look at these")).toBeLessThan(
      body.indexOf("the type checker found and verified"),
    );
    expect(body).toContain("could not be checked against the provider's schema");
  });

  it("names every hunk a model wrote", () => {
    const body = renderPullRequestBody(
      summary({
        hunks: [
          {
            file: "src/odd.ts",
            changeId: "chg_money_in_minor_units",
            author: "model",
            reason: "the codemod could not reach this call site",
            typeChecked: true,
          },
        ],
      }),
    );

    expect(body).toContain("1 hunk written by a model");
  });

  it("lists the sites left alone once per file and reason, with every line", () => {
    const body = renderPullRequestBody(
      summary({
        manual: [
          { ...MANUAL, line: 71 },
          MANUAL,
          { ...MANUAL, line: 12, reason: "`discount` is no longer in the contract" },
          { ...MANUAL, line: 54 },
        ],
      }),
    );
    expect(body).toContain(
      "- `src/checkout.test.ts` lines 54, 71 - this reads amount through an optional chain",
    );
    expect(body).toContain(
      "- `src/checkout.test.ts:12` - `discount` is no longer in the contract",
    );
  });

  it("says the consumer's tests were not run here", () => {
    expect(renderPullRequestBody(summary())).toContain("Your tests were not run");
  });
});

describe("promoting a draft", () => {
  it("promotes when the consumer's own checks passed and nothing is open", () => {
    const result = readyToPromote(summary(), [{ conclusion: "success" }]);
    expect(result.ready).toBe(true);
  });

  it("will not promote while a site is waiting for a person", () => {
    const result = readyToPromote(summary({ manual: [MANUAL] }), [
      { conclusion: "success" },
    ]);

    // Green checks are necessary and not sufficient. A suite can pass over a
    // site nobody has looked at.
    expect(result.ready).toBe(false);
    expect(result.reason).toContain("need a person");
  });

  it("will not promote a migration that left a type error", () => {
    const result = readyToPromote(summary({ newDiagnostics: ["src/a.ts:1 TS2339"] }), [
      { conclusion: "success" },
    ]);
    expect(result.ready).toBe(false);
    expect(result.reason).toContain("type error");
  });

  it("will not promote before any check has reported", () => {
    expect(readyToPromote(summary(), []).ready).toBe(false);
  });

  it("will not promote when a check failed", () => {
    const result = readyToPromote(summary(), [
      { conclusion: "success" },
      { conclusion: "failure" },
    ]);
    expect(result.ready).toBe(false);
    expect(result.reason).toContain("did not pass");
  });
});
