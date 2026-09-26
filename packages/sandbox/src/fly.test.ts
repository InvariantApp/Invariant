/**
 * The fly-machine driver against a fake Machines API: a local HTTP server
 * that answers the endpoints the driver calls, the way Fly documents them,
 * and remembers every request. The real API is never called.
 */
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { exitOf, flySandbox, guestMemory, machineRequest } from "./fly.ts";
import { DEFAULT_LIMITS, SandboxError } from "./sandbox.ts";

interface Seen {
  method: string;
  path: string;
  authorization: string | undefined;
  body?: Record<string, unknown>;
}

/** How the fake machine behaves once created. */
interface Script {
  /** Waits that answer 408 before the one that answers 200. */
  slow?: number;
  /** Never stops: every wait answers 408 and the machine stays started. */
  hangs?: boolean;
  exit?: { exit_code: number; oom_killed?: boolean };
  refuse?: number;
}

async function fakeFly(script: Script) {
  const seen: Seen[] = [];
  let waits = 0;
  let destroyed = false;
  const server: Server = createServer(async (request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url ?? "/", "http://fly");
    seen.push({
      method: request.method ?? "",
      path: `${url.pathname}${url.search}`,
      authorization: request.headers.authorization,
      ...(text ? { body: JSON.parse(text) as Record<string, unknown> } : {}),
    });
    const send = (status: number, body?: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body === undefined ? "" : JSON.stringify(body));
    };
    if (request.method === "POST" && url.pathname.endsWith("/machines")) {
      if (script.refuse) return send(script.refuse, { error: "insufficient capacity" });
      return send(200, { id: "m1", instance_id: "i1", state: "created" });
    }
    if (url.pathname.endsWith("/wait")) {
      waits += 1;
      if (script.hangs || waits <= (script.slow ?? 0)) {
        // The real API holds a wait for its timeout; a little of that here.
        await new Promise((resolve) => setTimeout(resolve, 50));
        return send(408, { error: "deadline" });
      }
      return send(200, { ok: true });
    }
    if (request.method === "GET" && url.pathname.endsWith("/machines/m1")) {
      if (script.hangs) return send(200, { id: "m1", state: "started", events: [] });
      return send(200, {
        id: "m1",
        state: destroyed ? "destroyed" : "stopped",
        events: [
          { type: "start", status: "started", timestamp: 1 },
          {
            type: "exit",
            status: "stopped",
            timestamp: 2,
            request: { exit_event: script.exit },
          },
        ],
      });
    }
    if (request.method === "POST" && url.pathname.endsWith("/stop")) return send(200, {});
    if (request.method === "DELETE") {
      destroyed = true;
      return send(200, { ok: true });
    }
    send(404, { error: "not found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, seen, url: `http://127.0.0.1:${port}` };
}

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
  }
});

async function sandboxFor(script: Script) {
  const fly = await fakeFly(script);
  servers.push(fly.server);
  const sandbox = flySandbox({
    apps: { fetch: "invariant-fetch", analyse: "invariant-analyse" },
    token: "fm2_test",
    image: "registry.fly.io/invariant-worker@sha256:abc",
    proxy: { url: "http://invariant-egress.flycast:3128" },
    region: "iad",
    apiUrl: fly.url,
  });
  return { sandbox, seen: fly.seen };
}

const request = {
  workspace: { volume: "vol_123" },
  command: ["invariant", "migrate", "--phase", "analyse", "/work/request/job.json"],
};

describe("the machine a phase runs on", () => {
  it("is one-shot, never restarted, sized to the phase, and runs only the phase", () => {
    const body = machineRequest({
      phase: "analyse",
      id: "run1",
      image: "worker:1",
      command: ["invariant", "migrate"],
      env: { HOME: "/tmp" },
      memoryMb: 3000,
      cpus: 2,
      cpuSeconds: 600,
      volume: "vol_123",
      region: "iad",
    }) as { name: string; region: string; config: Record<string, unknown> };
    expect(body.name).toBe("invariant-analyse-run1");
    expect(body.region).toBe("iad");
    expect(body.config).toEqual({
      image: "worker:1",
      guest: { cpu_kind: "shared", cpus: 2, memory_mb: 3072 },
      auto_destroy: true,
      restart: { policy: "no" },
      init: {
        exec: [
          "/bin/sh",
          "-c",
          'ulimit -t "$0" && exec "$@"',
          "600",
          "invariant",
          "migrate",
        ],
      },
      env: { HOME: "/tmp" },
      mounts: [{ volume: "vol_123", path: "/work" }],
      dns: { skip_registration: true },
      metadata: { invariant_sandbox_run: "run1", invariant_sandbox_phase: "analyse" },
    });
    expect([guestMemory(1), guestMemory(256), guestMemory(257)]).toEqual([256, 256, 512]);
  });

  it("reads how a machine exited from its latest exit event", () => {
    expect(
      exitOf([
        { type: "exit", timestamp: 1, request: { exit_event: { exit_code: 1 } } },
        {
          type: "exit",
          timestamp: 5,
          request: { exit_event: { exit_code: 137, oom_killed: true } },
        },
        { type: "start", timestamp: 9 },
      ]),
    ).toEqual({ exitCode: 137, oomKilled: true });
    expect(exitOf([{ type: "start" }])).toBeUndefined();
  });
});

describe("the fly-machine driver, against a fake Machines API", () => {
  it("creates the analysis in its own app, waits for it to stop, and destroys it", async () => {
    const { sandbox, seen } = await sandboxFor({ slow: 2, exit: { exit_code: 0 } });
    const result = await sandbox.analyse(request);
    expect(result).toMatchObject({ phase: "analyse", driver: "fly-machine" });
    expect(seen.map((call) => `${call.method} ${call.path.split("?")[0]}`)).toEqual([
      "POST /v1/apps/invariant-analyse/machines",
      "GET /v1/apps/invariant-analyse/machines/m1/wait",
      "GET /v1/apps/invariant-analyse/machines/m1/wait",
      "GET /v1/apps/invariant-analyse/machines/m1/wait",
      "GET /v1/apps/invariant-analyse/machines/m1",
      "DELETE /v1/apps/invariant-analyse/machines/m1",
    ]);
    expect(seen.every((call) => call.authorization === "Bearer fm2_test")).toBe(true);
    expect(seen[1]?.path).toMatch(/state=stopped&timeout=\d+&instance_id=i1/);
    expect(seen.at(-1)?.path).toMatch(/\?force=true$/);
    const config = seen[0]?.body?.["config"] as { env: Record<string, string> };
    expect(config.env["GOPROXY"]).toBe("off");
    expect(Object.keys(config.env).filter((key) => /^https?_proxy$/i.test(key))).toEqual(
      [],
    );
  });

  it("sends the fetch through the egress proxy, in the fetch app", async () => {
    const { sandbox, seen } = await sandboxFor({ exit: { exit_code: 0 } });
    await sandbox.fetch({ ...request, limits: { memoryMb: 512 } });
    expect(seen[0]?.path).toBe("/v1/apps/invariant-fetch/machines");
    const config = seen[0]?.body?.["config"] as {
      env: Record<string, string>;
      guest: { memory_mb: number };
    };
    expect(config.env["HTTPS_PROXY"]).toBe("http://invariant-egress.flycast:3128");
    expect(config.env["npm_config_ignore_scripts"]).toBe("true");
    expect(config.guest.memory_mb).toBe(512);
  });

  it.each([
    [{ exit_code: 137, oom_killed: true }, "memory"],
    [{ exit_code: 152 }, "cpu"],
    [{ exit_code: 1 }, "exit"],
  ])("reads an exit of %o as %s", async (exit, kind) => {
    const { sandbox } = await sandboxFor({ exit });
    const error = await sandbox.analyse(request).catch((caught: unknown) => caught);
    expect((error as SandboxError).kind).toBe(kind);
  });

  it("kills and destroys a machine still running at the wall clock", async () => {
    const { sandbox, seen } = await sandboxFor({ hangs: true });
    const error = await sandbox
      .analyse({ ...request, limits: { ...DEFAULT_LIMITS.analyse, wallSeconds: 1 } })
      .catch((caught: unknown) => caught);
    expect((error as SandboxError).kind).toBe("timeout");
    const calls = seen.map((call) => `${call.method} ${call.path.split("?")[0]}`);
    expect(calls).toContain("POST /v1/apps/invariant-analyse/machines/m1/stop");
    expect(calls.at(-1)).toBe("DELETE /v1/apps/invariant-analyse/machines/m1");
    expect(seen.find((call) => call.path.endsWith("/stop"))?.body).toEqual({
      signal: "SIGKILL",
    });
  });

  it("says so when Fly refuses the machine", async () => {
    const { sandbox } = await sandboxFor({ refuse: 422 });
    const error = await sandbox.analyse(request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SandboxError);
    expect((error as SandboxError).kind).toBe("driver");
    expect((error as SandboxError).message).toMatch(/422.*insufficient capacity/);
  });
});
