import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { EXCHANGE_HEADER, startRecorder } from "./recorder.ts";

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function upstream(): Promise<{ url: string; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(String(request.headers[EXCHANGE_HEADER] ?? ""));
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      response.writeHead(201, {
        "content-type": "application/json",
        "content-encoding": "gzip",
      });
      response.end(gzipSync(JSON.stringify({ echoed: body, path: request.url })));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

describe("the recorder", () => {
  it("forwards untouched and writes down what it carried, numbered", async () => {
    const target = await upstream();
    const inner = await startRecorder({
      port: 16_398,
      upstream: target.url,
      numbering: "read",
    });
    const outer = await startRecorder({
      port: 16_399,
      upstream: "http://127.0.0.1:16398",
      numbering: "assign",
    });
    const first = await fetch("http://127.0.0.1:16399/items/7?full=1", {
      method: "POST",
      body: "hello",
    });
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ echoed: "hello", path: "/items/7?full=1" });
    await fetch("http://127.0.0.1:16399/items/8");

    const sent = await outer.close();
    const given = await inner.close();
    expect(target.seen).toEqual(["0", "1"]);
    expect(
      sent.map((exchange) => [
        exchange.id,
        exchange.method,
        exchange.path,
        exchange.status,
      ]),
    ).toEqual([
      [0, "POST", "/items/7", 201],
      [1, "GET", "/items/8", 201],
    ]);
    expect(given.map((exchange) => exchange.id)).toEqual([0, 1]);
    expect(sent[0]?.body).toEqual({ echoed: "hello", path: "/items/7?full=1" });
  });
});
