/**
 * A WebSocket, or any other `Upgrade`, through the proxy: the handshake goes
 * to the upstream with the caller's path and headers, and after it the bytes
 * flow both ways untouched.
 */
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { createRuntime } from "@invariant-app/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProxy } from "./proxy.ts";
import { type Listening, serve } from "./server.ts";
import { passUpgrades } from "./upgrade.ts";

const PROGRAM = {
  irVersion: 2,
  api: "a",
  currentLabel: "new",
  current: "sha256:0",
  identity: [{ kind: "default", label: "new" }],
  contracts: {},
};

let upstream: Server;
let proxy: Listening;
const handshakes: { url: string; headers: Record<string, unknown> }[] = [];

beforeAll(async () => {
  // Echoes whatever arrives after the handshake, so bytes are seen to flow
  // both ways.
  upstream = createServer();
  upstream.on("upgrade", (incoming, socket: Duplex) => {
    handshakes.push({ url: incoming.url ?? "", headers: incoming.headers });
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const at = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/api`;
  proxy = await serve(
    createProxy({ runtime: createRuntime({ program: PROGRAM }), upstream: at }),
    { port: 0, upgrade: passUpgrades(at) },
  );
});

afterAll(async () => {
  await proxy.close();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

describe("an upgraded connection through the proxy", () => {
  it("reaches the upstream under its base path, and echoes both ways", async () => {
    const socket = await new Promise<Duplex>((resolve, reject) => {
      const handshake = request(`${proxy.url}/v1/stream?room=7`, {
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "x-invariant-contract-hint": "forged",
        },
      });
      handshake.on("upgrade", (_response, socket) => resolve(socket));
      handshake.on("error", reject);
      handshake.end();
    });
    const echoed = await new Promise<string>((resolve) => {
      socket.once("data", (chunk: Buffer) => resolve(chunk.toString()));
      socket.write("ping");
    });
    socket.destroy();
    expect(echoed).toBe("ping");
    expect(handshakes[0]?.url).toBe("/api/v1/stream?room=7");
    expect(handshakes[0]?.headers["upgrade"]).toBe("websocket");
    expect(handshakes[0]?.headers["x-forwarded-for"]).toBe("127.0.0.1");
    expect(handshakes[0]?.headers["x-invariant-contract-hint"]).toBeUndefined();
  });

  it("answers 502 when the upstream cannot be reached", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const nowhere = await serve(
      createProxy({
        runtime: createRuntime({ program: PROGRAM }),
        upstream: `http://127.0.0.1:${port}`,
      }),
      { port: 0, upgrade: passUpgrades(`http://127.0.0.1:${port}`) },
    );
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const handshake = request(`${nowhere.url}/v1/stream`, {
          headers: { connection: "Upgrade", upgrade: "websocket" },
        });
        handshake.on("response", (response) => resolve(response.statusCode ?? 0));
        handshake.on("upgrade", () => reject(new Error("upgraded to nothing")));
        handshake.on("error", reject);
        handshake.end();
      });
      expect(status).toBe(502);
    } finally {
      await nowhere.close();
    }
  });
});
