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
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Target } from "@invariant/verifier";
import type { BuildConfig, BuildSource } from "./config.ts";

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
  child: ChildProcess | undefined,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response yet";

  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
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
 * Every process group this run has started and not yet stopped.
 *
 * Detaching a build is what makes it stoppable, and it is also what stops a
 * Ctrl-C or a cancelled CI job from reaching it: a detached group is no longer
 * in the terminal's foreground group, so the signal that would have killed
 * everything now kills only this process and leaves the builds running. So
 * this run takes responsibility for them itself.
 */
const running = new Set<() => void>();
/** Checkouts made for historical builds, removed once the run is over. */
const checkouts = new Set<() => void>();
let cleanupInstalled = false;

function installCleanup(): void {
  if (cleanupInstalled) return;
  cleanupInstalled = true;

  const stopAll = (): void => {
    for (const stop of running) stop();
    running.clear();
    for (const remove of checkouts) remove();
    checkouts.clear();
  };

  process.once("exit", stopAll);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      stopAll();
      // Re-raise with the handler removed, so the exit code says what actually
      // happened rather than reporting a clean finish.
      process.kill(process.pid, signal);
    });
  }
}

/**
 * Starts one build and returns something the verifier can send requests to.
 *
 * `head` uses the configured current-build environment. Any other value is a
 * contract label: one named under `build.contracts` is stood up from its own
 * source, and any other is the current code with `${contract}` in the base
 * environment replaced by the label, which is what lets one start command
 * serve every historical build a provider still supports.
 */
export async function launchBuild(
  label: string,
  options: LaunchOptions,
): Promise<Target> {
  const source = label === "head" ? undefined : options.build.contracts.get(label);
  if (source?.kind === "url") return reach(label, source.url, options);
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

/** Fills `${contract}` into each value, beside the port the build is given. */
function environment(
  configured: Record<string, string>,
  label: string,
  port: number,
): Record<string, string> {
  const env: Record<string, string> = { PORT: String(port) };
  for (const [name, value] of Object.entries(configured)) {
    env[name] = value.replaceAll(CONTRACT_PLACEHOLDER, label);
  }
  return env;
}

/** How one build is started: a command, where, with what, and what to undo. */
interface Plan {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Run once the process is gone, for anything it leaves behind. */
  after?: () => void;
}

async function planFor(
  label: string,
  source: BuildSource | undefined,
  port: number,
  options: LaunchOptions,
): Promise<Plan> {
  const build = options.build;
  if (source?.kind === "image") {
    // Run in the foreground so the process is the container's lifetime, and
    // removed by name afterwards, since killing the client does not stop it.
    const name = `invariant-${label.replace(/[^a-zA-Z0-9_.-]/g, "-")}-${port}`;
    const env = environment(source.env, label, port);
    delete env["PORT"];
    return {
      command: "docker",
      args: [
        "run",
        "--rm",
        "--name",
        name,
        "-p",
        `127.0.0.1:${port}:${source.port}`,
        ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
        source.image,
      ],
      cwd: options.cwd,
      env: {},
      after: () => {
        spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
      },
    };
  }
  if (source?.kind === "worktree") {
    return {
      command: source.command,
      args: source.args,
      cwd: await checkout(source, options.cwd),
      env: environment(source.env, label, port),
    };
  }
  return {
    command: build.command,
    args: build.args,
    cwd: options.cwd,
    env: environment(label === "head" ? build.headEnv : build.baseEnv, label, port),
  };
}

/** A command's standard error, and whether it succeeded. */
function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, stderr: error.message });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stderr });
    });
  });
}

const lastLines = (text: string) => text.trim().split("\n").slice(-5).join("\n");

/**
 * The commit a contract was released from, checked out beside the repository
 * and installed, once per run however many times the build is started. It is
 * removed when the run ends.
 */
const worktrees = new Map<string, Promise<string>>();
function checkout(
  source: Extract<BuildSource, { kind: "worktree" }>,
  cwd: string,
): Promise<string> {
  const key = `${source.ref}\0${source.install?.command ?? ""} ${source.install?.args.join(" ") ?? ""}`;
  let made = worktrees.get(key);
  if (!made) {
    made = (async () => {
      const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        encoding: "utf8",
      });
      if (top.status !== 0) {
        throw new LaunchError(
          `a worktree build needs a git repository: ${lastLines(top.stderr)}`,
        );
      }
      const repository = top.stdout.trim();
      const dir = await mkdtemp(join(tmpdir(), "invariant-build-"));
      const added = await run(
        "git",
        ["worktree", "add", "--detach", dir, source.ref],
        repository,
        120_000,
      );
      if (!added.ok) {
        throw new LaunchError(
          `could not check out ${source.ref}: ${lastLines(added.stderr)}`,
        );
      }
      installCleanup();
      checkouts.add(() => {
        spawnSync("git", ["worktree", "remove", "--force", dir], {
          cwd: repository,
          stdio: "ignore",
        });
      });
      // The configuration may sit below the top of the repository, and the
      // build is started where it sits, at the released commit.
      const at = join(dir, relative(repository, cwd));
      if (source.install) {
        const installed = await run(
          source.install.command,
          source.install.args,
          at,
          600_000,
        );
        if (!installed.ok) {
          throw new LaunchError(
            `installing ${source.ref} failed: ${lastLines(installed.stderr)}`,
          );
        }
      }
      return at;
    })();
    worktrees.set(key, made);
  }
  return made;
}

/**
 * An environment the provider already runs for this contract. Nothing is
 * started or stopped, and nothing about its state is fresh: two runs against
 * it share whatever it holds.
 */
async function reach(
  label: string,
  url: string,
  options: LaunchOptions,
): Promise<Target> {
  try {
    await waitForHealth(
      url,
      options.build.healthPath,
      undefined,
      options.timeoutMs ?? 30_000,
    );
  } catch (error) {
    throw new LaunchError(
      `${label}: ${url} ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { fetch: (request) => forward(url, request), close: async () => {} };
}

async function forward(base: string, request: Request): Promise<Response> {
  const url = new URL(request.url);
  return fetch(`${base}${url.pathname}${url.search}`, {
    method: request.method,
    headers: request.headers,
    ...(request.body === null ? {} : { body: await request.text(), duplex: "half" }),
  } as RequestInit);
}

async function startOnce(label: string, options: LaunchOptions): Promise<Target> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const source = label === "head" ? undefined : options.build.contracts.get(label);
  const plan = await planFor(label, source, port, options);

  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    env: { ...process.env, ...plan.env },
    // The build's own output would drown the report. Failures surface through
    // the health check, which says what actually went wrong.
    stdio: ["ignore", "ignore", "pipe"],
    // Its own process group, which is the only way to stop all of it.
    //
    // A start command is almost never the server. `pnpm start` runs a script
    // that runs the server, so signalling the child kills the script and
    // leaves the server running, holding the port and the inherited stderr
    // pipe. The parent then waits forever for a stream that nothing will
    // close, which looks exactly like a slow check and is in fact a finished
    // one that cannot exit.
    detached: true,
  });

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  installCleanup();
  const emergencyStop = (): void => {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    plan.after?.();
  };
  running.add(emergencyStop);

  const signalGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      // The negative pid is the group, which is the whole point.
      process.kill(-child.pid, signal);
    } catch {
      // Already gone, which is the outcome being asked for.
    }
  };

  const close = async (): Promise<void> => {
    running.delete(emergencyStop);
    if (child.exitCode !== null) {
      plan.after?.();
      return;
    }
    signalGroup("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        signalGroup("SIGKILL");
        resolve();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    // Nothing else reads this, and leaving it attached keeps a handle open on
    // a process that is meant to be gone.
    child.stderr?.destroy();
    plan.after?.();
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
    running.delete(emergencyStop);
    const detail = stderr.trim().split("\n").slice(-5).join("\n");
    throw new LaunchError(
      `${label}: ${error instanceof Error ? error.message : String(error)}` +
        (detail ? `\n${detail}` : ""),
    );
  }

  return { fetch: (request) => forward(base, request), close };
}
