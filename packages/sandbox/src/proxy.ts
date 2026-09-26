/**
 * The egress proxy: the fetch phase's only way out.
 *
 * Platform network policies speak addresses, and a registry is a name whose
 * addresses are a CDN's and change by the hour, so no policy can say "npm and
 * nothing else". This proxy can. The fetch phase's network routes nowhere but
 * here, every client in it is told to tunnel through here (`HTTPS_PROXY`),
 * and here a tunnel opens only to a host on the allowlist, on an allowed port.
 *
 * It speaks HTTP CONNECT and nothing else. Every registry is HTTPS, so the
 * proxy never sees a request, only a host name and a port, and it never
 * needs a certificate of its own. A plain HTTP request is refused rather than
 * forwarded, so nothing leaves unencrypted either.
 *
 * The host name is resolved here, once, and the tunnel is opened to the
 * address that was checked. An allowed name that resolves to a private,
 * loopback or link-local address is refused: a registry never lives there,
 * and a cloud's metadata service always does. Connecting to the address
 * that was checked, rather than handing the name to `connect` to resolve
 * again, leaves no second lookup for a rebinding DNS server to answer
 * differently.
 *
 * Only Node's own modules are imported, so the drivers can run this file in
 * any image that has Node, straight from where it is installed.
 */
import { lookup as resolveAll } from "node:dns/promises";
import { createServer, type IncomingMessage } from "node:http";
import { BlockList, connect, isIP, type Socket } from "node:net";
import { allowed, normalizeHost } from "./allowlist.ts";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface EgressProxyOptions {
  /** Host names a tunnel may open to, as `allowlist()` gives them. */
  allow: Iterable<string>;
  /** The interface to listen on; loopback by default. */
  host?: string;
  /** The port to listen on; any free one by default. */
  port?: number;
  /** Ports a tunnel may open to; only HTTPS's by default. */
  ports?: readonly number[];
  /**
   * Allow tunnels to private, loopback and link-local addresses. Only for
   * tests, where the "registry" is a server on this machine.
   */
  allowPrivateAddresses?: boolean;
  /** How host names are resolved; the system resolver by default. */
  lookup?: (host: string) => Promise<ResolvedAddress[]>;
  /** How long opening a tunnel may take. */
  connectTimeoutMs?: number;
  /** How long a tunnel may sit with nothing sent either way. */
  idleTimeoutMs?: number;
  /** Tunnels open at once. */
  maxConnections?: number;
  /** Told of every decision, allowed or refused. */
  log?: (decision: EgressDecision) => void;
}

export interface EgressDecision {
  host: string;
  port: number;
  allowed: boolean;
  /** Why a tunnel was refused. */
  reason?: string;
  /** The address a tunnel was opened to. */
  address?: string;
}

export interface EgressProxy {
  /** `http://host:port`, for `HTTPS_PROXY`. */
  url: string;
  port: number;
  /** Every decision so far, in order. */
  decisions: EgressDecision[];
  close(): Promise<void>;
}

const NOT_PUBLIC = (() => {
  const list = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const) {
    list.addSubnet(network, prefix, "ipv4");
  }
  for (const [network, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001:db8::", 32],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
  ] as const) {
    list.addSubnet(network, prefix, "ipv6");
  }
  return list;
})();

/**
 * Whether an address is anywhere but the public internet: private ranges,
 * loopback, link-local (where cloud metadata services answer), shared
 * carrier space, documentation, multicast and reserved ranges. An IPv6
 * address carrying an IPv4 one, mapped or through NAT64, is judged by the
 * IPv4 address inside it.
 */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 4) return NOT_PUBLIC.check(address, "ipv4");
  const embedded = embeddedIpv4(address);
  if (embedded) return NOT_PUBLIC.check(embedded, "ipv4");
  return NOT_PUBLIC.check(address, "ipv6");
}

/** The IPv4 address inside a mapped (`::ffff:`) or NAT64 (`64:ff9b::`) one, either spelling. */
function embeddedIpv4(address: string): string | undefined {
  const tail = /^(?:::ffff:|64:ff9b::)(.+)$/i.exec(address)?.[1];
  if (!tail) return undefined;
  if (isIP(tail) === 4) return tail;
  const groups = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail);
  if (!groups) return undefined;
  const high = Number.parseInt(groups[1] as string, 16);
  const low = Number.parseInt(groups[2] as string, 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

/** `host:port` from a CONNECT request's target, or nothing if it is not one. */
export function connectTarget(
  target: string,
): { host: string; port: number } | undefined {
  const colon = target.lastIndexOf(":");
  if (colon <= 0) return undefined;
  const host = target.slice(0, colon);
  const port = target.slice(colon + 1);
  if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    return undefined;
  }
  return { host: normalizeHost(host), port: Number(port) };
}

async function systemLookup(host: string): Promise<ResolvedAddress[]> {
  const found = await resolveAll(host, { all: true, verbatim: true });
  return found.map((entry) => ({
    address: entry.address,
    family: entry.family === 6 ? 6 : 4,
  }));
}

function refuse(socket: Socket, status: number, text: string, reason: string): void {
  const body = `${reason}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${text}\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
  );
}

export async function startEgressProxy(
  options: EgressProxyOptions,
): Promise<EgressProxy> {
  const hosts = new Set([...options.allow].map(normalizeHost));
  const ports = new Set(options.ports ?? [443]);
  const lookup = options.lookup ?? systemLookup;
  const connectTimeout = options.connectTimeoutMs ?? 10_000;
  const idleTimeout = options.idleTimeoutMs ?? 120_000;
  const decisions: EgressDecision[] = [];
  const open = new Set<Socket>();

  const decide = (decision: EgressDecision) => {
    decisions.push(decision);
    options.log?.(decision);
  };

  const server = createServer((request, response) => {
    // Only tunnels. A request in the clear would be a request this proxy
    // forwards, and every registry is HTTPS anyway.
    request.resume();
    response.writeHead(405, { allow: "CONNECT", "content-type": "text/plain" });
    response.end("only CONNECT tunnels to the allowed registries\n");
  });
  server.maxConnections = options.maxConnections ?? 64;

  server.on("connect", (request: IncomingMessage, client: Socket, head: Buffer) => {
    open.add(client);
    client.on("close", () => open.delete(client));
    client.on("error", () => client.destroy());
    const target = connectTarget(request.url ?? "");
    if (!target) {
      refuse(client, 400, "Bad Request", "the target is not host:port");
      return;
    }
    const { host, port } = target;
    const refused = (reason: string) => {
      decide({ host, port, allowed: false, reason });
      refuse(client, 403, "Forbidden", reason);
    };
    if (!allowed(host, hosts)) {
      refused(`${host} is not on the allowlist`);
      return;
    }
    if (!ports.has(port)) {
      refused(`port ${port} is not allowed`);
      return;
    }
    void (async () => {
      let addresses: ResolvedAddress[];
      try {
        addresses = await lookup(host);
      } catch {
        decide({ host, port, allowed: false, reason: `${host} does not resolve` });
        refuse(client, 502, "Bad Gateway", `${host} does not resolve`);
        return;
      }
      const address = addresses[0]?.address;
      if (!address) {
        decide({ host, port, allowed: false, reason: `${host} does not resolve` });
        refuse(client, 502, "Bad Gateway", `${host} does not resolve`);
        return;
      }
      // Every address, not just the one used: a name that answers with a
      // private address at all is not a registry's.
      if (
        !options.allowPrivateAddresses &&
        addresses.some((entry) => isPrivateAddress(entry.address))
      ) {
        refused(`${host} resolves to an address that is not public`);
        return;
      }
      if (client.destroyed) return;
      const upstream = connect({ host: address, port });
      open.add(upstream);
      upstream.on("close", () => open.delete(upstream));
      upstream.setTimeout(connectTimeout);
      upstream.once("timeout", () => upstream.destroy(new Error("connect timeout")));
      // Replaced once the tunnel is open; until then, a failure is the
      // registry not answering, which the client is told.
      upstream.once("error", () => {
        decide({ host, port, allowed: false, reason: `could not reach ${host}` });
        if (!client.destroyed)
          refuse(client, 502, "Bad Gateway", `could not reach ${host}`);
      });
      upstream.once("connect", () => {
        decide({ host, port, allowed: true, address });
        upstream.setTimeout(idleTimeout);
        client.setTimeout(idleTimeout);
        client.once("timeout", () => client.destroy());
        upstream.removeAllListeners("timeout");
        upstream.once("timeout", () => upstream.destroy());
        upstream.removeAllListeners("error");
        upstream.on("error", () => client.destroy());
        client.on("error", () => upstream.destroy());
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
        client.on("close", () => upstream.destroy());
        upstream.on("close", () => client.destroy());
      });
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const shownHost =
    options.host && options.host !== "0.0.0.0" ? options.host : "127.0.0.1";
  return {
    url: `http://${shownHost}:${port}`,
    port,
    decisions,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
