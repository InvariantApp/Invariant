/**
 * An XML operation behind the Node binding, over a real socket: the body an
 * old caller sends is adapted on the way in, the answer on the way out, and a
 * body the program does not describe reaches the handler as it was sent.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRuntime } from "@invariant-app/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adaptListener } from "./index.ts";

const config = {
  read: { type: "object", properties: { State: { type: "string" } } },
  write: { type: "object", properties: { State: { type: "string" } } },
};

const program = {
  irVersion: 2,
  api: "cloudfront",
  current: "sha256:0",
  currentLabel: "new",
  identity: [
    { kind: "header", name: "cloudfront-version" },
    { kind: "default", label: "new" },
  ],
  contracts: {
    old: {
      label: "old",
      routes: [],
      sites: {
        "put /config": {
          xml: { request: config, response: { "200": config } },
          request: [
            { k: "enum", path: "/State", map: { on: "enabled" }, c: "chg_state" },
          ],
          response: {
            "200": [
              { k: "enum", path: "/State", map: { enabled: "on" }, c: "chg_state" },
            ],
          },
        },
      },
      behaviors: [],
      retired: [],
    },
  },
};

let server: Server;
let base: string;
let received: string[] = [];

beforeAll(async () => {
  const runtime = createRuntime({ program });
  server = createServer(
    adaptListener(
      async (request, response) => {
        let text = "";
        for await (const chunk of request) text += chunk;
        received.push(text);
        response.setHeader(
          "content-type",
          request.headers["content-type"] ?? "text/plain",
        );
        response.end(text);
      },
      { runtime },
    ),
  );
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((done) => server.close(() => done())));

const put = (body: string, type: string) =>
  fetch(`${base}/config`, {
    method: "PUT",
    headers: { "content-type": type, "cloudfront-version": "old" },
    body,
  });

describe("an XML operation behind the Node binding", () => {
  it("adapts an old caller's body on the way in and the answer on the way out", async () => {
    received = [];
    const response = await put(
      '<Config id="1">\n  <State>on</State>\n</Config>',
      "text/xml",
    );
    expect(received).toEqual(['<Config id="1">\n  <State>enabled</State>\n</Config>']);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<Config id="1">\n  <State>on</State>\n</Config>');
  });

  it("refuses a body it cannot read before the handler runs", async () => {
    received = [];
    const response = await put(
      '<!DOCTYPE Config SYSTEM "file:///etc/passwd"><Config/>',
      "text/xml",
    );
    expect(response.status).toBe(400);
    expect(received).toEqual([]);
  });

  it("hands a body the program does not describe to the handler as it was sent", async () => {
    received = [];
    const response = await put("State=on", "text/plain");
    expect(received).toEqual(["State=on"]);
    expect(await response.text()).toBe("State=on");
  });
});
