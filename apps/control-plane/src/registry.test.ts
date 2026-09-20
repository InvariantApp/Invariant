/**
 * The registry, against a real Postgres.
 *
 * PGlite is Postgres, so the isolation being tested is the isolation that would
 * hold in production rather than something a mock agreed to. Most of these are
 * about a tenant not being able to reach another tenant's rows, because that is
 * the failure that cannot be walked back.
 */
import { buildBundle, generateSigningKey, signBundle } from "@invariant/bundle";
import type { Change, CompiledProgram } from "@invariant/ir";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createControlPlane, hashToken, Store } from "./index.ts";

const CHANGE: Change = {
  irVersion: 1,
  id: "chg_money_in_minor_units",
  summary: "Money crosses the wire in minor units.",
  scopes: [{ schema: "#/components/schemas/Payment" }],
  ops: [{ op: "move", from: "/amount", to: "/amount_cents" }],
};

const PROGRAM: CompiledProgram = {
  irVersion: 1,
  api: "acme-payments",
  current: "sha256:aaaa",
  currentLabel: "2026-09-20",
  contracts: {},
};

function bundleFor(api: string) {
  return buildBundle({
    api,
    from: { label: "2026-03-01", digest: "sha256:bbbb" },
    to: { label: "2026-09-20", digest: "sha256:aaaa" },
    source: { repo: `${api}/api`, commit: "c0ffee" },
    changes: [CHANGE],
    evidence: [],
    program: { ...PROGRAM, api },
    gate: { result: "pass", unexplained: [] },
  });
}

let store: Store;
let app: ReturnType<typeof createControlPlane>;

const acme = generateSigningKey();
const other = generateSigningKey();

beforeEach(async () => {
  store = await Store.open();
  app = createControlPlane(store);
  await store.registerApi("acme-payments", hashToken("tok_acme"), [acme.publicKeyPem]);
  await store.registerApi("rival-billing", hashToken("tok_rival"), [other.publicKeyPem]);
});

afterEach(async () => {
  await store.close();
});

function call(path: string, token?: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
}

async function publish(api: string, token: string, key: string) {
  const { bundle, digest } = bundleFor(api);
  const envelope = signBundle(bundle, digest, key);
  const response = await call("/v1/bundles", token, {
    method: "POST",
    body: JSON.stringify(envelope),
  });
  return { response, digest, envelope };
}

describe("getting in at all", () => {
  it("refuses a request with no token", async () => {
    expect((await call("/v1/impact")).status).toBe(401);
  });

  it("refuses a token nobody issued", async () => {
    expect((await call("/v1/impact", "tok_made_up")).status).toBe(401);
  });

  it("answers health without one", async () => {
    expect((await app.request("/health")).status).toBe(200);
  });
});

describe("publishing a bundle", () => {
  it("accepts one signed by a key the provider registered", async () => {
    const { response, digest } = await publish(
      "acme-payments",
      "tok_acme",
      acme.privateKeyPem,
    );

    expect(response.status).toBe(201);
    expect(((await response.json()) as { digest: string }).digest).toBe(digest);
  });

  /**
   * The registry verifies rather than trusts. A bundle signed by a key nobody
   * registered is what this endpoint exists to refuse; without that it is
   * somewhere to put anything.
   */
  it("refuses one signed by a key nobody registered", async () => {
    const { response } = await publish("acme-payments", "tok_acme", other.privateKeyPem);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("none of the trusted keys");
  });

  it("refuses one that was edited after signing", async () => {
    const { bundle, digest } = bundleFor("acme-payments");
    const envelope = signBundle(bundle, digest, acme.privateKeyPem);

    const statement = JSON.parse(
      Buffer.from(envelope.payload, "base64").toString("utf8"),
    ) as { predicate: { changes: Change[] } };
    const first = statement.predicate.changes[0];
    if (first) first.summary = "Something else entirely.";

    const response = await call("/v1/bundles", "tok_acme", {
      method: "POST",
      body: JSON.stringify({
        ...envelope,
        payload: Buffer.from(JSON.stringify(statement), "utf8").toString("base64"),
      }),
    });

    expect(response.status).toBe(400);
  });

  /**
   * A token is for one tenant and says so. The bundle naming a different API
   * is refused even though its signature is perfectly valid, because a valid
   * signature is a statement about authorship, not about authorisation.
   */
  it("refuses a validly signed bundle for an API the token is not for", async () => {
    const { bundle, digest } = bundleFor("rival-billing");
    const envelope = signBundle(bundle, digest, acme.privateKeyPem);

    const response = await call("/v1/bundles", "tok_acme", {
      method: "POST",
      body: JSON.stringify(envelope),
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("this token is for");
  });

  it("treats republishing the same bundle as done, not as a conflict", async () => {
    await publish("acme-payments", "tok_acme", acme.privateKeyPem);
    const again = await publish("acme-payments", "tok_acme", acme.privateKeyPem);

    // Content addressed, so a retry carries identical bytes. Refusing it would
    // make a network hiccup look like an error a person has to resolve.
    expect(again.response.status).toBe(200);
    expect(((await again.response.json()) as { created: boolean }).created).toBe(false);
  });
});

describe("keeping tenants apart", () => {
  it("does not let one provider read another's bundle by digest", async () => {
    const { digest } = await publish("acme-payments", "tok_acme", acme.privateKeyPem);

    // The digest is content addressed and therefore guessable by anyone who
    // has the same source. Knowing it must not be enough.
    const mine = await call(`/v1/bundles/${digest}`, "tok_acme");
    expect(mine.status).toBe(200);

    const theirs = await call(`/v1/bundles/${digest}`, "tok_rival");
    expect(theirs.status).toBe(404);
  });

  it("does not let one provider list another's bundles", async () => {
    await publish("acme-payments", "tok_acme", acme.privateKeyPem);

    const listed = (await (await call("/v1/bundles", "tok_rival")).json()) as {
      bundles: unknown[];
    };
    expect(listed.bundles).toEqual([]);
  });

  it("keeps counters apart even when the rows look identical", async () => {
    const records = [
      {
        consumer: "hash_alpha",
        contract: "2026-01-15",
        changeId: "chg_money_in_minor_units",
        count: 5,
        lastSeen: 1_800_000_000,
      },
    ];

    await call("/v1/ingest/usage", "tok_acme", {
      method: "POST",
      body: JSON.stringify({ records }),
    });

    const theirs = (await (await call("/v1/impact", "tok_rival")).json()) as {
      usage: unknown[];
    };
    expect(theirs.usage).toEqual([]);

    const mine = (await (await call("/v1/impact", "tok_acme")).json()) as {
      usage: { count: number }[];
    };
    expect(mine.usage).toHaveLength(1);
  });

  it("ignores an api a caller puts in the body", async () => {
    await call("/v1/ingest/usage", "tok_acme", {
      method: "POST",
      body: JSON.stringify({
        records: [
          {
            api: "rival-billing",
            consumer: "hash_alpha",
            contract: "2026-01-15",
            changeId: "chg_x",
            count: 1,
            lastSeen: 1,
          },
        ],
      }),
    });

    // The tenant comes from the token. A field in the body naming another one
    // is not an error, it is simply not consulted.
    const theirs = (await (await call("/v1/impact", "tok_rival")).json()) as {
      usage: unknown[];
    };
    expect(theirs.usage).toEqual([]);
  });
});

describe("counters", () => {
  const record = (count: number, lastSeen: number) => ({
    consumer: "hash_alpha",
    contract: "2026-01-15",
    changeId: "chg_money_in_minor_units",
    count,
    lastSeen,
  });

  async function ingest(...records: ReturnType<typeof record>[]) {
    return call("/v1/ingest/usage", "tok_acme", {
      method: "POST",
      body: JSON.stringify({ records }),
    });
  }

  it("does not double count a batch that was retried", async () => {
    await ingest(record(10, 1_800_000_000));
    await ingest(record(10, 1_800_000_000));

    const { usage } = (await (await call("/v1/impact", "tok_acme")).json()) as {
      usage: { count: number }[];
    };
    // A runtime reports a running total, so a retry settles on the same number.
    // A counter that drifted upward would keep an old contract alive forever.
    expect(usage[0]?.count).toBe(10);
  });

  it("takes the higher count and the later sighting", async () => {
    await ingest(record(10, 1_800_000_000));
    await ingest(record(14, 1_800_000_100));

    const { usage } = (await (await call("/v1/impact", "tok_acme")).json()) as {
      usage: { count: number; lastSeen: number }[];
    };
    expect(usage[0]?.count).toBe(14);
    expect(usage[0]?.lastSeen).toBe(1_800_000_100);
  });

  it("does not go backwards when an older batch arrives late", async () => {
    await ingest(record(14, 1_800_000_100));
    await ingest(record(10, 1_800_000_000));

    const { usage } = (await (await call("/v1/impact", "tok_acme")).json()) as {
      usage: { count: number }[];
    };
    expect(usage[0]?.count).toBe(14);
  });

  it("drops a malformed record and keeps the rest", async () => {
    const response = await call("/v1/ingest/usage", "tok_acme", {
      method: "POST",
      body: JSON.stringify({
        records: [record(1, 1), { consumer: 5 }, record(2, 2)],
      }),
    });

    // One bad row in a batch from a running service must not lose the batch.
    const body = (await response.json()) as { accepted: number; ignored: number };
    expect(body.accepted).toBe(2);
    expect(body.ignored).toBe(1);
  });
});

describe("flags", () => {
  it("says nothing is switched off when nothing has been set", async () => {
    const body = (await (await call("/v1/flags", "tok_acme")).json()) as {
      flags: Record<string, unknown>;
    };
    // A missing row must never read as "everything disabled".
    expect(body.flags).toEqual({});
  });

  it("answers an unchanged poll without a body", async () => {
    await call("/v1/flags", "tok_acme", {
      method: "PUT",
      body: JSON.stringify({ allDisabled: true }),
    });

    const first = await call("/v1/flags", "tok_acme");
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const second = await call("/v1/flags", "tok_acme", {
      headers: { "if-none-match": etag as string },
    });
    // Every instance polls this, and almost every poll finds nothing changed.
    expect(second.status).toBe(304);
  });

  it("keeps one provider's flags away from another's", async () => {
    await call("/v1/flags", "tok_acme", {
      method: "PUT",
      body: JSON.stringify({ allDisabled: true }),
    });

    const theirs = (await (await call("/v1/flags", "tok_rival")).json()) as {
      flags: Record<string, unknown>;
    };
    expect(theirs.flags).toEqual({});
  });
});
