import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenApiDocument } from "@invariant-app/contract";
import type { JsonObject, JsonValue } from "@invariant-app/ir";
import { afterEach, describe, expect, it } from "vitest";
import {
  diffDocuments,
  diffOutcome,
  oasdiffAvailable,
  UnstableDiffError,
} from "./oasdiff.ts";
import {
  additiveEntries,
  BREAKING_INFO_IDS,
  breakingEntries,
  isBreaking,
} from "./policy.ts";
import { OASDIFF_INSTALL } from "./version.ts";

interface DocParts {
  requestProperties: JsonObject;
  requestRequired: string[];
  responseProperties: JsonObject;
  responseRequired: string[];
}

function doc(parts: Partial<DocParts> = {}): OpenApiDocument {
  const {
    requestProperties = { amount: { type: "number" } },
    requestRequired = ["amount"],
    responseProperties = {
      id: { type: "string" },
      status: { type: "string", enum: ["ok", "bad"] },
    },
    responseRequired = ["id", "status"],
  } = parts;

  const json = (schema: JsonValue): JsonValue => ({
    content: { "application/json": { schema } },
  });

  return {
    openapi: "3.1.0",
    info: { title: "things", version: "1" },
    paths: {
      "/things": {
        post: {
          operationId: "things.create",
          requestBody: {
            required: true,
            ...(json({
              type: "object",
              required: requestRequired,
              properties: requestProperties,
            }) as JsonObject),
          },
          responses: {
            "201": {
              description: "created",
              ...(json({
                type: "object",
                required: responseRequired,
                properties: responseProperties,
              }) as JsonObject),
            },
          },
        },
      },
    },
  };
}

const hasOasdiff = await oasdiffAvailable();

describe("oasdiff availability", () => {
  it("is installed wherever the closure tests are meant to be trusted", () => {
    // A skipped safety check looks exactly like a passing one in a summary, so
    // on CI its absence is a failure rather than a quiet skip.
    if (process.env["CI"]) {
      expect(
        hasOasdiff,
        `oasdiff is required on CI. Install with "${OASDIFF_INSTALL}".`,
      ).toBe(true);
    } else if (!hasOasdiff) {
      console.warn(
        "oasdiff is not installed, so closure tests are skipped locally. " +
          `Install with "${OASDIFF_INSTALL}".`,
      );
    }
  });
});

describe.skipIf(!hasOasdiff)("structural diff", () => {
  it("reports nothing for identical documents", async () => {
    expect(await diffDocuments(doc(), doc())).toEqual([]);
  });

  it("classifies a removed request property as breaking despite its WARN level", async () => {
    const entries = await diffDocuments(
      doc(),
      doc({ requestProperties: {}, requestRequired: [] }),
    );
    const removed = entries.find((entry) => entry.id === "request-property-removed");
    expect(removed?.level).toBe(2);
    expect(removed && isBreaking(removed)).toBe(true);
  });

  it("separates breaking from additive entries", async () => {
    const entries = await diffDocuments(
      doc(),
      doc({
        responseProperties: {
          id: { type: "string" },
          status: { type: "string", enum: ["ok", "bad"] },
          note: { type: "string" },
        },
      }),
    );
    expect(breakingEntries(entries)).toEqual([]);
    expect(additiveEntries(entries).length).toBeGreaterThan(0);
  });

  it("treats a narrowed response enum as breaking for an existing consumer", async () => {
    const entries = await diffDocuments(
      doc(),
      doc({
        responseProperties: {
          id: { type: "string" },
          status: { type: "string", enum: ["ok"] },
        },
      }),
    );
    // oasdiff rates this INFO, because a provider narrowing its own output is
    // safe for a tolerant reader. A consumer that switches on the old value set
    // still notices, and Invariant promises the old contract exactly.
    const narrowed = entries.find((e) => e.id === "response-property-enum-value-removed");
    expect(narrowed?.level).toBe(1);
    expect(breakingEntries(entries)).not.toEqual([]);
  });
});

/**
 * The differ is a subprocess, and for a long time every way it could fail was
 * reported as "Could not run oasdiff. Install it with ...".
 *
 * That sentence cost a machine. Two real Stripe specifications a month apart
 * drove the differ to 3.1 GB resident and took the whole environment down with
 * it, and the report said the binary was not installed. A failure that names
 * the wrong cause sends the reader to their PATH while the real problem is
 * still there, so each cause is now told apart and each says what it was.
 */
describe("when the differ does not come back", () => {
  const binary = process.env["OASDIFF_BIN"];
  afterEach(() => {
    if (binary === undefined) delete process.env["OASDIFF_BIN"];
    else process.env["OASDIFF_BIN"] = binary;
  });

  it("says a slow diff ran out of time, not that it is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "invariant-slow-"));
    const fake = join(dir, "slow.sh");
    await writeFile(fake, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    process.env["OASDIFF_BIN"] = fake;

    try {
      await expect(diffDocuments(doc(), doc(), { timeoutMs: 250 })).rejects.toThrow(
        /did not finish within 250 ms/,
      );
      await expect(diffDocuments(doc(), doc(), { timeoutMs: 250 })).rejects.not.toThrow(
        /Install it with/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("still says so when the binary really is missing", async () => {
    process.env["OASDIFF_BIN"] = join(tmpdir(), "invariant-no-such-differ");
    await expect(diffDocuments(doc(), doc())).rejects.toThrow(/Could not find/);
  });

  it("passes the memory limit down to the differ", async () => {
    // The limit has to reach the Go runtime to do anything, and nothing else
    // in the pipeline would notice if it stopped being set.
    const dir = await mkdtemp(join(tmpdir(), "invariant-env-"));
    const fake = join(dir, "echo-env.sh");
    await writeFile(fake, '#!/bin/sh\nprintf \'[{"id":"%s"}]\' "$GOMEMLIMIT"\n', {
      mode: 0o755,
    });
    process.env["OASDIFF_BIN"] = fake;

    try {
      const entries = await diffDocuments(doc(), doc(), { memoryLimit: "512MiB" });
      expect(entries[0]?.id).toBe("512MiB");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The reduced path, and the policy bug that shipping it exposed.
 *
 * `oasdiff changelog` cannot compute a full changelog for two consecutive
 * Stripe documents: a dozen changed schemas fan out to over 55,000 entries,
 * because a schema Stripe reuses across 589 operations is reported once per
 * operation, and all of them are built in memory before any level filter
 * applies. `oasdiff breaking` evaluates fewer checks and finishes the same pair
 * in about twenty seconds, which is the difference between covering Stripe and
 * not covering it.
 *
 * It reports WARN and ERR only, so the two checks this policy calls breaking at
 * INFO have to be promoted to appear at all. Doing that broke the policy: the
 * old `isBreaking` dispatched on the level, so a promoted entry arrived at WARN,
 * was not in the WARN set, and stopped counting. 154 real Plaid enum removals
 * vanished. `isBreaking` now decides by id, and an agreement check over 58 real
 * pairs holds the two paths to the same answer.
 */
describe.skipIf(!hasOasdiff)("the reduced diff path", () => {
  const narrowed = () =>
    doc({
      responseProperties: {
        id: { type: "string" },
        status: { type: "string", enum: ["ok"] },
      },
    });

  it("agrees with the full changelog about what is breaking", async () => {
    const full = await diffOutcome(doc(), narrowed(), { fallback: false });
    const reduced = await diffOutcome(doc(), narrowed(), {
      mode: "breaking",
      extraArgs: ["--severity-levels", await severityFixture()],
      fallback: false,
    });

    expect(full.mode).toBe("changelog");
    expect(reduced.mode).toBe("breaking");
    const key = (entry: { id: string; operationId: string; text: string }) =>
      `${entry.id}|${entry.operationId}|${entry.text}`;
    expect(breakingEntries(reduced.entries).map(key).sort()).toEqual(
      breakingEntries(full.entries).map(key).sort(),
    );
    expect(breakingEntries(full.entries).length).toBeGreaterThan(0);
  });

  it("counts a promoted INFO check as breaking despite its new level", async () => {
    // This is the regression. The entry arrives at WARN rather than INFO, and
    // the policy must still recognise it.
    const reduced = await diffOutcome(doc(), narrowed(), {
      mode: "breaking",
      extraArgs: ["--severity-levels", await severityFixture()],
      fallback: false,
    });
    const promoted = reduced.entries.find(
      (entry) => entry.id === "response-property-enum-value-removed",
    );
    expect(promoted?.level).toBe(2);
    expect(promoted && isBreaking(promoted)).toBe(true);
  });

  it("does not retry a document that is simply broken", async () => {
    // Retrying a dangling reference would double the wait to report the same
    // thing, so only a differ that was stopped is worth a second attempt.
    const dir = await mkdtemp(join(tmpdir(), "invariant-badspec-"));
    const fake = join(dir, "fail.sh");
    const calls = join(dir, "calls");
    await writeFile(
      fake,
      `#!/bin/sh\nprintf x >> ${calls}\necho "boom" >&2\nexit 102\n`,
      {
        mode: 0o755,
      },
    );
    const previous = process.env["OASDIFF_BIN"];
    process.env["OASDIFF_BIN"] = fake;
    try {
      await expect(diffDocuments(doc(), doc())).rejects.toThrow(/exited with 102/);
      expect((await readFile(calls, "utf8")).length).toBe(1);
    } finally {
      if (previous === undefined) delete process.env["OASDIFF_BIN"];
      else process.env["OASDIFF_BIN"] = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** The promotion file, written from the policy so it cannot drift from it. */
async function severityFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "invariant-sev-"));
  const path = join(dir, "severity.txt");
  await writeFile(
    path,
    `${[...BREAKING_INFO_IDS].map((id) => `${id} warn`).join("\n")}\n`,
  );
  return path;
}

/**
 * The differ is not always reproducible, and a gate cannot be built on an
 * answer that changes between runs.
 *
 * oasdiff 1.32.1, given the same command and the same two Stripe documents
 * three times, returned 18,990, then 38,442, then 23,838 entries. The runs were
 * not truncations of one another: 16,563 findings appeared only in the first
 * and 36,015 only in the second, across the same 11 check ids. Pairs at
 * ordinary sizes were stable across three runs each, so this is something the
 * largest comparisons provoke rather than something always present.
 *
 * A wrong count here is not a cosmetic problem. The closure check decides
 * whether a release is allowed to ship, so an unreproducible answer has to be
 * refused rather than averaged, rounded, or believed.
 */
describe("a differ that will not give the same answer twice", () => {
  const previous = process.env["OASDIFF_BIN"];
  afterEach(() => {
    if (previous === undefined) delete process.env["OASDIFF_BIN"];
    else process.env["OASDIFF_BIN"] = previous;
  });

  /** Answers with a different number of entries on each call. */
  async function flakyDiffer(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "invariant-flaky-"));
    const fake = join(dir, "flaky.sh");
    const counter = join(dir, "n");
    await writeFile(
      fake,
      `#!/bin/sh
printf x >> ${counter}
n=$(wc -c < ${counter})
printf '['
i=0
while [ $i -lt $n ]; do
  [ $i -gt 0 ] && printf ','
  printf '{"id":"response-body-type-changed","text":"t","level":3,"operation":"GET","operationId":"o","path":"/p","section":"paths","fingerprint":"fp%s"}' "$i"
  i=$((i+1))
done
printf ']'
`,
      { mode: 0o755 },
    );
    process.env["OASDIFF_BIN"] = fake;
    return dir;
  }

  it("refuses the result rather than reporting one of the two", async () => {
    const dir = await flakyDiffer();
    try {
      await expect(diffOutcome(doc(), doc(), { confirm: true })).rejects.toThrow(
        /not reproducible/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("says both counts, because the gap is the evidence", async () => {
    const dir = await flakyDiffer();
    try {
      await expect(diffOutcome(doc(), doc(), { confirm: true })).rejects.toThrow(
        /returned 1 entries and then 2/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not repeat the work when confirmation was not asked for", async () => {
    // Confirmation doubles the cost, so it stays opt-in and the default path
    // must not quietly pay for it.
    const dir = await flakyDiffer();
    try {
      const outcome = await diffOutcome(doc(), doc());
      expect(outcome.entries).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("an unstable diff", () => {
  it("says what differed, where the two runs gave the same number of entries", () => {
    expect(new UnstableDiffError(5600, 5600).message).toMatch(
      /returned 5600 entries twice for the same two documents, but not the same ones/,
    );
    expect(new UnstableDiffError(18990, 38442).message).toMatch(
      /returned 18990 entries and then 38442/,
    );
  });
});
