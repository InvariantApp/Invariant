/**
 * What a signature is worth.
 *
 * The passing case proves almost nothing on its own: any signing code signs
 * something. What matters is every way a bundle can be wrong, and that each one
 * is refused loudly rather than returned with a flag a caller might not read.
 */
import { generateKeyPairSync } from "node:crypto";
import type { Change, CompiledProgram } from "@invariant/ir";
import type { Evidence } from "@invariant/verifier";
import { describe, expect, it } from "vitest";
import {
  type BuildInput,
  BundleError,
  buildBundle,
  openBundle,
  reproduces,
  signBundle,
  statementFor,
} from "./build.ts";
import {
  generateSigningKey,
  PAYLOAD_TYPE,
  pae,
  SignatureError,
  sign,
  verify,
} from "./dsse.ts";

const CHANGE: Change = {
  irVersion: 1,
  id: "chg_money_in_minor_units",
  summary: "Money crosses the wire in minor units.",
  scopes: [{ schema: "#/components/schemas/Payment" }],
  ops: [
    { op: "move", from: "/amount", to: "/amount_cents" },
    {
      op: "convert",
      path: "/amount_cents",
      codec: { kind: "scale10", exponent: 2, onInexact: "reject" },
    },
  ],
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

const EVIDENCE: Evidence[] = [
  {
    kind: "E4-laws",
    subject: "#/components/schemas/Payment",
    result: "pass",
    inputsDigest: "sha256:1111",
    tool: "fast-check",
    summary: "round trips hold",
  },
  {
    kind: "E2-closure",
    subject: "2026-03-01 -> 2026-09-20",
    result: "pass",
    inputsDigest: "sha256:2222",
    tool: "oasdiff",
    summary: "the Changes explain the whole breaking diff",
  },
];

function input(overrides: Partial<BuildInput> = {}): BuildInput {
  return {
    api: "acme-payments",
    from: { label: "2026-03-01", digest: "sha256:bbbb" },
    to: { label: "2026-09-20", digest: "sha256:aaaa" },
    source: { repo: "acme/payments-api", commit: "c0ffee", pr: 482 },
    changes: [CHANGE],
    evidence: EVIDENCE,
    program: PROGRAM,
    gate: { result: "pass", unexplained: [] },
    ...overrides,
  };
}

describe("the evolution bundle", () => {
  it("digests the same whatever order the evidence arrived in", () => {
    const forwards = buildBundle(input());
    const backwards = buildBundle(input({ evidence: [...EVIDENCE].reverse() }));

    // Evidence arrives in whatever order the layers finished, which can depend
    // on the filesystem. If that reached the digest, two builds of one release
    // would disagree and "rebuild it and compare" would be worthless.
    expect(backwards.digest).toBe(forwards.digest);
    expect(reproduces(forwards.bundle, backwards.bundle).same).toBe(true);
  });

  it("refuses to publish a release its own gate blocked", () => {
    expect(() =>
      buildBundle(
        input({ gate: { result: "block", unexplained: ["Payment.status changed"] } }),
      ),
    ).toThrow(BundleError);
  });

  it("refuses a bundle with no Changes in it", () => {
    expect(() => buildBundle(input({ changes: [] }))).toThrow(/describes nothing/);
  });

  it("round trips through signing and opens with the publisher's key", () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKey();
    const { bundle, digest } = buildBundle(input());
    const envelope = signBundle(bundle, digest, privateKeyPem);

    const opened = openBundle(envelope, [publicKeyPem]);
    expect(opened.digest).toBe(digest);
    expect(opened.bundle.changes[0]?.id).toBe("chg_money_in_minor_units");
    expect(opened.keyid.startsWith("sha256:")).toBe(true);
  });

  it("refuses a bundle signed by a key nobody trusts", () => {
    const publisher = generateSigningKey();
    const stranger = generateSigningKey();
    const { bundle, digest } = buildBundle(input());
    const envelope = signBundle(bundle, digest, stranger.privateKeyPem);

    expect(() => openBundle(envelope, [publisher.publicKeyPem])).toThrow(
      /none of the trusted keys signed this bundle/,
    );
  });

  it("refuses a bundle whose payload was edited after signing", () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKey();
    const { bundle, digest } = buildBundle(input());
    const envelope = signBundle(bundle, digest, privateKeyPem);

    // Someone rewrites the scale factor in a released bundle: every consumer
    // migrating from it would move the decimal point the wrong way.
    const statement = JSON.parse(
      Buffer.from(envelope.payload, "base64").toString("utf8"),
    ) as ReturnType<typeof statementFor>;
    const op = statement.predicate.changes[0]?.ops[1];
    if (op && op.op === "convert" && op.codec.kind === "scale10") op.codec.exponent = 3;

    const tampered = {
      ...envelope,
      payload: Buffer.from(JSON.stringify(statement), "utf8").toString("base64"),
    };

    expect(() => openBundle(tampered, [publicKeyPem])).toThrow(SignatureError);
  });

  it("refuses a bundle whose stated subject is not what it contains", () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKey();
    const { bundle, digest } = buildBundle(input());

    // A correctly signed statement about a different digest. The signature is
    // valid, so only comparing the subject with the payload catches it.
    const statement = statementFor(bundle, digest);
    statement.subject[0] = {
      name: "acme-payments/2026-09-20",
      digest: { sha256: "0".repeat(64) },
    };
    const envelope = sign(JSON.stringify(statement), privateKeyPem);

    expect(() => openBundle(envelope, [publicKeyPem])).toThrow(/the statement is about/);
  });

  it("refuses an attestation that is not an evolution bundle at all", () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKey();
    const envelope = sign(
      JSON.stringify({
        _type: "https://in-toto.io/Statement/v1",
        subject: [{ name: "x", digest: { sha256: "0".repeat(64) } }],
        predicateType: "https://slsa.dev/provenance/v1",
        predicate: {},
      }),
      privateKeyPem,
    );

    expect(() => openBundle(envelope, [publicKeyPem])).toThrow(/not an evolution bundle/);
  });

  it("reproduces when a later compiler release writes the same program", () => {
    // What compiled a program is recorded in it, but a rebuild by the next
    // release that produces the same instructions has produced the same
    // release, and the registry must not refuse it for that.
    const original = buildBundle(input()).bundle;
    const rebuilt = buildBundle(
      input({ program: { ...PROGRAM, compiledBy: "@invariant/compiler@9.9.9" } }),
    ).bundle;
    expect(reproduces(original, rebuilt).same).toBe(true);

    const different = buildBundle(
      input({ program: { ...PROGRAM, currentLabel: "2026-09-21" } }),
    ).bundle;
    expect(reproduces(original, different).differences).toEqual(["compiled"]);
  });

  it("names which part of a rebuild did not match", () => {
    const original = buildBundle(input()).bundle;
    const rebuilt = buildBundle(
      input({ source: { repo: "acme/payments-api", commit: "deadbee" } }),
    ).bundle;

    const result = reproduces(original, rebuilt);
    expect(result.same).toBe(false);
    expect(result.differences).toEqual(["source"]);
  });
});

describe("the signing envelope", () => {
  it("binds the payload type into what is signed", () => {
    // DSSE's whole purpose: the type is inside the signed bytes, so a
    // signature over a bundle cannot be presented as one over anything else.
    const encoded = pae(PAYLOAD_TYPE, Buffer.from("hello", "utf8"));
    expect(encoded.toString("utf8")).toBe(
      `DSSEv1 ${PAYLOAD_TYPE.length} ${PAYLOAD_TYPE} 5 hello`,
    );
  });

  it("measures lengths in bytes, not characters", () => {
    // A payload whose length in characters differs from its length in bytes.
    // Getting this wrong produces signatures that verify locally and fail
    // against any other implementation.
    const payload = Buffer.from("café", "utf8");
    expect(payload.length).toBe(5);
    expect(pae("t", payload).toString("utf8")).toBe("DSSEv1 1 t 5 café");
  });

  it("refuses a signing key of the wrong kind", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() =>
      sign("{}", privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
    ).toThrow(/ed25519/);
  });

  it("refuses anything that is not an envelope with a SignatureError", () => {
    // Found by the trust fuzzer (proving/fuzz/trust.test.ts): `invariant
    // verify` on a file whose signatures were not a list printed
    // "envelope.signatures is not iterable".
    const { publicKeyPem } = generateSigningKey();
    for (const candidate of [
      null,
      [],
      "envelope",
      { payload: "", payloadType: PAYLOAD_TYPE, signatures: {} },
      { payload: 1, payloadType: PAYLOAD_TYPE, signatures: [] },
      { payload: "", payloadType: PAYLOAD_TYPE, signatures: [null] },
      { payload: "", payloadType: PAYLOAD_TYPE, signatures: [{ keyid: "k", sig: 1 }] },
    ]) {
      expect(
        () => verify(candidate as never, [publicKeyPem]),
        JSON.stringify(candidate),
      ).toThrow(/not a DSSE envelope/);
    }
  });

  it("refuses a signed payload that is not a statement with a BundleError", () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKey();
    for (const payload of ["null", "[]", "3"]) {
      expect(
        () => openBundle(sign(payload, privateKeyPem), [publicKeyPem]),
        payload,
      ).toThrow(BundleError);
    }
  });

  it("refuses to verify against an empty set of trusted keys", () => {
    const { privateKeyPem } = generateSigningKey();
    const envelope = sign("{}", privateKeyPem);
    expect(() => verify(envelope, [])).toThrow(/no trusted keys/);
  });
});
