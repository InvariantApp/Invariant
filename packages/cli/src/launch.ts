/**
 * Standing up a provider's build for the differential check.
 *
 * Every build gets its own process, its own ephemeral port and its own state.
 * Nothing is shared between runs on purpose: the comparison decides what is
 * stable by running the old build twice, so two runs that shared a database
 * would report every identifier as stable and the calibration would quietly
 * stop working.
 *
 * The process is the provider's own start command, run in the provider's own
 * repository, on their machine or their CI. Invariant reads nothing from it
 * except HTTP responses.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import type { Target } from "@invariant/verifier";
import type { BuildConfig } from "./config.ts";

/**
 * What a provider writes in `invariant.yaml` to mean "the contract being
 * built". Escaped because it is a literal placeholder, not interpolation.
 */
const CONTRACT_PLACEHOLDER = `\${contract}`;

export class LaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchError";
  }
}

/** A port the operating system has just confirmed is free. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new LaunchError("could not reserve a port"));
        return;
      }
      const { port } = address;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

async function waitForHealth(
  base: string,
  path: string,
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response yet";

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new LaunchError(
        `the build exited with code ${child.exitCode} before it became ready`,
      );
    }
    try {
      const response = await fetch(`${base}${path}`);
      if (response.ok) return;
      lastError = `health check answered ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new LaunchError(`the build never became ready: ${lastError}`);
}

export interface LaunchOptions {
  build: BuildConfig;
  /** Directory to run the command in, normally the provider's repository. */
  cwd: string;
  /** How long to wait for the health path, in milliseconds. */
  timeoutMs?: number;
}

/**
 * Starts one build and returns something the verifier can send requests to.
 *
 * `head` uses the configured current-build environment; any other value is a
 * contract label, and `${contract}` in the base environment is replaced with
 * it. That is what lets one start command serve every historical build the
 * provider still supports.
 */
export async function launchBuild(
  label: string,
  options: LaunchOptions,
): Promise<Target> {
  // Reserving a port means asking the operating system for a free one and then
  // letting go of it so the child can take it. Between those two moments
  // anything else on the machine may take it instead, and in CI something
  // usually is. The window cannot be closed from out here, so a lost race is
  // retried with a fresh port rather than reported as a broken build.
  let last: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await startOnce(label, options);
    } catch (error) {
      last = error;
      if (!(error instanceof LaunchError) || !error.message.includes("EADDRINUSE")) {
        throw error;
      }
    }
  }
  throw last;
}

async function startOnce(label: string, options: LaunchOptions): Promise<Target> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const configured = label === "head" ? options.build.headEnv : options.build.baseEnv;

  const env: Record<string, string> = { PORT: String(port) };
  for (const [name, value] of Object.entries(configured)) {
    env[name] = value.replaceAll(CONTRACT_PLACEHOLDER, label);
  }

  const child = spawn(options.build.command, options.build.args, {
    cwd: options.cwd,
    env: { ...process.env, ...env },
    // The build's own output would drown the report. Failures surface through
    // the health check, which says what actually went wrong.
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const close = async (): Promise<void> => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  try {
    await waitForHealth(
      base,
      options.build.healthPath,
      child,
      options.timeoutMs ?? 30_000,
    );
  } catch (error) {
    await close();
    const detail = stderr.trim().split("\n").slice(-5).join("\n");
    throw new LaunchError(
      `${label}: ${error instanceof Error ? error.message : String(error)}` +
        (detail ? `\n${detail}` : ""),
    );
  }

  return {
    fetch: async (request) => {
      const url = new URL(request.url);
      return fetch(`${base}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        ...(request.body === null ? {} : { body: await request.text(), duplex: "half" }),
      } as RequestInit);
    },
    close,
  };
}
