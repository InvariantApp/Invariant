import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { connect, createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { allowlist, isHostName, REGISTRIES } from "./allowlist.ts";
import {
  connectTarget,
  type EgressProxy,
  isPrivateAddress,
  type ResolvedAddress,
  startEgressProxy,
} from "./proxy.ts";

/** A stand-in registry: echoes what it is sent, and counts who connected. */
async function echoServer(): Promise<{
  server: Server;
  port: number;
  connections: number;
}> {
  const state = { server: createServer(), port: 0, connections: 0 };
  state.server.on("connection", (socket: Socket) => {
    state.connections += 1;
    socket.on("error", () => socket.destroy());
    socket.pipe(socket);
  });
  state.server.listen(0, "127.0.0.1");
  await once(state.server, "listening");
  const address = state.server.address();
  state.port = typeof address === "object" && address ? address.port : 0;
  return state;
}

/** Sends CONNECT, and answers with the status line and the socket, still open. */
async function tunnel(
  proxy: EgressProxy,
  target: string,
): Promise<{ status: number; body: string; socket: Socket }> {
  const socket = connect(proxy.port, "127.0.0.1");
  await once(socket, "connect");
  socket.write(`CONNECT ${target} HTTP/1.1\r\nhost: ${target}\r\n\r\n`);
  let received = "";
  while (!received.includes("\r\n\r\n")) {
    const [chunk] = (await once(socket, "data")) as [Buffer];
    received += chunk.toString("utf8");
  }
  const status = Number(received.split(" ")[1]);
  return { status, body: received.slice(received.indexOf("\r\n\r\n") + 4), socket };
}

const opened: { close(): unknown }[] = [];
afterEach(async () => {
  for (const thing of opened.splice(0)) await thing.close();
});

/** Every name resolves to this machine: the registry here is the echo server. */
const local = async (): Promise<ResolvedAddress[]> => [
  { address: "127.0.0.1", family: 4 },
];

describe("the egress proxy", () => {
  it("opens a tunnel to a host on the allowlist, and carries bytes both ways", async () => {
    const registry = await echoServer();
    opened.push(registry.server);
    const proxy = await startEgressProxy({
      allow: allowlist(),
      ports: [registry.port],
      allowPrivateAddresses: true,
      lookup: local,
    });
    opened.push(proxy);

    const { status, socket } = await tunnel(proxy, `registry.npmjs.org:${registry.port}`);
    expect(status).toBe(200);
    socket.write("hello, registry");
    const [echoed] = (await once(socket, "data")) as [Buffer];
    expect(echoed.toString()).toBe("hello, registry");
    socket.destroy();
    expect(proxy.decisions).toEqual([
      {
        host: "registry.npmjs.org",
        port: registry.port,
        allowed: true,
        address: "127.0.0.1",
      },
    ]);
  });

  it("refuses a host that is not on the allowlist, without resolving or reaching it", async () => {
    const registry = await echoServer();
    opened.push(registry.server);
    const looked: string[] = [];
    const proxy = await startEgressProxy({
      allow: allowlist(),
      ports: [registry.port],
      allowPrivateAddresses: true,
      lookup: async (host) => {
        looked.push(host);
        return local();
      },
    });
    opened.push(proxy);

    for (const host of [
      "example.com",
      "evil.registry.npmjs.org",
      "registry.npmjs.org.example.com",
      "pypi.org.",
    ]) {
      const { status, body, socket } = await tunnel(proxy, `${host}:${registry.port}`);
      socket.destroy();
      if (host === "pypi.org.") {
        // The same host, written with DNS's trailing dot.
        expect(status, host).toBe(200);
        continue;
      }
      expect(status, host).toBe(403);
      expect(body).toMatch(/not on the allowlist/);
    }
    expect(looked).toEqual(["pypi.org"]);
    expect(registry.connections).toBe(1);
  });

  it("refuses an address written as the host, and a port that is not HTTPS's", async () => {
    const proxy = await startEgressProxy({ allow: allowlist(), lookup: local });
    opened.push(proxy);
    for (const target of [
      "127.0.0.1:443",
      "[::1]:443",
      "2130706433:443",
      "169.254.169.254:443",
    ]) {
      const { status, socket } = await tunnel(proxy, target);
      socket.destroy();
      expect(status, target).toBeGreaterThanOrEqual(400);
    }
    const { status, body, socket } = await tunnel(proxy, "registry.npmjs.org:22");
    socket.destroy();
    expect(status).toBe(403);
    expect(body).toMatch(/port 22 is not allowed/);
  });

  it("refuses an allowed name that resolves to a private or link-local address", async () => {
    for (const address of [
      "10.0.0.5",
      "169.254.169.254",
      "127.0.0.1",
      "::1",
      "fd00::1",
    ]) {
      const proxy = await startEgressProxy({
        allow: allowlist(),
        lookup: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
      });
      opened.push(proxy);
      const { status, body, socket } = await tunnel(proxy, "proxy.golang.org:443");
      socket.destroy();
      expect(status, address).toBe(403);
      expect(body).toMatch(/not public/);
    }
  });

  it("refuses a plain HTTP request instead of forwarding it", async () => {
    const proxy = await startEgressProxy({ allow: allowlist(), lookup: local });
    opened.push(proxy);
    const status = await new Promise<number>((resolve, reject) => {
      const sent = httpRequest(
        {
          host: "127.0.0.1",
          port: proxy.port,
          path: "http://registry.npmjs.org/left-pad",
          headers: { host: "registry.npmjs.org" },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      sent.on("error", reject);
      sent.end();
    });
    expect(status).toBe(405);
  });

  it("answers 502 when an allowed registry cannot be reached", async () => {
    const closed = await echoServer();
    const port = closed.port;
    await new Promise((resolve) => closed.server.close(resolve));
    const proxy = await startEgressProxy({
      allow: allowlist(),
      ports: [port],
      allowPrivateAddresses: true,
      lookup: local,
    });
    opened.push(proxy);
    const { status, socket } = await tunnel(proxy, `sum.golang.org:${port}`);
    socket.destroy();
    expect(status).toBe(502);
  });
});

describe("the allowlist", () => {
  it("is the registries the language packs download from, and the extras asked for", () => {
    expect([...allowlist(["npm.example.com"])]).toEqual([
      ...REGISTRIES,
      "npm.example.com",
    ]);
    expect(() => allowlist(["10.0.0.1"])).toThrow(/not a host name/);
    expect(() => allowlist(["*.example.com"])).toThrow(/not a host name/);
  });

  it("tells host names from addresses", () => {
    expect(isHostName("files.pythonhosted.org")).toBe(true);
    expect(isHostName("127.1")).toBe(false);
    expect(isHostName("0x7f.1")).toBe(false);
    expect(isHostName("0x7f000001")).toBe(false);
    expect(isHostName("0x7f.example")).toBe(true);
    expect(isHostName("a..b")).toBe(false);
    expect(isHostName("")).toBe(false);
  });

  it("reads a CONNECT target", () => {
    expect(connectTarget("PyPI.org:443")).toEqual({ host: "pypi.org", port: 443 });
    expect(connectTarget("pypi.org")).toBeUndefined();
    expect(connectTarget("pypi.org:0")).toBeUndefined();
    expect(connectTarget("pypi.org:99999")).toBeUndefined();
  });

  it("knows which addresses are not public", () => {
    for (const address of [
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "127.0.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fe80::1",
      "fd12::1",
      "::ffff:10.0.0.1",
      "64:ff9b::a9fe:a9fe",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["104.16.1.35", "151.101.0.223", "2606:4700::6810:123"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});
