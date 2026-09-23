/**
 * What the threat-model tests share: the real processes an attacker would
 * talk to, started the way a provider starts them, and a way to see what
 * reached the far side.
 *
 * Each test sends what an adversary would actually send. Where a process
 * boundary is the thing under attack, the process is real: the proxy is its
 * own CLI on a local port, the release verifier is `invariant verify`, and
 * the upstream behind the proxy is a server that writes down every request
 * that reaches it, so "refused" is asserted as "nothing arrived", not as a
 * status code alone.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { type AddressInfo, connect, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** A directory of its own under the system's temporary directory. */
export async function workdir(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `invariant-threat-${name}-`));
}

export interface Arrival {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  rawHeaders: string[];
  body: string;
}

export interface Upstream {
  url: string;
  /** Every request that reached it, in order. */
  seen: Arrival[];
  close(): Promise<void>;
}

/**
 * A server that records what it is sent. By default it answers every request
 * with `{"ok":true}`; `answer` replaces that for tests that need a particular
 * reply.
 */
export async function recordingUpstream(
  answer?: (arrival: Arrival) => {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<Upstream> {
  const seen: Arrival[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const arrival: Arrival = {
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        rawHeaders: request.rawHeaders,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      seen.push(arrival);
      const reply = answer?.(arrival) ?? {};
      response.writeHead(reply.status ?? 200, {
        "content-type": "application/json",
        ...reply.headers,
      });
      response.end(reply.body ?? '{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * An upstream as most servers that are not Node's behave: it ignores
 * `Upgrade` on a route that is not a WebSocket, answers the request, and keeps
 * reading the connection for the next one. Bodies are not read; it records
 * each request line it is sent. With `switchProtocols`, it accepts an
 * upgrade instead and echoes whatever follows.
 */
export async function lenientUpstream(
  options: { switchProtocols?: boolean } = {},
): Promise<{
  url: string;
  lines: string[];
  close(): Promise<void>;
}> {
  const lines: string[] = [];
  const server = createTcpServer((socket) => {
    let buffer = "";
    let switched = false;
    socket.on("data", (data: Buffer) => {
      if (switched) {
        socket.write(`echo: ${data.toString("latin1")}`);
        return;
      }
      buffer += data.toString("latin1");
      for (;;) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end === -1) break;
        const head = buffer.slice(0, end);
        lines.push(head.split("\r\n")[0] as string);
        buffer = buffer.slice(end + 4);
        if (options.switchProtocols && /\r\nupgrade:/i.test(head)) {
          switched = true;
          socket.write(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
          );
          return;
        }
        socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    lines,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface Sidecar {
  url: string;
  port: number;
  /** What the process has written so far, both streams. */
  output(): string;
  stop(): Promise<void>;
}

/**
 * The proxy as a provider runs it: `invariant-sidecar <config.json>`, from the
 * package's own CLI, with the program and configuration written to disk.
 */
export async function startSidecar(
  program: unknown,
  config: Record<string, unknown>,
): Promise<Sidecar> {
  const dir = await workdir("sidecar");
  const programPath = join(dir, "program.json");
  const configPath = join(dir, "sidecar.json");
  await writeFile(programPath, JSON.stringify(program), "utf8");
  await writeFile(
    configPath,
    JSON.stringify({ program: programPath, listen: { port: 0 }, ...config }),
    "utf8",
  );
  const child = spawn(
    process.execPath,
    ["--import", "tsx", join(ROOT, "packages/sidecar/src/cli.ts"), configPath],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`the proxy did not start:\n${output}`)),
      30_000,
    );
    const look = () => {
      const found = /serving .* at (http:\/\/[\d.]+:\d+)/.exec(output);
      if (found) {
        clearTimeout(timer);
        resolve(found[1] as string);
      }
    };
    child.stdout?.on("data", look);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the proxy exited ${code}:\n${output}`));
    });
  });
  return {
    url,
    port: Number(new URL(url).port),
    output: () => output,
    stop: async () => {
      await stopChild(child);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Starts the proxy with a configuration it should refuse, and returns what it said. */
export async function refusedSidecar(
  program: unknown,
  config: Record<string, unknown>,
): Promise<{ code: number | null; output: string }> {
  const dir = await workdir("sidecar");
  try {
    const programPath = join(dir, "program.json");
    const configPath = join(dir, "sidecar.json");
    await writeFile(programPath, JSON.stringify(program), "utf8");
    await writeFile(
      configPath,
      JSON.stringify({ program: programPath, listen: { port: 0 }, ...config }),
      "utf8",
    );
    return await run(
      process.execPath,
      ["--import", "tsx", join(ROOT, "packages/sidecar/src/cli.ts"), configPath],
      { cwd: ROOT, timeoutMs: 30_000 },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** `invariant <args>`, the CLI a provider installs, run from source. */
export function invariant(
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ code: number | null; output: string }> {
  return run(
    process.execPath,
    ["--import", "tsx", join(ROOT, "packages/cli/src/main.ts"), ...args],
    {
      cwd: options.cwd ?? ROOT,
      env: options.env,
      timeoutMs: options.timeoutMs ?? 60_000,
    },
  );
}

function run(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv | undefined; timeoutMs: number },
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${args.join(" ")} did not finish:\n${output}`));
    }, options.timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5000).unref();
  });
}

/**
 * Bytes written straight onto a socket, and whatever came back before the
 * connection closed or `waitMs` passed. For requests no HTTP client would
 * agree to send.
 */
export function rawExchange(
  port: number,
  chunks: readonly (string | Buffer)[],
  options: { waitMs?: number; gapMs?: number } = {},
): Promise<string> {
  return new Promise((resolve) => {
    let received = "";
    let sent = false;
    let quiet: NodeJS.Timeout | undefined;
    const finish = () => {
      clearTimeout(quiet);
      clearTimeout(limit);
      socket.destroy();
      resolve(received);
    };
    // A kept-alive connection never closes on its own, so once everything is
    // sent and an answer has stopped arriving for a moment, that is the whole
    // of it.
    const settle = () => {
      clearTimeout(quiet);
      if (sent && received !== "") quiet = setTimeout(finish, 250);
    };
    const socket = connect(port, "127.0.0.1", async () => {
      for (const [index, chunk] of chunks.entries()) {
        if (index > 0 && options.gapMs) {
          await new Promise((wait) => setTimeout(wait, options.gapMs));
        }
        if (!socket.destroyed) socket.write(chunk);
      }
      sent = true;
      settle();
    });
    socket.on("data", (data: Buffer) => {
      received += data.toString("latin1");
      settle();
    });
    socket.on("error", () => undefined);
    socket.on("close", finish);
    const limit = setTimeout(finish, options.waitMs ?? 3000);
  });
}

/** The status code of the first response in a raw exchange, or 0 for none. */
export function firstStatus(exchange: string): number {
  return Number(/^HTTP\/1\.1 (\d{3})/.exec(exchange)?.[1] ?? 0);
}

/**
 * Whether anything has been added to the prototypes every object shares. A
 * write through `__proto__` or `constructor.prototype` lands here, and then
 * every object in the process appears to have it.
 */
export function pollutedPrototypes(): string[] {
  const found: string[] = [];
  for (const [name, proto] of [
    ["Object", Object.prototype],
    ["Array", Array.prototype],
    ["Function", Function.prototype],
  ] as const) {
    const expected = new Set(BASELINE.get(name));
    for (const key of Reflect.ownKeys(proto)) {
      if (!expected.has(key)) found.push(`${name}.prototype.${String(key)}`);
    }
  }
  if (({} as Record<string, unknown>)["polluted"] !== undefined)
    found.push("{}.polluted");
  return found;
}

const BASELINE = new Map<string, (string | symbol)[]>([
  ["Object", Reflect.ownKeys(Object.prototype)],
  ["Array", Reflect.ownKeys(Array.prototype)],
  ["Function", Reflect.ownKeys(Function.prototype)],
]);
