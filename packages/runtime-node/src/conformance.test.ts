/**
 * One suite, every Node framework (launch gate L10).
 *
 * Each framework is given the same routes and the same program, served on a
 * real socket, and asked the same questions: a current caller is untouched,
 * an old caller's request and response are adapted, a caller naming a
 * contract that does not exist is refused before any handler runs, a body
 * the program does not describe streams through, caches and conditional
 * requests see one answer per contract, and an answer that cannot be
 * expressed becomes the provider's error, never the untranslated body.
 */
import { createHmac } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { createRuntime, type InvariantRuntime } from "@invariant/runtime";
import express from "express";
import express4 from "express4";
import Fastify from "fastify";
import Fastify4 from "fastify4";
import Koa from "koa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adaptListener, adaptMiddleware, type Listener } from "./index.ts";

const OLD = "2026-01-01";
const CURRENT = "2026-09-20";
const HEADER = "payments-version";

const PROGRAM = {
  irVersion: 2,
  api: "payments",
  currentLabel: CURRENT,
  current: "sha256:head",
  identity: [
    { kind: "header", name: HEADER },
    { kind: "default", label: CURRENT },
  ],
  contracts: {
    [OLD]: {
      label: OLD,
      routes: [],
      sites: {
        "post /v1/payments": {
          request: [{ k: "move", from: "/amount", to: "/amount_cents", c: "chg_cents" }],
          response: {
            "2xx": [
              {
                k: "enum",
                path: "/status",
                map: { succeeded: "paid", pending: "pending" },
                c: "chg_status",
              },
              { k: "move", from: "/amount_cents", to: "/amount", c: "chg_cents" },
            ],
          },
        },
        "get /v1/payments/{id}": {
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

/** What every framework's routes do, written once. */
const HANDLERS = {
  /** Answers with what it was sent, so the test can see what the handler saw. */
  create: (body: Record<string, unknown>) => ({
    status: 201,
    body: {
      seen: body,
      amount_cents: body["amount_cents"] ?? body["amount"],
      status: body["status"] ?? "succeeded",
    },
  }),
  read: (ifNoneMatch: string | undefined) =>
    ifNoneMatch === '"v7"'
      ? { status: 304, etag: '"v7"' }
      : { status: 200, etag: '"v7"', body: { id: "p_1", amount_cents: 1999 } },
  csv: () => "id,amount\np_1,1999\n",
};

type Build = (runtime: InvariantRuntime) => Promise<Server>;

/** Fastify runs the listener its serverFactory is given, so the adapter wraps that. */
async function fastifyWith(
  make: typeof Fastify,
  runtime: InvariantRuntime,
): Promise<Server> {
  let server: Server | undefined;
  const app = make({
    serverFactory: (handler) => {
      server = createServer(adaptListener(handler as Listener, { runtime }));
      return server;
    },
  });
  app.post("/v1/payments", async (request, reply) => {
    const out = HANDLERS.create(request.body as Record<string, unknown>);
    return reply.code(out.status).send(out.body);
  });
  app.get("/v1/payments/:id", async (request, reply) => {
    const out = HANDLERS.read(request.headers["if-none-match"] as string | undefined);
    reply.header("etag", out.etag).code(out.status);
    return out.status === 304 ? reply.send() : reply.send(out.body);
  });
  app.get("/v1/export", async (_request, reply) =>
    reply.type("text/csv").send(HANDLERS.csv()),
  );
  await app.ready();
  return listen(server as Server);
}

const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
};

const FRAMEWORKS: Record<string, Build> = {
  "node:http": async (runtime) => {
    const app: Listener = (request, response) => {
      const url = new URL(request.url ?? "/", "http://x");
      if (url.pathname === "/v1/payments" && request.method === "POST") {
        let text = "";
        request.on("data", (chunk) => (text += chunk));
        request.on("end", () => {
          const out = HANDLERS.create(JSON.parse(text));
          response.writeHead(out.status, { "content-type": "application/json" });
          response.end(JSON.stringify(out.body));
        });
        return;
      }
      if (url.pathname === "/v1/payments/p_1") {
        const out = HANDLERS.read(request.headers["if-none-match"]);
        if (out.status === 304) {
          response.writeHead(304, { etag: out.etag });
          response.end();
          return;
        }
        const text = JSON.stringify(out.body);
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(text),
          etag: out.etag,
        });
        response.end(request.method === "HEAD" ? undefined : text);
        return;
      }
      if (url.pathname === "/v1/export") {
        response.writeHead(200, { "content-type": "text/csv" });
        response.write("id,amount\n");
        response.end("p_1,1999\n");
        return;
      }
      response.writeHead(404).end();
    };
    return listen(createServer(adaptListener(app, { runtime })));
  },
  "express 5": async (runtime) => {
    const app = express();
    app.use(express.json());
    app.post("/v1/payments", (request, response) => {
      const out = HANDLERS.create(request.body);
      response.status(out.status).json(out.body);
    });
    app.get("/v1/payments/:id", (request, response) => {
      const out = HANDLERS.read(request.header("if-none-match"));
      if (out.status === 304)
        return void response.status(304).set("etag", out.etag).end();
      response.set("etag", out.etag).json(out.body);
    });
    app.get("/v1/export", (_request, response) => {
      response.type("text/csv").send(HANDLERS.csv());
    });
    app.set("etag", false);
    return listen(createServer(adaptListener(app as unknown as Listener, { runtime })));
  },
  "express 4": async (runtime) => {
    const app = express4();
    app.use(express4.json());
    app.set("etag", false);
    app.post("/v1/payments", (request, response) => {
      const out = HANDLERS.create(request.body);
      response.status(out.status).json(out.body);
    });
    app.get("/v1/payments/:id", (request, response) => {
      const out = HANDLERS.read(request.header("if-none-match"));
      if (out.status === 304)
        return void response.status(304).set("etag", out.etag).end();
      response.set("etag", out.etag).json(out.body);
    });
    app.get("/v1/export", (_request, response) => {
      response.type("text/csv").send(HANDLERS.csv());
    });
    return listen(createServer(adaptListener(app as unknown as Listener, { runtime })));
  },
  koa: async (runtime) => {
    const app = new Koa();
    app.use(async (ctx) => {
      if (ctx.path === "/v1/payments" && ctx.method === "POST") {
        let text = "";
        for await (const chunk of ctx.req) text += chunk;
        const out = HANDLERS.create(JSON.parse(text));
        ctx.status = out.status;
        ctx.body = out.body;
        return;
      }
      if (ctx.path === "/v1/payments/p_1") {
        const out = HANDLERS.read(ctx.get("if-none-match") || undefined);
        ctx.set("etag", out.etag);
        ctx.status = out.status;
        if (out.status === 200) ctx.body = out.body;
        return;
      }
      if (ctx.path === "/v1/export") {
        ctx.type = "text/csv";
        ctx.body = HANDLERS.csv();
      }
    });
    return listen(createServer(adaptListener(app.callback(), { runtime })));
  },
  "fastify 5": (runtime) => fastifyWith(Fastify, runtime),
  "fastify 4": (runtime) => fastifyWith(Fastify4 as unknown as typeof Fastify, runtime),
};

for (const [name, build] of Object.entries(FRAMEWORKS)) {
  describe(`the runtime in ${name}`, () => {
    let server: Server;
    let base: string;
    beforeAll(async () => {
      server = await build(createRuntime({ program: PROGRAM }));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const pay = (body: unknown, version?: string) =>
      fetch(`${base}/v1/payments`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(version ? { [HEADER]: version } : {}),
        },
        body: JSON.stringify(body),
      });

    it("leaves a current caller as it was, but for Vary", async () => {
      const response = await pay({ amount_cents: 1999 });
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({
        seen: { amount_cents: 1999 },
        amount_cents: 1999,
        status: "succeeded",
      });
      expect(response.headers.get("invariant-contract")).toBeNull();
      expect(response.headers.get("vary")?.toLowerCase()).toContain(HEADER);
    });

    it("adapts an old caller's request and response", async () => {
      const response = await pay({ amount: 1999 }, OLD);
      expect(response.status).toBe(201);
      const body = (await response.json()) as Record<string, unknown>;
      // The handler saw the current shape; the caller sees theirs.
      expect(body["seen"]).toEqual({ amount_cents: 1999 });
      expect(body["amount"]).toBe(1999);
      expect(body["status"]).toBe("paid");
      expect(response.headers.get("invariant-contract")).toBe(OLD);
      expect(Number(response.headers.get("content-length"))).toBe(
        Buffer.byteLength(JSON.stringify(body)),
      );
    });

    it("refuses a contract that does not exist before any handler runs", async () => {
      const response = await pay({ amount: 1 }, "1999-01-01");
      expect(response.status).toBe(400);
      expect(response.headers.get("invariant-error-id")).toMatch(/^err_/);
      expect(
        ((await response.json()) as { error: { message: string } }).error.message,
      ).toContain("1999-01-01");
    });

    it("answers with the provider's error when the answer cannot be expressed", async () => {
      const response = await pay({ amount: 5, status: "disputed" }, OLD);
      expect(response.status).toBe(502);
      expect(response.headers.get("invariant-error-id")).toMatch(/^err_/);
    });

    it("streams a body the program does not describe as it was written", async () => {
      const response = await fetch(`${base}/v1/export`, { headers: { [HEADER]: OLD } });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(HANDLERS.csv());
      expect(response.headers.get("vary")?.toLowerCase()).toContain(HEADER);
    });

    it("marks an adapted answer's tag, and revalidates it", async () => {
      const first = await fetch(`${base}/v1/payments/p_1`, {
        headers: { [HEADER]: OLD },
      });
      expect(await first.json()).toEqual({ id: "p_1", amount: 1999 });
      const tag = first.headers.get("etag");
      expect(tag).toBe(`"v7~${OLD}"`);
      const again = await fetch(`${base}/v1/payments/p_1`, {
        headers: { [HEADER]: OLD, "if-none-match": tag ?? "" },
      });
      expect(again.status).toBe(304);
      expect(again.headers.get("etag")).toBe(tag);
    });

    it("answers HEAD without the length of a body the caller is never sent", async () => {
      const head = await fetch(`${base}/v1/payments/p_1`, {
        method: "HEAD",
        headers: { [HEADER]: OLD },
      });
      expect(head.status).toBe(200);
      expect(head.headers.get("etag")).toBe(`"v7~${OLD}"`);
      expect(head.headers.get("content-length")).toBeNull();
    });
  });
}

describe("the middleware form, after a signature check", () => {
  // A provider that verifies an HMAC over the request body must see the
  // bytes the caller signed. Mounted after the check, the adapter never
  // changes what was verified, and the handler still gets the current shape.
  const SECRET = "whsec_test";
  const sign = (body: string) => createHmac("sha256", SECRET).update(body).digest("hex");
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const runtime = createRuntime({ program: PROGRAM });
    const app = express();
    app.use(
      express.json({
        verify: (request: IncomingMessage, _response: ServerResponse, raw: Buffer) => {
          if (request.headers["x-signature"] !== sign(raw.toString("utf8"))) {
            throw new Error("bad signature");
          }
        },
      }),
    );
    app.use(adaptMiddleware({ runtime }));
    app.post("/v1/payments", (request, response) => {
      response
        .status(201)
        .json({ seen: request.body, amount_cents: request.body.amount_cents });
    });
    server = await listen(createServer(app));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("verifies the caller's bytes, and hands the handler the current shape", async () => {
    const body = JSON.stringify({ amount: 1999 });
    const response = await fetch(`${base}/v1/payments`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [HEADER]: OLD,
        "x-signature": sign(body),
      },
      body,
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ seen: { amount_cents: 1999 }, amount: 1999 });
  });
});
