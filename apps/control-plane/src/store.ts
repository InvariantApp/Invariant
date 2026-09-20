/**
 * The registry's storage.
 *
 * Small on purpose. Git in the provider's repository is the source of truth for
 * what a Change says; this is an index and a distribution point, and everything
 * in it except the counters can be rebuilt from a provider's repository. That
 * is the real disaster recovery story and it is worth not undermining by
 * storing anything here that cannot be derived again.
 *
 * Every row is keyed by the API it belongs to, and every query takes that key
 * from the token rather than from the request. A parameter a caller controls
 * must never be able to select which tenant's rows come back.
 */
import { PGlite } from "@electric-sql/pglite";

export interface StoredBundle {
  digest: string;
  api: string;
  fromLabel: string;
  toLabel: string;
  payload: string;
  keyid: string;
  publishedAt: number;
}

export interface UsageRow {
  api: string;
  consumer: string;
  contract: string;
  changeId: string;
  count: number;
  lastSeen: number;
}

const SCHEMA = `
  create table if not exists apis (
    id text primary key,
    token_hash text not null,
    publisher_keys text not null
  );

  create table if not exists bundles (
    digest text primary key,
    api text not null references apis(id),
    from_label text not null,
    to_label text not null,
    payload text not null,
    keyid text not null,
    published_at bigint not null
  );

  create index if not exists bundles_api on bundles(api);

  -- One row per consumer, contract and change. Ingest folds into it rather
  -- than appending, because a runtime that retries a batch must not double
  -- count, and a counter that drifts upward would retire nothing.
  create table if not exists usage (
    api text not null references apis(id),
    consumer text not null,
    contract text not null,
    change_id text not null,
    count bigint not null,
    last_seen bigint not null,
    primary key (api, consumer, contract, change_id)
  );

  create table if not exists flags (
    api text primary key references apis(id),
    document text not null,
    updated_at bigint not null
  );
`;

export class Store {
  readonly #db: PGlite;

  private constructor(db: PGlite) {
    this.#db = db;
  }

  static async open(dataDir?: string): Promise<Store> {
    const db = new PGlite(dataDir);
    await db.exec(SCHEMA);
    return new Store(db);
  }

  async close(): Promise<void> {
    await this.#db.close();
  }

  async registerApi(
    id: string,
    tokenHash: string,
    publisherKeys: readonly string[],
  ): Promise<void> {
    await this.#db.query(
      `insert into apis (id, token_hash, publisher_keys) values ($1, $2, $3)
       on conflict (id) do update set token_hash = $2, publisher_keys = $3`,
      [id, tokenHash, JSON.stringify(publisherKeys)],
    );
  }

  /**
   * The API a token belongs to.
   *
   * This is the only place an API id enters a request. Taking it from a path
   * or a body would mean a valid token for one tenant could name another.
   */
  async apiForToken(
    tokenHash: string,
  ): Promise<{ id: string; publisherKeys: string[] } | undefined> {
    const result = await this.#db.query<{ id: string; publisher_keys: string }>(
      "select id, publisher_keys from apis where token_hash = $1",
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return { id: row.id, publisherKeys: JSON.parse(row.publisher_keys) as string[] };
  }

  async putBundle(bundle: StoredBundle): Promise<{ created: boolean }> {
    const result = await this.#db.query(
      `insert into bundles (digest, api, from_label, to_label, payload, keyid, published_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (digest) do nothing`,
      [
        bundle.digest,
        bundle.api,
        bundle.fromLabel,
        bundle.toLabel,
        bundle.payload,
        bundle.keyid,
        bundle.publishedAt,
      ],
    );
    // Publishing the same bundle twice is not an error. It is content
    // addressed, so a retry carries the identical digest and the identical
    // bytes, and refusing it would make a network hiccup look like a conflict.
    return { created: (result.affectedRows ?? 0) > 0 };
  }

  async getBundle(api: string, digest: string): Promise<StoredBundle | undefined> {
    const result = await this.#db.query<{
      digest: string;
      api: string;
      from_label: string;
      to_label: string;
      payload: string;
      keyid: string;
      published_at: number;
    }>("select * from bundles where api = $1 and digest = $2", [api, digest]);

    const row = result.rows[0];
    if (!row) return undefined;
    return {
      digest: row.digest,
      api: row.api,
      fromLabel: row.from_label,
      toLabel: row.to_label,
      payload: row.payload,
      keyid: row.keyid,
      publishedAt: Number(row.published_at),
    };
  }

  async listBundles(api: string): Promise<StoredBundle[]> {
    const result = await this.#db.query<{
      digest: string;
      from_label: string;
      to_label: string;
      published_at: number;
    }>(
      `select digest, from_label, to_label, published_at from bundles
       where api = $1 order by published_at desc`,
      [api],
    );
    return result.rows.map((row) => ({
      digest: row.digest,
      api,
      fromLabel: row.from_label,
      toLabel: row.to_label,
      payload: "",
      keyid: "",
      publishedAt: Number(row.published_at),
    }));
  }

  /**
   * Folds a batch of counters in.
   *
   * The count is replaced rather than added to, because the runtime reports a
   * running total for a window rather than a delta. A retried batch therefore
   * settles on the same number instead of doubling it, and a counter that
   * drifted upward would keep an old contract alive forever.
   */
  async ingestUsage(rows: readonly UsageRow[]): Promise<void> {
    for (const row of rows) {
      await this.#db.query(
        `insert into usage (api, consumer, contract, change_id, count, last_seen)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (api, consumer, contract, change_id) do update
           set count = greatest(usage.count, excluded.count),
               last_seen = greatest(usage.last_seen, excluded.last_seen)`,
        [row.api, row.consumer, row.contract, row.changeId, row.count, row.lastSeen],
      );
    }
  }

  async impact(api: string): Promise<UsageRow[]> {
    const result = await this.#db.query<{
      consumer: string;
      contract: string;
      change_id: string;
      count: number;
      last_seen: number;
    }>(
      `select consumer, contract, change_id, count, last_seen from usage
       where api = $1 order by contract, change_id, consumer`,
      [api],
    );
    return result.rows.map((row) => ({
      api,
      consumer: row.consumer,
      contract: row.contract,
      changeId: row.change_id,
      count: Number(row.count),
      lastSeen: Number(row.last_seen),
    }));
  }

  async setFlags(api: string, document: string, updatedAt: number): Promise<void> {
    await this.#db.query(
      `insert into flags (api, document, updated_at) values ($1, $2, $3)
       on conflict (api) do update set document = $2, updated_at = $3`,
      [api, document, updatedAt],
    );
  }

  async getFlags(api: string): Promise<{ document: string; updatedAt: number }> {
    const result = await this.#db.query<{ document: string; updated_at: number }>(
      "select document, updated_at from flags where api = $1",
      [api],
    );
    const row = result.rows[0];
    // No row means nothing is switched off, which is the right default: a
    // missing flags row must never read as "everything disabled".
    return row
      ? { document: row.document, updatedAt: Number(row.updated_at) }
      : { document: "{}", updatedAt: 0 };
  }
}
