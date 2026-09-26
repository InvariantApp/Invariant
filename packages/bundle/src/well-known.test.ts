/**
 * What the provider's own document lets through.
 *
 * A bundle is trusted only if a key the provider lists signed it, for this
 * API, while the key was one it signed with, and the key was never revoked.
 * Every test here is a way for that to be false, and the refusal naming the
 * rule that failed. Keys are made fresh for each run; none is written down.
 */
import { generateKeyPairSync } from "node:crypto";
import type { Change, CompiledProgram } from "@invariant-app/ir";
import { describe, expect, it } from "vitest";
import { buildBundle, signBundle } from "./build.ts";
import { generateSigningKey } from "./dsse.ts";
import {
  buildWellKnown,
  keyRefusal,
  openWithWellKnown,
  parseWellKnown,
  UntrustedBundleError,
  WellKnownError,
} from "./well-known.ts";

const CHANGE: Change = {
  irVersion: 1,
  id: "chg_rename_amount",
  summary: "amount is amount_cents.",
  scopes: [{ schema: "#/components/schemas/Payment" }],
  ops: [{ op: "move", from: "/amount", to: "/amount_cents" }],
};

const PROGRAM: CompiledProgram = {
  irVersion: 2,
  compiledBy: "test",
  minRuntime: "0.1.0",
  api: "acme-payments",
  current: "sha256:aaaa",
  currentLabel: "2026-09-20",
  contracts: {},
};

function signed(privateKeyPem: string, api = "acme-payments") {
  const { bundle, digest } = buildBundle({
    api,
    from: { label: "2026-01-15", digest: "sha256:1" },
    to: { label: "2026-09-20", digest: "sha256:2" },
    source: { repo: "acme/payments", commit: "c0ffee" },
    changes: [CHANGE],
    evidence: [],
    program: PROGRAM,
    gate: { result: "pass", unexplained: [] },
  });
  return signBundle(bundle, digest, privateKeyPem);
}

const current = generateSigningKey();
const retired = generateSigningKey();
const leaked = generateSigningKey();
const stranger = generateSigningKey();

const document = buildWellKnown({
  apis: ["acme-payments", "acme-billing"],
  keys: [
    {
      publicKeyPem: retired.publicKeyPem,
      addedAt: "2025-01-01T00:00:00Z",
      notAfter: "2026-03-01T00:00:00Z",
    },
    { publicKeyPem: current.publicKeyPem, addedAt: "2026-03-01T00:00:00Z" },
    {
      publicKeyPem: leaked.publicKeyPem,
      addedAt: "2025-06-01T00:00:00Z",
      revoked: true,
      revokedReason: "left in a CI log",
    },
  ],
});
const at = (signedAt: string, api = "acme-payments") => ({
  api,
  signedAt: new Date(signedAt),
  source: "https://acme.example/.well-known/invariant.json",
});

describe("the provider's document", () => {
  it("names every key by the id its public key has, and reads back as written", () => {
    expect(document.version).toBe(1);
    expect(document.apis).toEqual(["acme-billing", "acme-payments"]);
    expect(document.keys).toHaveLength(3);
    expect(parseWellKnown(JSON.parse(JSON.stringify(document)))).toEqual(document);
  });

  it.each([
    ["another version", { version: 2 }, /version 2/],
    ["no APIs", { apis: [] }, /apis/],
    ["an API id that is not one", { apis: ["Acme Payments"] }, /apis/],
    [
      "a bundles URL that is not https",
      { bundles: { url: "http://cdn.example" } },
      /https/,
    ],
  ])("is refused with %s", (_why, change, message) => {
    expect(() =>
      parseWellKnown({ ...JSON.parse(JSON.stringify(document)), ...change }),
    ).toThrow(message);
  });

  it("is refused when a key's id is not its key's, a time has no zone, or a key is listed twice", () => {
    const raw = JSON.parse(JSON.stringify(document)) as {
      keys: Record<string, unknown>[];
    };
    const [first, second] = raw.keys as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(() =>
      parseWellKnown({ ...raw, keys: [{ ...first, keyid: second["keyid"] }] }),
    ).toThrow(/but its public_key is/);
    expect(() =>
      parseWellKnown({ ...raw, keys: [{ ...first, added_at: "2026-01-01 00:00" }] }),
    ).toThrow(WellKnownError);
    expect(() => parseWellKnown({ ...raw, keys: [first, first] })).toThrow(/twice/);
    expect(() =>
      parseWellKnown({
        ...raw,
        keys: [{ ...first, not_after: "2024-01-01T00:00:00Z" }],
      }),
    ).toThrow(/not after/);
  });

  it("is refused when a key is not Ed25519, which is what releases are signed with", () => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    expect(() =>
      buildWellKnown({
        apis: ["acme-payments"],
        keys: [
          { publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() },
        ],
      }),
    ).toThrow(/Ed25519/);
  });

  it("ignores what a later version adds, so old readers keep working", () => {
    const later = { ...JSON.parse(JSON.stringify(document)), transparency: { log: "x" } };
    expect(parseWellKnown(later)).toEqual(document);
  });
});

describe("opening a bundle against it", () => {
  it("opens one the current key signed", () => {
    const opened = openWithWellKnown(
      signed(current.privateKeyPem),
      document,
      at("2026-09-20T12:00:00Z"),
    );
    expect(opened.bundle.changes.map((change) => change.id)).toEqual([CHANGE.id]);
  });

  it("opens one a retired key signed while it still signed, and refuses one it signed after", () => {
    const bundle = signed(retired.privateKeyPem);
    expect(() =>
      openWithWellKnown(bundle, document, at("2026-02-01T00:00:00Z")),
    ).not.toThrow();
    expect(() => openWithWellKnown(bundle, document, at("2026-04-01T00:00:00Z"))).toThrow(
      /after the key stopped signing/,
    );
  });

  it("refuses one published before its key was added", () => {
    expect(() =>
      openWithWellKnown(
        signed(current.privateKeyPem),
        document,
        at("2026-01-01T00:00:00Z"),
      ),
    ).toThrow(/before the key was added/);
  });

  it("refuses everything a revoked key signed, whenever it was signed", () => {
    for (const time of ["2025-07-01T00:00:00Z", "2026-09-20T00:00:00Z"]) {
      expect(() =>
        openWithWellKnown(signed(leaked.privateKeyPem), document, at(time)),
      ).toThrow(/revoked it \(left in a CI log\)/);
    }
  });

  it("refuses one signed by a key the provider does not list, however valid its signature", () => {
    expect(() =>
      openWithWellKnown(
        signed(stranger.privateKeyPem),
        document,
        at("2026-09-20T00:00:00Z"),
      ),
    ).toThrow(UntrustedBundleError);
    expect(() =>
      openWithWellKnown(
        signed(stranger.privateKeyPem),
        document,
        at("2026-09-20T00:00:00Z"),
      ),
    ).toThrow(/is not a key https:\/\/acme\.example/);
  });

  it("refuses an API the document does not list, or a bundle for another API than asked", () => {
    expect(() =>
      openWithWellKnown(
        signed(current.privateKeyPem),
        document,
        at("2026-09-20T00:00:00Z", "globex"),
      ),
    ).toThrow(/does not list the API globex/);
    expect(() =>
      openWithWellKnown(
        signed(current.privateKeyPem, "acme-billing"),
        document,
        at("2026-09-20T00:00:00Z"),
      ),
    ).toThrow(/for acme-billing, not acme-payments/);
  });

  it("holds a key listed for some APIs to those", () => {
    const billingOnly = parseWellKnown({
      ...document,
      keys: document.keys.map((key) =>
        key.revoked || key.not_after ? key : { ...key, apis: ["acme-billing"] },
      ),
    });
    const key = billingOnly.keys.find((entry) => entry.apis);
    expect(key).toBeDefined();
    if (!key) return;
    expect(
      keyRefusal(key, { api: "acme-billing", signedAt: new Date() }),
    ).toBeUndefined();
    expect(keyRefusal(key, { api: "acme-payments", signedAt: new Date() })).toMatch(
      /lists it for acme-billing, not acme-payments/,
    );
    expect(() =>
      openWithWellKnown(
        signed(current.privateKeyPem),
        billingOnly,
        at("2026-09-20T00:00:00Z"),
      ),
    ).toThrow(UntrustedBundleError);
  });
});

describe("regenerating the document", () => {
  it("keeps every key already published, its time added and its revocation", () => {
    const next = generateSigningKey();
    const regenerated = buildWellKnown({
      apis: ["acme-payments"],
      keys: [{ publicKeyPem: next.publicKeyPem }, { publicKeyPem: current.publicKeyPem }],
      previous: document,
      now: new Date("2026-10-01T00:00:00Z"),
    });
    expect(regenerated.keys).toHaveLength(4);
    const byId = new Map(regenerated.keys.map((key) => [key.keyid, key]));
    for (const key of document.keys) expect(byId.get(key.keyid)).toEqual(key);
    expect(regenerated.keys.at(-1)?.added_at).toBe("2026-10-01T00:00:00Z");
    expect(regenerated.apis).toEqual(["acme-billing", "acme-payments"]);
  });
});
