/**
 * Artifact tampering: a signed evolution bundle, altered on its way to the
 * person checking it.
 *
 * Each attack is a file handed to `invariant verify`, the verb a provider or
 * a consumer runs, with the provider's public key. The claim under test is
 * DESIGN 11.1's: a bundle is believed only if a trusted key signed exactly
 * these bytes, the statement says it is an evolution bundle, and the digest
 * it names is the digest the bundle inside it has. Anything else exits
 * non-zero and prints no bundle.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildBundle,
  type DsseEnvelope,
  generateSigningKey,
  sign,
  signBundle,
  statementFor,
} from "@invariant-app/bundle";
import { canonicalize, digestOf } from "@invariant-app/contract";
import { type JsonValue, withoutProvenance } from "@invariant-app/ir";
import { createRuntime, ProgramError } from "@invariant-app/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invariant, ROOT, workdir } from "./harness.ts";

const CONFIG = join(ROOT, "fixtures/provider-acme/invariant.yaml");

const provider = generateSigningKey();
const attacker = generateSigningKey();

const { bundle, digest } = buildBundle({
  api: "acme-payments",
  from: { label: "2026-03-01", digest: "sha256:aaaa" },
  to: { label: "2026-09-20", digest: "sha256:bbbb" },
  source: { repo: "acme/payments-api", commit: "c0ffee" },
  changes: [
    {
      irVersion: 1,
      id: "chg_money_in_minor_units",
      summary: "Money crosses the wire in minor units.",
      scopes: [{ schema: "#/components/schemas/Payment" }],
      ops: [{ op: "move", from: "/amount", to: "/amount_cents" }],
    },
  ],
  evidence: [],
  program: {
    irVersion: 2,
    compiledBy: "threats",
    minRuntime: "0.1.0",
    api: "acme-payments",
    current: "sha256:bbbb",
    currentLabel: "2026-09-20",
    contracts: {},
  },
  gate: { result: "warn", unexplained: ["a declared loss old callers will see"] },
});

const honest = signBundle(bundle, digest, provider.privateKeyPem);
const keyidOf = (envelope: DsseEnvelope) => envelope.signatures[0]?.keyid as string;

/** A statement signed as the provider, as if their key had signed it. */
const signedStatement = (statement: unknown, key = provider.privateKeyPem) =>
  sign(canonicalize(statement as JsonValue), key);

/** The payload of an envelope, edited, with the signature left as it was. */
function edited(
  envelope: DsseEnvelope,
  edit: (statement: Record<string, unknown>) => void,
) {
  const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  edit(statement);
  return {
    ...envelope,
    payload: Buffer.from(canonicalize(statement), "utf8").toString("base64"),
  };
}

let dir: string;
let providerKey: string;

beforeAll(async () => {
  dir = await workdir("artifacts");
  providerKey = join(dir, "provider.pub.pem");
  await writeFile(providerKey, provider.publicKeyPem, "utf8");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function verify(envelope: unknown, name: string, ...extra: string[]) {
  const path = join(dir, `${name}.json`);
  await writeFile(
    path,
    typeof envelope === "string" ? envelope : JSON.stringify(envelope),
  );
  return invariant(["verify", path, "--key", providerKey, "--config", CONFIG, ...extra]);
}

describe("invariant verify", () => {
  it("opens the bundle the provider signed", async () => {
    const result = await verify(honest, "honest");
    expect(result.code).toBe(0);
    expect(result.output).toContain(`signed by  ${keyidOf(honest)}`);
    expect(result.output).toContain(`digest     ${digest}`);
  });

  const attacks: [string, () => unknown, RegExp][] = [
    [
      "a Change edited after signing",
      () =>
        edited(honest, (statement) => {
          const predicate = statement["predicate"] as { changes: { ops: unknown[] }[] };
          (predicate.changes[0] as { ops: unknown[] }).ops = [
            { op: "move", from: "/amount", to: "/refund_to" },
          ];
        }),
      /does not match the payload/,
    ],
    [
      "the release gate's warning edited into a pass",
      () =>
        edited(honest, (statement) => {
          (statement["predicate"] as { gate: unknown }).gate = {
            result: "pass",
            unexplained: [],
          };
        }),
      /does not match the payload/,
    ],
    [
      "an attacker's signature under the provider's key id",
      () => ({
        ...signBundle(bundle, digest, attacker.privateKeyPem),
        signatures: [
          {
            keyid: keyidOf(honest),
            sig: signBundle(bundle, digest, attacker.privateKeyPem).signatures[0]?.sig,
          },
        ],
      }),
      /does not match the payload/,
    ],
    [
      "an attacker's own signature",
      () => signBundle(bundle, digest, attacker.privateKeyPem),
      /none of the trusted keys signed this bundle/,
    ],
    [
      "every signature stripped",
      () => ({ ...honest, signatures: [] }),
      /none of the trusted keys signed this bundle/,
    ],
    [
      "the signature lifted onto another payload type",
      () => ({ ...honest, payloadType: "application/json" }),
      /this envelope carries application\/json/,
    ],
    [
      "another kind of attestation the provider signed, offered as a bundle",
      () =>
        signedStatement({
          ...statementFor(bundle, digest),
          predicateType: "https://slsa.dev/provenance/v1",
        }),
      /not an evolution bundle/,
    ],
    [
      "a statement whose subject names the honest digest over a different bundle",
      () =>
        signedStatement({
          ...statementFor(bundle, digest),
          predicate: { ...bundle, source: { ...bundle.source, repo: "evil/fork" } },
        }),
      /digests to/,
    ],
    [
      "a bundle of a version this build does not read",
      () =>
        signedStatement({
          ...statementFor(bundle, digest),
          predicate: { ...bundle, bundleVersion: 99 },
        }),
      /this bundle is version 99/,
    ],
    ["a list where an envelope should be", () => "[]", /this is not a DSSE envelope/],
    [
      "signatures that are not strings",
      () => ({ ...honest, signatures: [{ keyid: 1, sig: {} }] }),
      /this is not a DSSE envelope/,
    ],
  ];

  it.each(attacks)("refuses %s", async (name, make, message) => {
    const result = await verify(make(), name.replace(/\W+/g, "-"));
    expect(result.code).toBe(1);
    expect(result.output).toMatch(message);
    // What an opened bundle prints: none of it, for any of these.
    expect(result.output).not.toMatch(/^ {2}signed by {2}/m);
  });

  it("never hands a bundle's commit to git as an option, whoever signed it", async () => {
    // A stolen key signs whatever the thief likes, and `--rebuild` passes the
    // commit the bundle names to `git worktree add`. `--orphan=x` would be read
    // as an option there.
    const hostile = { ...bundle, source: { ...bundle.source, commit: "--orphan=x" } };
    const envelope = signedStatement(
      statementFor(hostile, digestOf(hostile as unknown as JsonValue)),
    );
    const result = await verify(envelope, "hostile-commit", "--rebuild");
    expect(result.code).toBe(1);
    expect(result.output).toContain("which is not a commit id");
  });
});

describe("a program checked against invariant.lock", () => {
  // What `invariant compile` wrote, from the fixture provider's Changes.
  let compiled: { program: Record<string, unknown>; lock: { programDigest: string } };

  beforeAll(async () => {
    const dir = await workdir("lock");
    const result = await invariant([
      "compile",
      "--config",
      CONFIG,
      "--out",
      join(dir, "program.json"),
    ]);
    expect(result.code, result.output).toBe(0);
    compiled = {
      program: JSON.parse(await readFile(join(dir, "program.json"), "utf8")),
      lock: JSON.parse(await readFile(join(dir, "invariant.lock"), "utf8")),
    };
    await rm(dir, { recursive: true, force: true });
  }, 120_000);

  it("loads the program the lock names, by the digest the evolution bundle records", () => {
    expect(compiled.lock.programDigest).toBe(
      digestOf(withoutProvenance(compiled.program) as unknown as JsonValue),
    );
    expect(() =>
      createRuntime({
        program: compiled.program,
        programDigest: compiled.lock.programDigest,
      }),
    ).not.toThrow();
  });

  it.each([
    [
      "a changed label",
      (program: Record<string, unknown>) => ({ ...program, currentLabel: "x" }),
    ],
    [
      "a dropped contract",
      (program: Record<string, unknown>) => ({ ...program, contracts: {} }),
    ],
    [
      "one byte of a transform",
      (program: Record<string, unknown>) =>
        JSON.parse(JSON.stringify(program).replace(/"amount/, '"amounT')) as Record<
          string,
          unknown
        >,
    ],
  ])("refuses at load a program edited after it was compiled: %s", (_name, edit) => {
    expect(() =>
      createRuntime({
        program: edit(compiled.program),
        programDigest: compiled.lock.programDigest,
      }),
    ).toThrow(ProgramError);
  });
});
