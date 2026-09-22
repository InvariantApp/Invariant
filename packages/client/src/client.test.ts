/**
 * The client, held to the contract by something that is not the client.
 *
 * Every call is made against a mock that knows only `openapi.yaml`, and whose
 * judge is the proving ground's independent validator. A request the contract
 * does not allow is refused there, and an answer the contract allows has to be
 * understood here, so the client and the document cannot drift apart without
 * a test saying which operation did.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadContract, operationsOf } from "@invariant-app/contract";
import openapiTS, { astToString } from "openapi-typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { type ContractMock, createContractMock } from "../../../proving/traffic/mock.mts";
import {
  CONTRACT_VERSION,
  type ControlPlaneClient,
  ControlPlaneError,
  createClient,
} from "./index.ts";

const ROOT = join(import.meta.dirname, "..");
const DOCUMENT = join(ROOT, "openapi.yaml");

let mock: ContractMock;
let client: ControlPlaneClient;

const DIGEST = `sha256:${"a".repeat(64)}`;
const KEYID = `sha256:${"b".repeat(64)}`;
const CONSUMER = "c".repeat(32);
const HOUR = 1_790_000_000 - (1_790_000_000 % 3600);
const ENVELOPE = {
  payloadType: "application/vnd.in-toto+json" as const,
  payload: Buffer.from("{}").toString("base64"),
  signatures: [{ keyid: KEYID, sig: Buffer.from("sig").toString("base64") }],
};

/** Every operation, called the way its user calls it. */
const CALLS: Record<string, (client: ControlPlaneClient) => Promise<unknown>> = {
  getHealth: (c) => c.health(),
  publishBundle: (c) =>
    c.publishBundle(ENVELOPE, { idempotencyKey: "release-2026-09-21" }),
  listBundles: (c) => c.listBundles({ limit: 10 }),
  getBundle: (c) => c.getBundle(DIGEST),
  ingest: (c) =>
    c.ingest(
      {
        usage: [
          {
            consumer: CONSUMER,
            contract: "2026-01-15",
            changeId: "chg_money_in_minor_units",
            hour: HOUR,
            count: 12,
          },
        ],
        outcomes: [
          {
            contract: "2026-01-15",
            operation: "createPayment",
            direction: "response",
            outcome: "adapted",
            hour: HOUR,
            count: 12,
          },
        ],
      },
      { idempotencyKey: "batch-000000001" },
    ),
  heartbeat: (c) =>
    c.heartbeat({
      instance: "instance-0001",
      runtime: { version: "0.1.0", binding: "hono" },
      program: { digest: DIGEST, compiledBy: "@invariant-app/compiler@0.1.0" },
      flags: { source: "remote", etag: '"abc"' },
      startedAt: HOUR,
    }),
  getFlags: (c) => c.getFlags('"held"'),
  setFlags: (c) =>
    c.setFlags(
      { flags: { disabledContracts: ["2026-01-15"] }, reason: "refunds are failing" },
      '"held"',
    ),
  listFlagChanges: (c) => c.listFlagChanges(),
  listContracts: (c) => c.listContracts(),
  getContract: (c) => c.getContract("2026-01-15"),
  getImpact: (c) => c.getImpact({ days: 30 }),
  propose: (c) => c.propose({ from: { openapi: "3.1.0" }, to: { openapi: "3.1.0" } }),
  listConsumers: (c) => c.listConsumers({ contract: "2026-01-15", limit: 20 }),
  createLink: (c) => c.createLink(CONSUMER, { expiresInDays: 7 }),
  listIntegrations: (c) => c.listIntegrations(),
  listMigrations: (c) => c.listMigrations({ status: "opened" }),
  listTokens: (c) => c.listTokens(),
  createToken: (c) => c.createToken({ name: "ci", scopes: ["publish", "read"] }),
  revokeToken: (c) => c.revokeToken("tok_abcdefgh1234"),
  listKeys: (c) => c.listKeys(),
  addKey: (c) =>
    c.addKey({
      name: "release",
      publicKey:
        "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\n-----END PUBLIC KEY-----\n",
    }),
  revokeKey: (c) => c.revokeKey(KEYID, "the key left the building"),
  listPublicBundles: (c) => c.listPublicBundles("acme-payments"),
  getPublicBundle: (c) => c.getPublicBundle("acme-payments", DIGEST),
};

beforeAll(async () => {
  const contract = await loadContract(DOCUMENT, CONTRACT_VERSION);
  mock = createContractMock(contract.document, { seed: 7 });
  client = createClient({
    baseUrl: "https://control-plane.test",
    token: "tok_test",
    fetch: (input, init) => mock.fetch(new Request(input, init)),
  });
});

describe("the contract", () => {
  it("is one this product can read, with an id and a scope on every operation", async () => {
    const contract = await loadContract(DOCUMENT, CONTRACT_VERSION);
    const operations = operationsOf(contract.document);
    expect(operations.length).toBeGreaterThan(20);
    for (const { operationId, operation } of operations) {
      expect(operationId, JSON.stringify(operation).slice(0, 80)).toBeTruthy();
      const open =
        Array.isArray(operation["security"]) && operation["security"].length === 0;
      if (!open) {
        expect(operation["x-invariant-scope"], operationId).toMatch(
          /^(read|publish|ingest|flags:read|flags:write|propose|admin)$/,
        );
      }
    }
  });

  it("is the version this client sends", async () => {
    const document = parse(await readFile(DOCUMENT, "utf8")) as {
      info: { version: string };
    };
    expect(document.info.version).toBe(CONTRACT_VERSION);
  });

  it("is what the client's types were generated from", async () => {
    // Regenerate with `pnpm --filter @invariant-app/client generate`.
    const generated = astToString(await openapiTS(new URL(`file://${DOCUMENT}`)));
    const committed = await readFile(join(ROOT, "src/schema.ts"), "utf8");
    expect(committed).toBe(
      `/**\n * This file was auto-generated by openapi-typescript.\n * Do not make direct changes to the file.\n */\n\n${generated}`,
    );
  });
});

describe("the client", () => {
  it("has a call for every operation in the contract", async () => {
    const contract = await loadContract(DOCUMENT, CONTRACT_VERSION);
    const ids = operationsOf(contract.document).map((operation) => operation.operationId);
    expect(Object.keys(CALLS).sort()).toEqual([...ids].sort());
  });

  for (const [operationId, run] of Object.entries(CALLS)) {
    it(`calls ${operationId} as the contract says, and reads the answer`, async () => {
      mock.reset();
      await run(client);
      expect(mock.log).toHaveLength(1);
      const [judged] = mock.log;
      expect(judged?.request ?? [], JSON.stringify(judged)).toEqual([]);
      expect(judged?.responseValid ?? true, JSON.stringify(judged)).toBe(true);
    });
  }

  it("names the version it was written against on every call", async () => {
    let seen: string | null = null;
    const spy = createClient({
      baseUrl: "https://control-plane.test",
      fetch: async (input, init) => {
        seen = new Headers(init?.headers).get("invariant-version");
        return mock.fetch(new Request(input, init));
      },
    });
    await spy.health();
    expect(seen).toBe(CONTRACT_VERSION);
  });
});

describe("a call that does not succeed", () => {
  const answering = (response: Response) =>
    createClient({ baseUrl: "https://control-plane.test", fetch: async () => response });

  it("says what the service said, with its code", async () => {
    const failed = answering(
      Response.json(
        {
          error: {
            code: "insufficient_scope",
            message: "This token cannot publish.",
            requestId: "req_1",
          },
        },
        { status: 403 },
      ),
    ).publishBundle(ENVELOPE);
    await expect(failed).rejects.toMatchObject({
      name: "ControlPlaneError",
      status: 403,
      code: "insufficient_scope",
      requestId: "req_1",
      message: "This token cannot publish.",
    });
  });

  it("says how long to wait when told to slow down", async () => {
    const failed = answering(
      Response.json(
        { error: { code: "rate_limited", message: "Slow down." } },
        { status: 429, headers: { "retry-after": "30" } },
      ),
    ).ingest({ usage: [] });
    await expect(failed).rejects.toMatchObject({ status: 429, retryAfter: 30 });
  });

  it("is a typed error with no status when the service cannot be reached", async () => {
    const offline = createClient({
      baseUrl: "https://control-plane.test",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const error = await offline.getFlags().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ControlPlaneError);
    expect(error).toMatchObject({ status: 0, code: "unreachable" });
  });

  it("is understood even when the answer is not the contract's error shape", async () => {
    const failed = answering(
      new Response("upstream timed out", { status: 502 }),
    ).listContracts();
    await expect(failed).rejects.toMatchObject({ status: 502, code: "unexpected" });
  });

  it("tells an unchanged flag poll from a changed one", async () => {
    expect(await answering(new Response(null, { status: 304 })).getFlags('"x"')).toEqual({
      changed: false,
    });
  });
});
