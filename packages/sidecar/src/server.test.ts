/**
 * The proxy terminating TLS, and serving HTTP/2 and HTTP/1.1 on one port.
 *
 * Some official SDKs, stripe-go among them, speak only HTTP/2 over TLS, so a
 * proxy that answers only plain HTTP/1.1 cannot sit in front of them at all.
 * The certificate is made for this test and thrown away.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:http2";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "@invariant/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProxy } from "./proxy.ts";
import { type Listening, serve } from "./server.ts";

const PROGRAM = {
  irVersion: 2,
  api: "payments",
  currentLabel: "new",
  current: "sha256:head",
  identity: [
    { kind: "header", name: "payments-version" },
    { kind: "default", label: "new" },
  ],
  contracts: {
    old: {
      label: "old",
      routes: [],
      sites: {
        "post /v1/payments": {
          request: [{ k: "move", from: "/amount", to: "/amount_cents", c: "chg_cents" }],
          response: {
            "2xx": [{ k: "move", from: "/amount_cents", to: "/amount", c: "chg_cents" }],
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
let cert: Buffer;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "invariant-tls-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  cert = readFileSync(join(dir, "cert.pem"));

  // Answers with what it was sent, and a connection header HTTP/2 forbids.
  upstream = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => {
      response.writeHead(201, {
        "content-type": "application/json",
        connection: "keep-alive",
      });
      response.end(JSON.stringify({ seen: JSON.parse(text), amount_cents: 1999 }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  proxy = await serve(
    createProxy({
      runtime: createRuntime({ program: PROGRAM }),
      upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    }),
    { port: 0, tls: { cert, key: readFileSync(join(dir, "key.pem")) } },
  );
});

afterAll(async () => {
  await proxy.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

describe("the proxy over TLS", () => {
  it("serves an HTTP/2 caller, adapted, without HTTP/1.1's connection headers", async () => {
    expect(proxy.url).toMatch(/^https:\/\//);
    const session = connect(proxy.url, { ca: cert });
    try {
      const { status, headers, body } = await new Promise<{
        status: number;
        headers: Record<string, unknown>;
        body: string;
      }>((resolve, reject) => {
        const stream = session.request({
          ":method": "POST",
          ":path": "/v1/payments",
          "content-type": "application/json",
          "payments-version": "old",
        });
        let received: Record<string, unknown> = {};
        let text = "";
        stream.on("response", (head) => (received = head));
        stream.on("data", (chunk) => (text += chunk));
        stream.on("end", () =>
          resolve({ status: Number(received[":status"]), headers: received, body: text }),
        );
        stream.on("error", reject);
        stream.end(JSON.stringify({ amount: 1999 }));
      });
      expect(status).toBe(201);
      expect(JSON.parse(body)).toEqual({ seen: { amount_cents: 1999 }, amount: 1999 });
      expect(headers["invariant-contract"]).toBe("old");
      expect(headers["connection"]).toBeUndefined();
    } finally {
      session.close();
    }
  });

  it("serves an HTTP/1.1 caller on the same port", async () => {
    const { status, body } = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const request = httpsRequest(
          `${proxy.url}/v1/payments`,
          {
            method: "POST",
            ca: cert,
            headers: { "content-type": "application/json", "payments-version": "old" },
          },
          (response) => {
            let text = "";
            response.on("data", (chunk) => (text += chunk));
            response.on("end", () =>
              resolve({ status: response.statusCode ?? 0, body: text }),
            );
          },
        );
        request.on("error", reject);
        request.end(JSON.stringify({ amount: 5 }));
      },
    );
    expect(status).toBe(201);
    expect(JSON.parse(body)).toEqual({ seen: { amount_cents: 5 }, amount: 1999 });
  });
});
