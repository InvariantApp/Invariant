/**
 * The provider behind the proxy in the soak: the fixture provider's current
 * contract, answered from memory, misbehaving when a request asks it to.
 *
 * It also checks every body the proxy sends it against the current contract,
 * with the same independent validator the caller judges responses with, so a
 * request the adapter rewrote wrongly is caught where it lands.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Oracle } from "../traffic/oracle.mts";
import { CHAOS_HEADER, type Mode } from "./plan.ts";

export interface UpstreamStats {
  requests: number;
  /** Bodies the proxy sent that the current contract refuses. */
  requestViolations: number;
  samples: string[];
  /** Connections open now, and the most open at once. */
  open: () => number;
  maxOpen: number;
  /** Requests being stalled now. */
  stalled: () => number;
}

export interface Upstream {
  url: string;
  stats: UpstreamStats;
  close: () => Promise<void>;
}

const STALL_LIMIT_MS = 60_000;
const SAMPLE_LIMIT = 50;

function payment(id: string, seed: number, description: string | null): object {
  return {
    id,
    object: "payment",
    amount_cents: 100 + (seed % 99_900),
    currency: (["usd", "eur", "gbp"] as const)[seed % 3],
    payment_method: { token: "tok_visa" },
    capture_method: seed % 7 === 0 ? "manual" : "automatic",
    status: (["paid", "failed", "processing"] as const)[seed % 3],
    description,
    created: 1_760_000_000 + seed,
  };
}

const error = (type: string, message: string) => ({ error: { type, message } });

export async function startUpstream(options: {
  /** The current contract, for the bodies the proxy sends. */
  oracle: Oracle;
  /** Bytes the proxy will buffer; an oversized answer is larger. */
  maxBodyBytes: number;
}): Promise<Upstream> {
  const sockets = new Set<Socket>();
  const stalls = new Set<ServerResponse>();
  const stats: UpstreamStats = {
    requests: 0,
    requestViolations: 0,
    samples: [],
    open: () => sockets.size,
    maxOpen: 0,
    stalled: () => stalls.size,
  };
  const padding = "x".repeat(options.maxBodyBytes + 1024);

  const answer = (
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    body: unknown,
    mode: Mode,
  ) => {
    const text = JSON.stringify(body);
    const bytes = Buffer.from(text);
    const headers = {
      "content-type": "application/json",
      "content-length": String(bytes.length),
    };
    if (mode === "cut") {
      response.writeHead(status, headers);
      response.write(bytes.subarray(0, Math.floor(bytes.length / 2)), () =>
        request.socket.destroy(),
      );
      return;
    }
    if (mode === "slow") {
      response.writeHead(status, headers);
      const pieces = 8;
      const size = Math.ceil(bytes.length / pieces);
      let sent = 0;
      const next = () => {
        if (response.destroyed) return;
        const piece = bytes.subarray(sent, sent + size);
        sent += piece.length;
        if (sent >= bytes.length) {
          response.end(piece);
          return;
        }
        response.write(piece);
        setTimeout(next, 90);
      };
      next();
      return;
    }
    const send = () => {
      if (response.destroyed) return;
      response.writeHead(status, headers);
      response.end(bytes);
    };
    if (mode === "late") setTimeout(send, 700);
    else send();
  };

  const handle = (request: IncomingMessage, response: ServerResponse, raw: Buffer) => {
    stats.requests += 1;
    const mode = (request.headers[CHAOS_HEADER] as Mode | undefined) ?? "normal";
    if (mode === "reset") {
      request.socket.destroy();
      return;
    }
    if (mode === "stall") {
      stalls.add(response);
      const limit = setTimeout(() => request.socket.destroy(), STALL_LIMIT_MS);
      response.on("close", () => {
        clearTimeout(limit);
        stalls.delete(response);
      });
      return;
    }
    const url = new URL(request.url ?? "/", "http://upstream");
    const method = request.method ?? "GET";
    const big = mode === "oversized" ? padding : null;

    if (method === "POST") {
      let body: unknown;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        body = undefined;
      }
      const template = url.pathname === "/v1/refunds" ? "/v1/refunds" : "/v1/payments";
      const found =
        body === undefined
          ? [{ pointer: "", message: "the body is not JSON" }]
          : (options.oracle.request({ method: "post", path: template }, body) ?? []);
      if (found.length > 0) {
        stats.requestViolations += 1;
        if (stats.samples.length < SAMPLE_LIMIT) {
          stats.samples.push(
            `${method} ${url.pathname}: ${found.map((v) => `${v.pointer} ${v.message}`).join("; ")}`,
          );
        }
        answer(
          request,
          response,
          400,
          error(
            "invalid_request_error",
            "The body is not what the current contract takes.",
          ),
          mode,
        );
        return;
      }
      const sent = body as Record<string, unknown>;
      if (template === "/v1/refunds") {
        answer(
          request,
          response,
          201,
          {
            id: `re_${stats.requests}`,
            object: "refund",
            payment: String(sent["payment"]),
            amount_cents:
              typeof sent["amount_cents"] === "number" ? sent["amount_cents"] : 4999,
            status: "succeeded",
            created: 1_760_000_000 + stats.requests,
          },
          mode,
        );
        return;
      }
      answer(
        request,
        response,
        201,
        {
          ...payment(`pay_${stats.requests}`, stats.requests, big ?? null),
          amount_cents: sent["amount_cents"],
          currency: sent["currency"],
          capture_method: sent["capture_method"],
          description: big ?? sent["description"] ?? null,
        },
        mode,
      );
      return;
    }

    if (url.pathname === "/v1/payments") {
      const limit = Math.min(
        100,
        Math.max(1, Number(url.searchParams.get("limit") ?? 10)),
      );
      answer(
        request,
        response,
        200,
        {
          object: "list",
          data: Array.from({ length: limit }, (_, index) =>
            payment(`pay_${index}`, index, index === 0 && big ? big : `Order ${index}`),
          ),
          has_more: false,
        },
        mode,
      );
      return;
    }
    const match = /^\/v1\/payments\/([^/]+)$/.exec(url.pathname);
    if (match && !(match[1] as string).startsWith("pay_missing")) {
      const seed = Number((match[1] as string).replace(/\D/g, "")) || 0;
      answer(request, response, 200, payment(match[1] as string, seed, big), mode);
      return;
    }
    answer(request, response, 404, error("not_found_error", "No such payment."), mode);
  };

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => handle(request, response, Buffer.concat(chunks)));
    request.on("error", () => request.socket.destroy());
  });
  // Shorter than the proxy keeps an idle connection, as most servers are, so
  // the proxy meets connections the upstream has closed under it.
  server.keepAliveTimeout = 5_000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    stats.maxOpen = Math.max(stats.maxOpen, sockets.size);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stats,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
