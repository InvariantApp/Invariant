/**
 * Counters leave the process bounded, hashed, and without ever throwing into
 * the request that produced them.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOutcomes } from "@invariant-app/cli";
import { createClient } from "@invariant-app/client";
import { loadContract } from "@invariant-app/contract";
import {
  createRuntime,
  type OutcomeEvent,
  type UsageEvent,
} from "@invariant-app/runtime";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type ContractMock, createContractMock } from "../../../proving/traffic/mock.mts";
import {
  type Batch,
  controlPlaneSink,
  createTelemetry,
  hashConsumer,
  jsonlSink,
  meterSink,
  type Sink,
  type Telemetry,
} from "./index.ts";

const HOUR = 1_790_002_800; // 2026-09-21 13:00 UTC, in seconds
const at = (seconds: number) => () => (HOUR + seconds) * 1000;

const usage = (
  consumer: string | undefined,
  changes: [string, number][],
): UsageEvent => ({
  contract: "2026-01-15",
  operation: "createPayment",
  consumer,
  changes: new Map(changes),
});
const outcome = (result: OutcomeEvent["outcome"], reason?: string): OutcomeEvent => ({
  contract: "2026-01-15",
  operation: "createPayment",
  consumer: "acct_1",
  direction: "response",
  outcome: result,
  ...(reason === undefined ? {} : { reason }),
});

/** A sink that keeps what it is given. */
function kept(): Sink & { batches: Batch[] } {
  const batches: Batch[] = [];
  return {
    name: "kept",
    batches,
    async write(batch) {
      batches.push(batch);
    },
  };
}

let open: Telemetry[] = [];
const telemetry = (options: Parameters<typeof createTelemetry>[0]) => {
  const made = createTelemetry(options);
  open.push(made);
  return made;
};
afterEach(async () => {
  await Promise.all(open.map((made) => made.close()));
  open = [];
});

describe("counting", () => {
  it("folds applications into one row per consumer, contract, change and hour", async () => {
    const sink = kept();
    const counted = telemetry({ sinks: [sink], now: at(60) });
    counted.onUsage(usage("acct_1", [["chg_money", 1]]));
    counted.onUsage(usage("acct_1", [["chg_money", 2]]));
    counted.onUsage(usage("acct_2", [["chg_money", 1]]));
    await counted.flush();

    expect(sink.batches).toHaveLength(1);
    expect(sink.batches[0]?.usage).toEqual([
      {
        consumer: hashConsumer("acct_1"),
        contract: "2026-01-15",
        changeId: "chg_money",
        hour: HOUR,
        count: 3,
      },
      {
        consumer: hashConsumer("acct_2"),
        contract: "2026-01-15",
        changeId: "chg_money",
        hour: HOUR,
        count: 1,
      },
    ]);
  });

  it("never lets a consumer's key leave the process", async () => {
    const sink = kept();
    const counted = telemetry({ sinks: [sink], now: at(0), consumerSalt: "pepper" });
    counted.onUsage(usage("acct_secret_key", [["chg_money", 1]]));
    await counted.flush();
    const text = JSON.stringify(sink.batches);
    expect(text).not.toContain("acct_secret_key");
    expect(text).toContain(hashConsumer("acct_secret_key", "pepper"));
    expect(hashConsumer("acct_secret_key", "pepper")).not.toBe(
      hashConsumer("acct_secret_key"),
    );
  });

  it("counts how each attempt ended, with its reason", async () => {
    const sink = kept();
    const counted = telemetry({ sinks: [sink], now: at(0) });
    counted.onOutcome(outcome("adapted"));
    counted.onOutcome(outcome("adapted"));
    counted.onOutcome(outcome("failed", "amount is not a whole number of cents"));
    await counted.flush();
    expect(sink.batches[0]?.outcomes).toEqual([
      {
        contract: "2026-01-15",
        operation: "createPayment",
        direction: "response",
        outcome: "adapted",
        hour: HOUR,
        count: 2,
      },
      {
        contract: "2026-01-15",
        operation: "createPayment",
        direction: "response",
        outcome: "failed",
        reason: "amount is not a whole number of cents",
        hour: HOUR,
        count: 1,
      },
    ]);
  });

  it("holds a bounded number of counters, and says how many it could not", async () => {
    const sink = kept();
    const counted = telemetry({ sinks: [sink], now: at(0), maxKeys: 2 });
    for (let index = 0; index < 5; index += 1) {
      counted.onUsage(usage(`acct_${index}`, [["chg_money", 1]]));
    }
    counted.onUsage(usage("acct_0", [["chg_money", 4]]));
    expect(counted.dropped).toBe(3);
    await counted.flush();
    expect(sink.batches[0]?.usage.map((row) => row.count)).toEqual([5, 1]);
  });

  it("sends nothing when nothing happened", async () => {
    const sink = kept();
    await telemetry({ sinks: [sink] }).flush();
    expect(sink.batches).toEqual([]);
  });
});

describe("a sink that fails", () => {
  it("is reported, and neither stops the others nor reaches the caller", async () => {
    const errors: string[] = [];
    const good = kept();
    const counted = telemetry({
      sinks: [
        {
          name: "broken",
          write: async () => {
            throw new Error("disk full");
          },
        },
        good,
      ],
      onError: (message) => errors.push(message),
    });
    counted.onUsage(usage("acct_1", [["chg_money", 1]]));
    await expect(counted.flush()).resolves.toBeUndefined();
    expect(good.batches).toHaveLength(1);
    expect(errors).toEqual(["telemetry sink broken failed: disk full"]);
  });
});

describe("closing", () => {
  it("sends what was counted while a send was under way", async () => {
    const batches: Batch[] = [];
    let release: () => void = () => {};
    const slow: Sink = {
      name: "slow",
      write: (batch) =>
        new Promise((resolve) => {
          batches.push(batch);
          release = resolve;
        }),
    };
    const counted = createTelemetry({ sinks: [slow], now: at(0) });
    counted.onUsage(usage("acct_1", [["chg_money", 1]]));
    const first = counted.flush();
    counted.onUsage(usage("acct_2", [["chg_money", 1]]));
    const closed = counted.close();
    release();
    await first;
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await closed;
    expect(batches.flatMap((batch) => batch.usage).map((row) => row.count)).toEqual([
      1, 1,
    ]);
  });
});

describe("the control plane sink", () => {
  let mock: ContractMock;
  beforeAll(async () => {
    const contract = await loadContract(
      join(import.meta.dirname, "../../client/openapi.yaml"),
      "2026-09-21",
    );
    mock = createContractMock(contract.document, { seed: 3 });
  });

  it("sends rows the control plane's contract accepts", async () => {
    mock.reset();
    const client = createClient({
      baseUrl: "https://control-plane.test",
      token: "tok_test",
      fetch: (input, init) => mock.fetch(new Request(input, init)),
    });
    const counted = telemetry({ sinks: [controlPlaneSink(client)], now: at(0) });
    counted.onUsage(usage("acct_1", [["chg_money", 2]]));
    counted.onUsage(usage(undefined, [["chg_money", 1]]));
    counted.onOutcome(outcome("refused", "unknown status value"));
    await counted.flush();
    expect(mock.log.map((entry) => [entry.path, entry.request])).toEqual([
      ["/v1/ingest", []],
    ]);
  });

  it("keeps rows through an outage, and retries them under the same key", async () => {
    const keys: (string | null)[] = [];
    let up = false;
    const client = createClient({
      baseUrl: "https://control-plane.test",
      fetch: async (_input, init) => {
        keys.push(new Headers(init?.headers).get("idempotency-key"));
        return up
          ? Response.json({ accepted: 1, ignored: 0 })
          : new Response("unavailable", { status: 503 });
      },
    });
    const errors: string[] = [];
    const counted = telemetry({
      sinks: [controlPlaneSink(client)],
      now: at(0),
      onError: (message) => errors.push(message),
    });
    counted.onUsage(usage("acct_1", [["chg_money", 1]]));
    await counted.flush();
    expect(errors.join()).toMatch(/1 rows kept for the next attempt/);

    up = true;
    counted.onUsage(usage("acct_2", [["chg_money", 1]]));
    await counted.flush();
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("drops rows the control plane refused for a reason a retry would not change", async () => {
    let calls = 0;
    const client = createClient({
      baseUrl: "https://control-plane.test",
      fetch: async () => {
        calls += 1;
        return Response.json(
          { error: { code: "malformed", message: "bad rows" } },
          { status: 400 },
        );
      },
    });
    const errors: string[] = [];
    const sink = controlPlaneSink(client);
    const counted = telemetry({
      sinks: [sink],
      now: at(0),
      onError: (message) => errors.push(message),
    });
    counted.onUsage(usage("acct_1", [["chg_money", 1]]));
    await counted.flush();
    await sink.write({ usage: [], outcomes: [] });
    expect(calls).toBe(1);
    expect(errors.join()).toMatch(/1 rows refused and dropped: bad rows/);
  });

  it("keeps a bounded number of rows while the control plane is away", async () => {
    const client = createClient({
      baseUrl: "https://control-plane.test",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const sink = controlPlaneSink(client, { maxPendingRows: 2 });
    const row = (index: number) => ({
      contract: "v1",
      changeId: "chg_money",
      hour: HOUR,
      count: index,
    });
    await expect(
      sink.write({ usage: [row(1), row(2), row(3)], outcomes: [] }),
    ).rejects.toThrow(/3 rows dropped while the control plane was away/);
  });
});

describe("the file sink", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "invariant-telemetry-"));
    return () => rm(dir, { recursive: true, force: true });
  });

  it("writes outcomes the release's runtime evidence reads", async () => {
    const path = join(dir, "outcomes.jsonl");
    const counted = telemetry({ sinks: [jsonlSink(path)], now: at(0) });
    counted.onUsage(usage("acct_1", [["chg_money", 1]]));
    counted.onOutcome(outcome("adapted"));
    counted.onOutcome(outcome("failed", "no exact value"));
    await counted.flush();
    expect(await readOutcomes(path)).toEqual([
      {
        contract: "2026-01-15",
        operation: "createPayment",
        direction: "response",
        outcome: "adapted",
        count: 1,
      },
      {
        contract: "2026-01-15",
        operation: "createPayment",
        direction: "response",
        outcome: "failed",
        count: 1,
        reason: "no exact value",
      },
    ]);
  });

  it("rotates by size, keeping a bounded number of old files", async () => {
    const path = join(dir, "rotated.jsonl");
    const sink = jsonlSink(path, { maxBytes: 200, keep: 2 });
    const row = { contract: "v1", changeId: "chg_money", hour: HOUR, count: 1 };
    for (let index = 0; index < 6; index += 1) {
      await sink.write({ usage: [row], outcomes: [] });
    }
    const sizes = await Promise.all(
      [path, `${path}.1`, `${path}.2`].map(async (file) => (await readFile(file)).length),
    );
    for (const size of sizes) expect(size).toBeLessThanOrEqual(200);
    await expect(readFile(`${path}.3`)).rejects.toThrow();
  });
});

describe("the meter sink", () => {
  it("adds to counters named as the design names them", async () => {
    const added: [string, number, Record<string, string> | undefined][] = [];
    const sink = meterSink({
      createCounter: (name) => ({
        add: (value, attributes) => added.push([name, value, attributes]),
      }),
    });
    await sink.write({
      usage: [{ contract: "v1", changeId: "chg_money", hour: HOUR, count: 3 }],
      outcomes: [
        {
          contract: "v1",
          operation: "createPayment",
          direction: "response",
          outcome: "failed",
          hour: HOUR,
          count: 1,
        },
      ],
    });
    expect(added).toEqual([
      ["invariant.change_applied", 3, { contract: "v1", change: "chg_money" }],
      [
        "invariant.transform_error",
        1,
        { contract: "v1", operation: "createPayment", direction: "response" },
      ],
    ]);
  });
});

describe("wired to a runtime", () => {
  it("counts what the runtime actually did", async () => {
    const program = JSON.parse(
      await readFile(
        join(
          import.meta.dirname,
          "../../../fixtures/provider-acme/invariant/compiled/program.json",
        ),
        "utf8",
      ),
    ) as unknown;
    const sink = kept();
    const counted = telemetry({ sinks: [sink], now: at(0) });
    const runtime = createRuntime({
      program,
      identity: [{ kind: "default", label: "2026-01-15" }],
      onUsage: counted.onUsage,
      onOutcome: counted.onOutcome,
    });
    const site = runtime.siteFor("2026-01-15", "post", "/v1/payments");
    if (!site) throw new Error("the fixture program has no payments site");
    runtime.transformRequest(site, JSON.stringify({ amount: 12.5, currency: "usd" }), {
      contract: "2026-01-15",
      operation: "createPayment",
      consumer: "acct_1",
    });
    await counted.flush();
    const [batch] = sink.batches;
    expect(batch?.usage.length).toBeGreaterThan(0);
    expect(batch?.usage.every((row) => row.consumer === hashConsumer("acct_1"))).toBe(
      true,
    );
    expect(batch?.outcomes).toEqual([
      expect.objectContaining({ direction: "request", outcome: "adapted", count: 1 }),
    ]);
  });
});
