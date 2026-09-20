import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenApiDocument } from "@invariant/contract";
import type { JsonObject, JsonValue } from "@invariant/ir";
import { afterEach, describe, expect, it } from "vitest";
import { diffDocuments, oasdiffAvailable } from "./oasdiff.ts";
import { additiveEntries, breakingEntries, isBreaking } from "./policy.ts";

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
        'oasdiff is required on CI. Install with "go install github.com/oasdiff/oasdiff@latest".',
      ).toBe(true);
    } else if (!hasOasdiff) {
      console.warn(
        "oasdiff is not installed, so closure tests are skipped locally. " +
          'Install with "go install github.com/oasdiff/oasdiff@latest".',
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
