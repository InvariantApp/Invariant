/**
 * The `oci-rootless` driver: each phase in a container, through docker or
 * podman, on a machine the caller controls. It is the driver for a laptop,
 * for CI, and for a self-hosted install under Compose.
 *
 * Every phase's container gets a read-only root filesystem, a non-root user,
 * no capabilities, no privilege escalation, and hard limits on memory (with
 * no swap), CPUs, processes and CPU time; the wall clock is kept here and
 * the container is killed when it runs out. The analyse phase runs with
 * `--network=none`: it has a loopback interface and nothing else.
 *
 * The fetch phase runs on a network of its own, created `--internal`, so it
 * has no route off the host. The one other thing on that network is the
 * egress proxy (`proxy.ts`), in a container that is also on the default
 * network, and that is the only way out. A client that ignores
 * `HTTPS_PROXY` gets nowhere, rather than getting everywhere.
 */
import { existsSync, realpathSync } from "node:fs";
import { chown, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allowlist } from "./allowlist.ts";
import { type Exec, exec as run } from "./exec.ts";
import type { EgressDecision } from "./proxy.ts";
import {
  describeFailure,
  ENGINE,
  type Limits,
  limitsFor,
  type Mount,
  mountsFor,
  OutputTail,
  outcomeOf,
  type Phase,
  type PhaseRequest,
  type PhaseResult,
  phaseEnvironment,
  runId,
  type Sandbox,
  SandboxError,
  SCRATCH,
  type WorkspacePart,
} from "./sandbox.ts";

export type OciRuntime = "docker" | "podman";

/**
 * Directories on this machine, one per part of the workspace a phase sees,
 * and, as `engine`, the code it runs when the image does not carry it
 * (mounted read-only at `ENGINE` in both phases).
 */
export type LocalWorkspace = Partial<Record<WorkspacePart | "engine", string>>;

export interface OciOptions {
  /** An image with Node 22.18 or later, and whatever the phase's command needs. */
  image: string;
  /** docker or podman; whichever answers first when absent. */
  runtime?: OciRuntime;
  /** The image the egress proxy runs in; `image` by default. It needs only Node. */
  proxyImage?: string;
  /** Runs the runtime's command-line tool; for tests. */
  exec?: Exec;
  /** Told everything a phase prints, as it prints it. */
  onOutput?: (chunk: Buffer) => void;
}

/**
 * Node 24 on Debian, pinned by digest: enough for the proxy, npm, and every
 * pack but Go's, which also needs a Go toolchain in the image.
 */
export const NODE_IMAGE =
  "node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6";

/** The name the fetch phase reaches the proxy by, on its own network. */
export const PROXY_ALIAS = "egress-proxy";
export const PROXY_PORT = 3128;
/** Where the proxy's own files are mounted in its container. */
const PROXY_DIR = "/opt/invariant-egress";

/**
 * The first of docker and podman whose daemon or service answers, or
 * nothing. Asking for the server's version, not the client's, is what tells
 * an installed runtime from a usable one.
 */
export async function detectRuntime(exec: Exec = run): Promise<OciRuntime | undefined> {
  for (const runtime of ["docker", "podman"] as const) {
    try {
      const answer = await exec(runtime, [
        "version",
        "--format",
        runtime === "docker" ? "{{.Server.Version}}" : "{{.Version}}",
      ]);
      if (answer.code === 0 && answer.stdout.trim().length > 0) return runtime;
    } catch {
      // Not installed.
    }
  }
  return undefined;
}

/**
 * Who a phase runs as. Never root: with rootful docker, as the user running
 * this, so what a phase writes belongs to them; with podman, the same user
 * mapped into the container (`--userns=keep-id`); as root on the host, as
 * `nobody`. Rootless docker maps the container's root to the unprivileged
 * user running the daemon, so there the container's uid 0 is that user, and
 * with every capability dropped it holds no privilege of its own.
 */
export interface OciUser {
  user: string;
  userns?: string;
  /** Writable directories are handed to this uid first, as root. */
  chownTo?: number;
}

export function ociUser(
  runtime: OciRuntime,
  host: { uid: number; gid: number },
  rootlessDocker: boolean,
): OciUser {
  if (runtime === "podman") {
    return host.uid === 0
      ? { user: "65534:65534", chownTo: 65534 }
      : { user: `${host.uid}:${host.gid}`, userns: "keep-id" };
  }
  if (rootlessDocker) return { user: "0:0" };
  return host.uid === 0
    ? { user: "65534:65534", chownTo: 65534 }
    : { user: `${host.uid}:${host.gid}` };
}

export interface ContainerSpec {
  name: string;
  image: string;
  command: readonly string[];
  env: Readonly<Record<string, string>>;
  limits: Limits;
  mounts: readonly { source: string; target: string; readOnly: boolean }[];
  /** `none`, or the fetch phase's internal network. */
  network: string;
  user: OciUser;
  labels?: Readonly<Record<string, string>>;
}

function mountArgument(source: string, target: string, readOnly: boolean): string {
  // `--mount` is a comma-separated list, so a path with a comma in it would
  // be read as more options.
  if (/[,\n"]/.test(source)) {
    throw new SandboxError(
      "driver",
      `a path the sandbox mounts cannot contain a comma: ${source}`,
    );
  }
  return `type=bind,source=${source},target=${target}${readOnly ? ",readonly" : ""}`;
}

/** The arguments to `docker run` or `podman run` for one phase's container. */
export function containerArgs(spec: ContainerSpec): string[] {
  const { limits } = spec;
  const cpu = Math.ceil(limits.cpuSeconds);
  const args = [
    "run",
    "--name",
    spec.name,
    // A real init as process 1, so the phase's own processes are reaped and
    // a kill reaches all of them.
    "--init",
    "--network",
    spec.network,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    spec.user.user,
    ...(spec.user.userns ? ["--userns", spec.user.userns] : []),
    "--memory",
    `${limits.memoryMb}m`,
    // Equal to the memory limit: no swap, so a phase over its memory is
    // killed instead of thrashing the machine it shares.
    "--memory-swap",
    `${limits.memoryMb}m`,
    "--cpus",
    String(limits.cpus),
    "--pids-limit",
    String(limits.pids),
    // The soft limit sends SIGXCPU, which ends the phase and says why; the
    // hard one, a little later, is SIGKILL for a phase that ignores it.
    "--ulimit",
    `cpu=${cpu}:${cpu + 5}`,
    "--ulimit",
    "core=0",
    "--tmpfs",
    `${SCRATCH}:rw,nosuid,nodev,size=${limits.tmpMb}m`,
    "--workdir",
    SCRATCH,
    "--hostname",
    "sandbox",
  ];
  for (const [key, value] of Object.entries(spec.labels ?? {})) {
    args.push("--label", `${key}=${value}`);
  }
  for (const mount of spec.mounts) {
    args.push("--mount", mountArgument(mount.source, mount.target, mount.readOnly));
  }
  for (const [key, value] of Object.entries(spec.env)) {
    if (/[\n=]/.test(key))
      throw new SandboxError("driver", `not an environment name: ${key}`);
    args.push("--env", `${key}=${value}`);
  }
  args.push(spec.image, ...spec.command);
  return args;
}

/**
 * The proxy's files on this machine, and the entry to start: the built
 * `.js` beside a published package, or the source in this repository,
 * which Node runs by stripping its types.
 */
export function proxyEntry(): { dir: string; file: string } {
  const dir = realpathSync(dirname(fileURLToPath(import.meta.url)));
  for (const file of ["proxy-main.js", "proxy-main.ts"]) {
    if (existsSync(join(dir, file))) return { dir, file };
  }
  throw new SandboxError("driver", `the egress proxy is not beside ${dir}`);
}

/** The workspace's directories a phase mounts, checked and made absolute. */
async function mountsOn(
  phase: Phase,
  workspace: LocalWorkspace,
): Promise<{ source: string; target: string; readOnly: boolean }[]> {
  const wanted: Mount[] = mountsFor(phase);
  const found = [];
  for (const mount of wanted) {
    const path = workspace[mount.part];
    if (!path) {
      throw new SandboxError(
        "driver",
        `the ${phase} phase needs the workspace's ${mount.part}`,
        {
          phase,
        },
      );
    }
    found.push({ source: await directory(phase, mount.part, path), ...mount });
  }
  if (workspace.engine) {
    found.push({
      source: await directory(phase, "engine", workspace.engine),
      target: ENGINE,
      readOnly: true,
    });
  }
  return found.map(({ source, target, readOnly }) => ({ source, target, readOnly }));
}

async function directory(phase: Phase, part: string, path: string): Promise<string> {
  const source = isAbsolute(path) ? path : resolve(path);
  const info = await stat(source).catch(() => undefined);
  if (!info?.isDirectory()) {
    throw new SandboxError(
      "driver",
      `the workspace's ${part} is not a directory: ${source}`,
      {
        phase,
      },
    );
  }
  return realpathSync(source);
}

export function ociSandbox(options: OciOptions): Sandbox<LocalWorkspace> {
  const exec = options.exec ?? run;
  let settled: Promise<{ runtime: OciRuntime; user: OciUser }> | undefined;

  const setup = () => {
    settled ??= (async () => {
      const runtime = options.runtime ?? (await detectRuntime(exec));
      if (!runtime) {
        throw new SandboxError(
          "unavailable",
          "neither docker nor podman is running here, so there is nothing to run a sandbox in",
        );
      }
      let rootless = false;
      if (runtime === "docker") {
        const info = await exec("docker", [
          "info",
          "--format",
          "{{json .SecurityOptions}}",
        ]);
        rootless = info.stdout.includes("rootless");
      }
      const uid = process.getuid?.() ?? 0;
      const gid = process.getgid?.() ?? 0;
      return { runtime, user: ociUser(runtime, { uid, gid }, rootless) };
    })();
    return settled;
  };

  /** Runs one container to its end, killing it at the wall clock. */
  async function contain(
    phase: Phase,
    request: PhaseRequest<LocalWorkspace>,
    network: string,
    env: Record<string, string>,
    id: string,
  ): Promise<PhaseResult> {
    const { runtime, user } = await setup();
    const limits = limitsFor(phase, request.limits);
    const mounts = await mountsOn(phase, request.workspace);
    if (user.chownTo !== undefined) {
      for (const mount of mounts) {
        if (!mount.readOnly) await chown(mount.source, user.chownTo, user.chownTo);
      }
    }
    const name = `invariant-${phase}-${id}`;
    const args = containerArgs({
      name,
      image: options.image,
      command: request.command,
      env,
      limits,
      mounts,
      network,
      user,
      labels: { "invariant.sandbox.run": id, "invariant.sandbox.phase": phase },
    });
    const tail = new OutputTail();
    const started = Date.now();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void exec(runtime, ["kill", name]).catch(() => undefined);
    }, limits.wallSeconds * 1000);
    try {
      const ran = await exec(runtime, args, {
        onOutput: (chunk) => {
          tail.push(chunk);
          options.onOutput?.(chunk);
        },
      }).catch((error: unknown) => {
        throw new SandboxError("unavailable", `could not start ${runtime}`, {
          phase,
          cause: error,
        });
      });
      clearTimeout(timer);
      const inspected = await exec(runtime, [
        "inspect",
        "--format",
        "{{json .State}}",
        name,
      ]);
      const state = (() => {
        try {
          return JSON.parse(inspected.stdout) as {
            OOMKilled?: boolean;
            ExitCode?: number;
          };
        } catch {
          return {};
        }
      })();
      // 125 to 127 are the runtime's own: it could not create the container
      // or start its command, and the phase never ran.
      if (ran.code !== null && ran.code >= 125 && ran.code <= 127 && !state.ExitCode) {
        throw new SandboxError(
          "driver",
          `${runtime} could not run the ${phase} phase: ${ran.stderr.trim().split("\n").at(-1) ?? ""}`,
          { phase, exitCode: ran.code, output: tail.toString() },
        );
      }
      const exitCode = state.ExitCode ?? ran.code;
      const outcome = outcomeOf({
        exitCode,
        timedOut,
        ...(state.OOMKilled ? { oomKilled: true } : {}),
      });
      if (outcome !== "ok") {
        throw new SandboxError(
          outcome,
          describeFailure(
            outcome as Exclude<typeof outcome, "unavailable" | "driver">,
            phase,
            limits,
            exitCode,
          ),
          { phase, ...(exitCode === null ? {} : { exitCode }), output: tail.toString() },
        );
      }
      return {
        phase,
        driver: "oci-rootless",
        durationMs: Date.now() - started,
        output: tail.toString(),
      };
    } finally {
      clearTimeout(timer);
      await exec(runtime, ["rm", "--force", name]).catch(() => undefined);
    }
  }

  return {
    driver: "oci-rootless",

    async analyse(request) {
      const id = runId();
      return contain(
        "analyse",
        request,
        "none",
        phaseEnvironment("analyse", request.env ? { env: request.env } : {}),
        id,
      );
    },

    async fetch(request) {
      const { runtime } = await setup();
      const id = runId();
      const network = `invariant-sandbox-${id}`;
      const proxy = `invariant-egress-${id}`;
      const hosts = [...allowlist(request.allow ?? [])];
      const entry = proxyEntry();
      const labels = ["--label", `invariant.sandbox.run=${id}`];
      const created: (() => Promise<unknown>)[] = [];
      try {
        const made = await exec(runtime, [
          "network",
          "create",
          "--internal",
          ...labels,
          network,
        ]);
        if (made.code !== 0) {
          throw new SandboxError(
            "driver",
            `could not create the fetch network: ${made.stderr.trim()}`,
            {
              phase: "fetch",
            },
          );
        }
        created.push(() => exec(runtime, ["network", "rm", network]));
        // The proxy starts on the default network, which reaches the
        // internet, and is then joined to the fetch's internal one under
        // the name the fetch knows it by.
        const started = await exec(runtime, [
          "run",
          "--detach",
          "--name",
          proxy,
          "--init",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--user",
          "65534:65534",
          "--memory",
          "256m",
          "--memory-swap",
          "256m",
          "--cpus",
          "0.5",
          "--pids-limit",
          "64",
          ...labels,
          "--mount",
          mountArgument(entry.dir, PROXY_DIR, true),
          options.proxyImage ?? options.image,
          "node",
          `${PROXY_DIR}/${entry.file}`,
          "--port",
          String(PROXY_PORT),
          "--allow",
          hosts.join(","),
        ]);
        created.push(() => exec(runtime, ["rm", "--force", proxy]));
        if (started.code !== 0) {
          throw new SandboxError(
            "driver",
            `could not start the egress proxy: ${started.stderr.trim()}`,
            {
              phase: "fetch",
            },
          );
        }
        const joined = await exec(runtime, [
          "network",
          "connect",
          "--alias",
          PROXY_ALIAS,
          network,
          proxy,
        ]);
        if (joined.code !== 0) {
          throw new SandboxError(
            "driver",
            `could not attach the egress proxy: ${joined.stderr.trim()}`,
            {
              phase: "fetch",
            },
          );
        }
        await waitForProxy(exec, runtime, proxy);
        const result = await contain(
          "fetch",
          request,
          network,
          phaseEnvironment("fetch", {
            proxy: `http://${PROXY_ALIAS}:${PROXY_PORT}`,
            ...(request.env ? { env: request.env } : {}),
          }),
          id,
        ).catch(async (error: unknown) => {
          if (!(error instanceof SandboxError)) throw error;
          throw new SandboxError(error.kind, error.message, {
            ...(error.phase ? { phase: error.phase } : {}),
            ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
            ...(error.output === undefined ? {} : { output: error.output }),
            egress: await egressOf(exec, runtime, proxy),
          });
        });
        return { ...result, egress: await egressOf(exec, runtime, proxy) };
      } finally {
        // In reverse: the proxy leaves the network before it is removed.
        for (const undo of created.reverse()) await undo().catch(() => undefined);
      }
    },
  };
}

async function waitForProxy(
  exec: Exec,
  runtime: OciRuntime,
  name: string,
): Promise<void> {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const logs = await exec(runtime, ["logs", name]);
    if (logs.stdout.includes('"ready"')) return;
    const state = await exec(runtime, [
      "inspect",
      "--format",
      "{{.State.Running}}",
      name,
    ]);
    if (state.stdout.trim() === "false") {
      throw new SandboxError(
        "driver",
        `the egress proxy stopped before it was ready: ${(logs.stderr || logs.stdout).trim().slice(-500)}`,
        { phase: "fetch" },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new SandboxError("driver", "the egress proxy was not ready within 30s", {
    phase: "fetch",
  });
}

async function egressOf(
  exec: Exec,
  runtime: OciRuntime,
  name: string,
): Promise<EgressDecision[]> {
  const logs = await exec(runtime, ["logs", name]).catch(() => undefined);
  const decisions: EgressDecision[] = [];
  for (const line of (logs?.stdout ?? "").split("\n")) {
    try {
      const parsed = JSON.parse(line) as { egress?: EgressDecision };
      if (parsed.egress) decisions.push(parsed.egress);
    } catch {
      // Not one of the proxy's lines.
    }
  }
  return decisions;
}
