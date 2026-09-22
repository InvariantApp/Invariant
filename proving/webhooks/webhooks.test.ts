/**
 * Webhooks a provider sends, adapted for a subscriber on an old contract and
 * then signed, on real payloads (M4.6).
 *
 * The payloads are GitHub's and Stripe's own, not written here: an `issues`
 * event from GitHub's published examples and the charge Stripe's mock answers
 * with. In each, the current contract renamed one field, so the provider now
 * sends the new name, and a subscriber on the old contract has to receive
 * what it always did. Each is signed the way its provider signs, and checked
 * the way a subscriber checks, over the bytes that subscriber receives. The
 * order is the whole point: signed first and adapted after, every old
 * subscriber's check fails at once.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chainProgram, predictDocument } from "@invariant-app/compiler";
import type { OpenApiDocument } from "@invariant-app/contract";
import { type Change, parseChange } from "@invariant-app/ir";
import { createRuntime } from "@invariant-app/runtime";
import { describe, expect, it } from "vitest";

type Json = Record<string, unknown>;

const fixture = (name: string): Json =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")) as Json;

/** An object schema holding `inner` at the path `at`, inline all the way down. */
function holding(at: readonly string[], inner: string): Json {
  const [first, ...rest] = at;
  if (first === undefined) return { $ref: `#/components/schemas/${inner}` };
  return { type: "object", properties: { [first]: holding(rest, inner) } };
}

/** A document whose one webhook sends `event`, whose `inner` schema holds `field`. */
function sender(
  event: string,
  inner: string,
  at: readonly string[],
  field: string,
): OpenApiDocument {
  return {
    openapi: "3.1.0",
    info: { title: event, version: "1" },
    paths: {},
    webhooks: {
      [event]: {
        post: {
          requestBody: {
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Event" } },
            },
          },
          responses: { "200": { description: "received" } },
        },
      },
    },
    components: {
      schemas: {
        Event: holding(at, inner),
        // The rename does not depend on what the field holds.
        [inner]: { type: "object", properties: { [field]: {} } },
      },
    },
  } as unknown as OpenApiDocument;
}

/** The program serving `old` subscribers after `change`, compiled as any release is. */
function runtimeFor(before: OpenApiDocument, after: OpenApiDocument, change: Change) {
  const prediction = predictDocument(before, after, [change]);
  expect(prediction.issues).toEqual([]);
  const { program, issues } = chainProgram("webhooks", "new", "sha256:new", [
    {
      label: "new",
      parent: "old",
      from: before,
      to: prediction.document,
      changes: [change],
    },
  ]);
  expect(issues).toEqual([]);
  return createRuntime({ program, identity: [{ kind: "default", label: "new" }] });
}

const rename = (id: string, schema: string, from: string, to: string): Change =>
  parseChange({
    irVersion: 1,
    id,
    summary: `\`${from}\` is called \`${to}\`.`,
    scopes: [{ schema: `#/components/schemas/${schema}` }],
    ops: [{ op: "move", from: `/${from}`, to: `/${to}` }],
  });

/** An object with one key renamed, where it was, as a new release sends it. */
function renamed(value: Json, from: string, to: string): Json {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key === from ? to : key, entry]),
  );
}

const SECRET = "whsec_proving_ground";

describe("a GitHub webhook to a subscriber on an old contract", () => {
  const original = fixture("github-issues-opened.json");
  const current = {
    ...original,
    issue: renamed(original["issue"] as Json, "author_association", "author_role"),
  };
  const runtime = runtimeFor(
    sender("issues", "Issue", ["issue"], "author_association"),
    sender("issues", "Issue", ["issue"], "author_role"),
    rename("chg_issue_author_role", "Issue", "author_association", "author_role"),
  );
  /** X-Hub-Signature-256, as GitHub computes it and @octokit/webhooks checks it. */
  const sign = (body: string) =>
    `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
  const verifies = (body: string, signature: string) =>
    timingSafeEqual(Buffer.from(sign(body)), Buffer.from(signature));

  it("arrives as GitHub's own example, and verifies over the bytes received", () => {
    const sent = runtime.adaptOutbound(
      "old",
      "webhook:issues",
      JSON.stringify(current),
    ).body;
    expect(JSON.parse(sent)).toEqual(original);
    expect(verifies(sent, sign(sent))).toBe(true);
  });

  it("fails every old subscriber's check when signed before it is adapted", () => {
    const text = JSON.stringify(current);
    const tooEarly = sign(text);
    const sent = runtime.adaptOutbound("old", "webhook:issues", text).body;
    expect(verifies(sent, tooEarly)).toBe(false);
  });
});

describe("a Stripe event to an endpoint pinned to an old contract", () => {
  const charge = fixture("stripe-charge.json");
  const event = (object: Json) => ({
    id: "evt_proving",
    object: "event",
    api_version: "2026-01-28.clover",
    created: 1_760_000_000,
    type: "charge.succeeded",
    data: { object },
  });
  const original = event(charge);
  const current = event(renamed(charge, "amount_captured", "captured_amount"));
  const runtime = runtimeFor(
    sender("charge.succeeded", "Charge", ["data", "object"], "amount_captured"),
    sender("charge.succeeded", "Charge", ["data", "object"], "captured_amount"),
    rename("chg_charge_captured_amount", "Charge", "amount_captured", "captured_amount"),
  );

  /** Stripe-Signature's v1: an HMAC of the timestamp and the payload, as Stripe signs it. */
  const signature = (timestamp: number, body: string) =>
    createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex");

  it("arrives as Stripe's own charge, and its signature holds over the bytes received", () => {
    const text = JSON.stringify(current);
    const sent = runtime.adaptOutbound("old", "webhook:charge.succeeded", text).body;
    expect(JSON.parse(sent)).toEqual(original);
    // What the endpoint checks: v1 over the timestamp and the payload it got.
    const timestamp = 1_760_000_000;
    const header = `t=${timestamp},v1=${signature(timestamp, sent)}`;
    const [, v1] = /v1=([0-9a-f]+)/.exec(header) ?? [];
    expect(v1).toBe(signature(timestamp, sent));
    // Signed over what the provider produced, before adapting, it would not.
    expect(signature(timestamp, text)).not.toBe(v1);
  });
});
