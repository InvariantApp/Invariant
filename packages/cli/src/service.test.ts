/**
 * Publishing and status against the service: what is sent, that sending
 * again sends nothing new, and that what is missing is said plainly.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { InvariantConfig } from "./config.ts";
import {
  clientFromEnv,
  DEFAULT_SERVICE_URL,
  publishBundles,
  renderPublished,
  renderStatus,
  ServiceError,
  status,
} from "./service.ts";

/** The service, as far as these verbs meet it: it keeps what it is sent, once. */
function service() {
  const kept = new Map<string, unknown>();
  const seen: { method: string; path: string; auth: string | null }[] = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization");
    seen.push({ method: init?.method ?? "GET", path: url.pathname + url.search, auth });
    if (url.pathname === "/v1/bundles" && init?.method === "POST") {
      const envelope = JSON.parse(String(init.body)) as { payload: string };
      const digest = `sha256:${Buffer.from(envelope.payload).toString("hex").padEnd(64, "0").slice(0, 64)}`;
      const created = !kept.has(digest);
      kept.set(digest, envelope);
      return Response.json(
        { digest, created, api: "acme", to: "x" },
        { status: created ? 201 : 200 },
      );
    }
    if (url.pathname === "/v1/contracts") {
      return Response.json({
        contracts: [
          { label: "2026-03-01", status: "served", releasedAt: 1 },
          { label: "2026-09-20", status: "current", releasedAt: 2 },
        ],
      });
    }
    if (url.pathname === "/v1/impact") {
      return Response.json({
        days: 30,
        contracts: [
          {
            label: "2026-03-01",
            consumers: 3,
            requests: 120,
            changes: [],
            retirable: false,
          },
        ],
      });
    }
    return Response.json(
      { error: { code: "not_found", message: "no", requestId: "r" } },
      { status: 404 },
    );
  }) as typeof fetch;
  return { fetchImpl, seen, kept };
}

async function withBundles(labels: string[]): Promise<InvariantConfig> {
  const invariantDir = await mkdtemp(join(tmpdir(), "invariant-publish-"));
  await mkdir(join(invariantDir, "bundles"));
  for (const label of labels) {
    await writeFile(
      join(invariantDir, "bundles", `${label}.dsse.json`),
      JSON.stringify({
        payloadType: "application/vnd.in-toto+json",
        payload: `p-${label}`,
        signatures: [],
      }),
    );
  }
  return { invariantDir } as InvariantConfig;
}

describe("publish", () => {
  it("sends every signed release with the token, and nothing twice", async () => {
    const svc = service();
    const { client, url } = clientFromEnv({ INVARIANT_TOKEN: "inv_abc" }, svc.fetchImpl);
    expect(url).toBe(DEFAULT_SERVICE_URL);
    const config = await withBundles(["2026-03-01", "2026-09-20"]);
    const first = await publishBundles(config, client);
    expect(first.map((p) => [p.label, p.created])).toEqual([
      ["2026-03-01", true],
      ["2026-09-20", true],
    ]);
    expect(svc.seen.every((call) => call.auth === "Bearer inv_abc")).toBe(true);
    const again = await publishBundles(config, client, "2026-09-20");
    expect(again.map((p) => p.created)).toEqual([false]);
    expect(renderPublished(again, url)).toContain("already published  2026-09-20");
  });

  it("says what to do when there is no token, or nothing to publish", async () => {
    expect(() => clientFromEnv({})).toThrow(/INVARIANT_TOKEN is not set/);
    const { client } = clientFromEnv(
      { INVARIANT_TOKEN: "t", INVARIANT_URL: "https://self.example" },
      service().fetchImpl,
    );
    await expect(publishBundles(await withBundles([]), client)).rejects.toThrow(
      ServiceError,
    );
    await expect(publishBundles(await withBundles(["a"]), client, "b")).rejects.toThrow(
      /no signed release b/,
    );
  });
});

describe("status", () => {
  it("shows each contract, newest first, with who is still on it", async () => {
    const { client } = clientFromEnv({ INVARIANT_TOKEN: "t" }, service().fetchImpl);
    expect(renderStatus(await status(client))).toBe(
      "2026-09-20   current   what your handlers speak\n" +
        "2026-03-01   served    120 requests from 3 consumers in 30 days\n",
    );
  });
});
