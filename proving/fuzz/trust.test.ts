/**
 * Rig F at the trust boundaries: the three places a stranger's bytes are
 * weighed before anything acts on them. A webhook delivery, a sponsored link
 * and a signed bundle each either come back as exactly what was signed or are
 * refused with their own typed error, whatever they are; and nothing changed
 * after signing, in any one place, is ever accepted.
 *
 * FUZZ_RUNS and FUZZ_SEED work as in runtime.test.ts.
 */
import { createHmac } from "node:crypto";
import {
  BundleError,
  buildBundle,
  type DsseEnvelope,
  generateSigningKey,
  openBundle,
  SignatureError,
  signBundle,
} from "@invariant/bundle";
import {
  LinkError,
  memoryDeliveryLog,
  mintLink,
  redeemLink,
  signPayload,
  verifyWebhook,
  WebhookError,
} from "@invariant/github";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

const RUNS = Number(process.env["FUZZ_RUNS"] ?? 300);
const SEED =
  process.env["FUZZ_SEED"] === undefined ? undefined : Number(process.env["FUZZ_SEED"]);
const settings = { numRuns: RUNS, ...(SEED === undefined ? {} : { seed: SEED }) };
// Signing and checking an Ed25519 signature is slower than a transform; the
// same depth takes a tenth of the cases.
const signed = { ...settings, numRuns: Math.max(50, Math.floor(RUNS / 10)) };

const SECRET = "fuzz-webhook-secret";
const STATUSES = new Set([200, 400, 401]);

/** Any string, including ones no text encoding round-trips. */
const anyString = fc.oneof(
  fc.string(),
  fc.string({ unit: "binary" }),
  fc.json(),
  fc.constantFrom("", "null", "[]", "{}", "\u0000", "\ud800"),
);

/** A string with one character somewhere replaced by a different one. */
const mutated = (text: string) =>
  fc
    .tuple(
      fc.nat({ max: Math.max(0, text.length - 1) }),
      fc.string({ minLength: 1, maxLength: 1 }),
    )
    .filter(([at, char]) => text.length > 0 && text[at] !== char)
    .map(([at, char]) => `${text.slice(0, at)}${char}${text.slice(at + 1)}`);

describe("a webhook delivery", () => {
  it("is returned as signed, or refused with a WebhookError and a status GitHub reads", async () => {
    await fc.assert(
      fc.asyncProperty(
        anyString,
        fc.boolean(),
        fc.option(anyString, { nil: undefined }),
        fc.option(anyString, { nil: undefined }),
        async (body, signIt, event, delivery) => {
          const request = {
            body,
            headers: {
              "x-hub-signature-256": signIt
                ? signPayload(body, SECRET)
                : body.slice(0, 71),
              "x-github-event": event,
              "x-github-delivery": delivery,
            },
          };
          try {
            const verified = await verifyWebhook(request, { secret: SECRET });
            expect(signIt).toBe(true);
            expect(verified.payload).toEqual(JSON.parse(body));
          } catch (error) {
            expect(error).toBeInstanceOf(WebhookError);
            expect(STATUSES.has((error as WebhookError).status)).toBe(true);
          }
        },
      ),
      settings,
    );
  });

  it("is refused once anything in its body changes after signing", async () => {
    const body = JSON.stringify({ action: "created", installation: { id: 1 } });
    const signature = signPayload(body, SECRET);
    await fc.assert(
      fc.asyncProperty(mutated(body), async (edited) => {
        const refusal = await verifyWebhook(
          {
            body: edited,
            headers: {
              "x-hub-signature-256": signature,
              "x-github-event": "installation",
              "x-github-delivery": "1",
            },
          },
          { secret: SECRET },
        ).catch((error: unknown) => error);
        expect(refusal).toBeInstanceOf(WebhookError);
        expect((refusal as WebhookError).status).toBe(401);
      }),
      settings,
    );
  });

  it("is handled once, however often it arrives", async () => {
    const log = memoryDeliveryLog();
    const body = "{}";
    const request = {
      body,
      headers: {
        "x-hub-signature-256": signPayload(body, SECRET),
        "x-github-event": "ping",
        "x-github-delivery": "42",
      },
    };
    await verifyWebhook(request, { secret: SECRET, log });
    await fc.assert(
      fc.asyncProperty(fc.constant(request), async (again) => {
        const refusal = await verifyWebhook(again, { secret: SECRET, log }).catch(
          (error: unknown) => error,
        );
        expect(refusal).toBeInstanceOf(WebhookError);
        expect((refusal as WebhookError).status).toBe(200);
      }),
      { ...settings, numRuns: 20 },
    );
  });
});

describe("a sponsored link", () => {
  const NOW = 1_800_000_000;

  it("is redeemed or refused with a LinkError, for any string at all", () => {
    fc.assert(
      fc.property(anyString, (token) => {
        try {
          redeemLink(token, { secret: SECRET, now: NOW });
          // Only a token this secret signed can be redeemed, and fc makes none.
          expect.unreachable(`redeemed ${JSON.stringify(token)}`);
        } catch (error) {
          expect(error).toBeInstanceOf(LinkError);
        }
      }),
      settings,
    );
  });

  it("is refused with a LinkError whatever its signed contents are", () => {
    // Someone holding the secret is trusted to sign, not to crash the service.
    fc.assert(
      fc.property(fc.jsonValue(), (claims) => {
        const body = Buffer.from(JSON.stringify(claims) ?? "", "utf8").toString(
          "base64url",
        );
        const token = `${body}.${createHmac("sha256", SECRET).update(body, "utf8").digest("base64url")}`;
        try {
          const redeemed = redeemLink(token, { secret: SECRET, now: NOW });
          expect(redeemed.expiresAt).toBeGreaterThan(NOW);
        } catch (error) {
          expect(error).toBeInstanceOf(LinkError);
        }
      }),
      settings,
    );
  });

  it("is refused once any one character of it changes", () => {
    const token = mintLink(
      { api: "acme", consumer: "globex" },
      { secret: SECRET, now: NOW },
    );
    fc.assert(
      fc.property(mutated(token), (edited) => {
        expect(() => redeemLink(edited, { secret: SECRET, now: NOW })).toThrow(LinkError);
      }),
      settings,
    );
  });
});

describe("a signed bundle", () => {
  const { privateKeyPem, publicKeyPem } = generateSigningKey();
  const { bundle, digest } = buildBundle({
    api: "acme-payments",
    from: { label: "2026-01-01", digest: "sha256:aaaa" },
    to: { label: "2026-06-01", digest: "sha256:bbbb" },
    source: { repo: "acme/payments", commit: "0".repeat(40) },
    changes: [
      {
        irVersion: 1,
        id: "chg_rename",
        summary: "name is now title.",
        scopes: [{ schema: "#/components/schemas/Item" }],
        ops: [{ op: "move", from: "/name", to: "/title" }],
      },
    ],
    evidence: [],
    program: {
      irVersion: 2,
      compiledBy: "fuzz",
      minRuntime: "0.1.0",
      api: "acme-payments",
      current: "sha256:bbbb",
      currentLabel: "2026-06-01",
      contracts: {},
    } as never,
    gate: { result: "pass", unexplained: [] },
  });
  const envelope = signBundle(bundle, digest, privateKeyPem);

  const typed = (error: unknown) =>
    error instanceof SignatureError || error instanceof BundleError;

  it("opens as signed", () => {
    expect(openBundle(envelope, [publicKeyPem]).digest).toBe(digest);
  });

  it("is opened or refused with a typed error, for any envelope at all", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.jsonValue(),
          fc.record({
            payload: fc.oneof(anyString, fc.jsonValue()),
            payloadType: fc.oneof(fc.constant(envelope.payloadType), anyString),
            signatures: fc.oneof(
              fc.constant(envelope.signatures),
              fc.array(fc.record({ keyid: anyString, sig: anyString })),
              fc.jsonValue(),
            ),
          }),
        ),
        (candidate) => {
          try {
            openBundle(candidate as DsseEnvelope, [publicKeyPem]);
            expect.unreachable("an envelope nobody signed was opened");
          } catch (error) {
            expect(typed(error), String(error)).toBe(true);
          }
        },
      ),
      signed,
    );
  });

  it("is refused once any one character of it changes after signing", () => {
    const payload = Buffer.from(envelope.payload, "base64").toString("utf8");
    const reencode = (text: string) => Buffer.from(text, "utf8").toString("base64");
    const [signature] = envelope.signatures;
    if (!signature) throw new Error("signBundle made no signature");
    fc.assert(
      fc.property(
        fc.oneof(
          mutated(payload).map((edited) => ({ ...envelope, payload: reencode(edited) })),
          mutated(envelope.payloadType).map((payloadType) => ({
            ...envelope,
            payloadType,
          })),
          mutated(signature.sig).map((sig) => ({
            ...envelope,
            signatures: [{ ...signature, sig }],
          })),
          mutated(signature.keyid).map((keyid) => ({
            ...envelope,
            signatures: [{ ...signature, keyid }],
          })),
        ),
        (edited) => {
          // A base64 edit can decode to the same bytes; that is not a change.
          if (
            edited.payloadType === envelope.payloadType &&
            Buffer.from(edited.payload, "base64").equals(
              Buffer.from(envelope.payload, "base64"),
            ) &&
            edited.signatures[0]?.keyid === signature.keyid &&
            Buffer.from(edited.signatures[0]?.sig ?? "", "base64").equals(
              Buffer.from(signature.sig, "base64"),
            )
          ) {
            return;
          }
          try {
            openBundle(edited, [publicKeyPem]);
            expect.unreachable("an edited envelope was opened");
          } catch (error) {
            expect(typed(error), String(error)).toBe(true);
          }
        },
      ),
      signed,
    );
  });
});
