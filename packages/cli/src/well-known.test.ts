/**
 * `invariant well-known`: the document a provider serves on its own domain.
 *
 * What it prints is valid under the published schema and read back the same
 * by the reader a consumer runs; it never contains a private key; and
 * regenerating it keeps every key already published, so rotating or
 * revoking is a decision rather than an accident. Keys are made for each run.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { generateSigningKey, parseWellKnown } from "@invariant-app/bundle";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { wellKnownDocument } from "./well-known.ts";

const run = promisify(execFile);
const ROOT = new URL("../../../", import.meta.url).pathname;
const schema = JSON.parse(
  await readFile(join(ROOT, "packages/bundle/well-known.schema.json"), "utf8"),
);
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
const problems = (document: unknown) =>
  validate(document)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message}`);

const first = generateSigningKey();
const second = generateSigningKey();
const config = { api: "acme-payments" };

describe("the document", () => {
  it("lists the API and each key's public half, and is valid under the published schema", () => {
    const document = wellKnownDocument(config, {
      keys: [first.publicKeyPem],
      signingKeyPem: second.privateKeyPem,
      bundlesUrl: "https://bundles.acme.example",
      now: new Date("2026-09-26T10:00:00.123Z"),
    });
    expect(document.apis).toEqual(["acme-payments"]);
    expect(document.keys).toHaveLength(2);
    expect(document.keys.every((key) => key.added_at === "2026-09-26T10:00:00Z")).toBe(
      true,
    );
    expect(document.bundles).toEqual({ url: "https://bundles.acme.example" });
    const text = JSON.stringify(document);
    expect(text).not.toContain("PRIVATE");
    expect(problems(JSON.parse(text))).toEqual([]);
    expect(parseWellKnown(JSON.parse(text))).toEqual(document);
  });

  it("keeps what is published when regenerated, and retires or revokes only what it is told to", () => {
    const published = wellKnownDocument(config, {
      keys: [first.publicKeyPem],
      now: new Date("2026-01-01T00:00:00Z"),
    });
    const [old] = published.keys;
    const next = wellKnownDocument(config, {
      keys: [second.publicKeyPem],
      previous: JSON.stringify(published),
      retire: [old?.keyid as string],
      now: new Date("2026-09-26T00:00:00Z"),
    });
    expect(next.keys.map((key) => [key.added_at, key.not_after, key.revoked])).toEqual([
      ["2026-01-01T00:00:00Z", "2026-09-26T00:00:00Z", undefined],
      ["2026-09-26T00:00:00Z", undefined, undefined],
    ]);
    const revoked = wellKnownDocument(config, {
      keys: [],
      previous: JSON.stringify(next),
      revoke: [old?.keyid as string],
    });
    expect(revoked.keys[0]).toMatchObject({
      revoked: true,
      not_after: "2026-09-26T00:00:00Z",
    });
    expect(problems(revoked)).toEqual([]);
  });

  it("refuses a key id it does not list, a document it cannot read, and having no key", () => {
    expect(() =>
      wellKnownDocument(config, { keys: [first.publicKeyPem], revoke: ["sha256:00"] }),
    ).toThrow(/is not a key the document lists/);
    expect(() => wellKnownDocument(config, { keys: [], previous: "{}" })).toThrow(
      /--from cannot be read/,
    );
    expect(() => wellKnownDocument(config, { keys: [] })).toThrow(
      /there is no key to list/,
    );
  });
});

describe("the published schema", () => {
  type Published = { keys: Record<string, unknown>[]; [field: string]: unknown };
  const valid = (): Published =>
    JSON.parse(JSON.stringify(wellKnownDocument(config, { keys: [first.publicKeyPem] })));

  it.each([
    [
      "a key id that is not one",
      (d: Published) => {
        Object.assign(d.keys[0] ?? {}, { keyid: "sha256:xyz" });
      },
    ],
    [
      "a time with no zone",
      (d: Published) => {
        Object.assign(d.keys[0] ?? {}, { added_at: "2026-09-26T00:00:00" });
      },
    ],
    [
      "a key with no added_at",
      (d: Published) => {
        delete d.keys[0]?.["added_at"];
      },
    ],
    [
      "a field version 1 does not define",
      (d: Published) => {
        d["mirror"] = "https://elsewhere.example";
      },
    ],
    [
      "a bundles URL that is not https",
      (d: Published) => {
        d["bundles"] = { url: "http://bundles.example" };
      },
    ],
  ])("refuses %s", (_why, change) => {
    const document = valid();
    change(document);
    expect(problems(document)).not.toEqual([]);
  });
});

describe("invariant well-known", () => {
  let scratch: string;
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "invariant-well-known-"));
  });
  afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("writes the document from invariant.yaml and the keys given", async () => {
    await writeFile(join(scratch, "publisher.pub"), first.publicKeyPem);
    const out = join(scratch, "invariant.json");
    const { stdout } = await run(
      process.execPath,
      [
        join(ROOT, "packages/cli/src/main.ts"),
        "well-known",
        "--config",
        join(ROOT, "fixtures/provider-acme/invariant.yaml"),
        "--key",
        join(scratch, "publisher.pub"),
        "--out",
        out,
      ],
      { env: { ...process.env, INVARIANT_SIGNING_KEY: "", INVARIANT_URL: "" } },
    );
    expect(stdout).toContain(
      "serve it at https://<your domain>/.well-known/invariant.json",
    );
    const document = parseWellKnown(JSON.parse(await readFile(out, "utf8")));
    expect(document.apis).toEqual(["acme-payments"]);
    expect(document.keys).toHaveLength(1);
    expect(document.bundles).toBeUndefined();
  });
});
