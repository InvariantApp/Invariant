/**
 * What the provider sees, and what the caller gets back, through the proxy
 * with nothing to translate.
 *
 * Found by running go-sdk 0.22.1's own suite through the proxy to Gitea 1.25
 * (proving/servers): two tests that passed against Gitea directly failed
 * through it, and neither involved a Change. Gitea builds its avatar links
 * from the Host a request arrived with once any X-Forwarded-Proto is present,
 * and the proxy sent the upstream's own host with a scheme it had invented;
 * and Gitea answers marking notifications read with 205 and the updated
 * threads, a body `fetch` throws away because 205 is a status it expects
 * none for.
 */
import { createServer, type IncomingHttpHeaders, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRuntime } from "@invariant-app/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProxy } from "./proxy.ts";
import { type Listening, serve } from "./server.ts";

const PROGRAM = {
  irVersion: 2,
  api: "gitea",
  currentLabel: "new",
  current: "sha256:head",
  identity: [
    { kind: "header", name: "gitea-version" },
    { kind: "default", label: "new" },
  ],
  contracts: {
    old: {
      label: "old",
      routes: [],
      sites: {
        "put /notifications": {
          response: {
            "205": [
              { k: "move", from: "/*/unread", to: "/*/is_unread", c: "chg_unread" },
            ],
          },
        },
      },
      behaviors: [],
      retired: [],
    },
  },
};

let upstream: Server;
let proxy: Listening;
let seen: IncomingHttpHeaders[] = [];

beforeAll(async () => {
  upstream = createServer((incoming, outgoing) => {
    seen.push(incoming.headers);
    if (incoming.url === "/notifications") {
      outgoing.writeHead(205, { "content-type": "application/json" });
      outgoing.end(JSON.stringify([{ id: 1, unread: false }]));
      return;
    }
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  proxy = await serve(
    createProxy({
      runtime: createRuntime({ program: PROGRAM }),
      upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    }),
    { port: 0 },
  );
});

afterAll(async () => {
  await proxy.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

function call(
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const { port } = new URL(proxy.url);
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { host: "127.0.0.1", port, method, path, headers },
      (answer) => {
        let body = "";
        answer.on("data", (chunk) => (body += chunk));
        answer.on("end", () => resolve({ status: answer.statusCode ?? 0, body }));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

describe("the provider, behind the proxy", () => {
  it("sees the Host the caller sent, and no forwarding headers the caller did not", async () => {
    seen = [];
    await call("GET", "/version", { host: "gitea.example:3000" });
    expect(seen[0]?.host).toBe("gitea.example:3000");
    expect(seen[0]?.["x-forwarded-proto"]).toBeUndefined();
    expect(seen[0]?.["x-forwarded-host"]).toBeUndefined();
    // Who is calling is still said, as every proxy says it.
    expect(seen[0]?.["x-forwarded-for"]).toBe("127.0.0.1");
  });

  it("sees the forwarding headers a proxy in front of this one set", async () => {
    seen = [];
    await call("GET", "/version", {
      host: "gitea.internal",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "gitea.example",
    });
    expect(seen[0]?.host).toBe("gitea.internal");
    expect(seen[0]?.["x-forwarded-proto"]).toBe("https");
    expect(seen[0]?.["x-forwarded-host"]).toBe("gitea.example");
  });
});

describe("the caller, through the proxy", () => {
  it("gets the body a 205 carries, as a current caller", async () => {
    const answer = await call("PUT", "/notifications", { host: "gitea.example" });
    expect(answer.status).toBe(205);
    expect(JSON.parse(answer.body)).toEqual([{ id: 1, unread: false }]);
  });

  it("gets the body a 205 carries translated, as an old caller", async () => {
    const answer = await call("PUT", "/notifications", {
      host: "gitea.example",
      "gitea-version": "old",
    });
    expect(answer.status).toBe(205);
    expect(JSON.parse(answer.body)).toEqual([{ id: 1, is_unread: false }]);
  });
});
