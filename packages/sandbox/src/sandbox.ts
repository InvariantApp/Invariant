/**
 * What a sandbox is, whichever driver runs it.
 *
 * A migration runs in two phases, and each gets only what it needs. The
 * fetch phase downloads the SDK releases the migration reads: it may reach
 * the package registries and nothing else, through the egress proxy
 * (`proxy.ts`), with install scripts off, and it never sees the consumer's
 * repository. The analyse phase reads the repository against those releases
 * and writes its result: it has no network at all, reads everything it was
 * given read-only, and can write only its output directory and a scratch
 * directory that vanishes with it.
 *
 * Splitting it this way is the point. Whatever a hostile repository or a
 * hostile package manages to make the analysis do, there is nowhere to send
 * what it read; and the phase that can talk to the network never reads the
 * repository. Each driver (`oci.ts`, `k8s.ts`, `fly.ts`) enforces the same
 * layout, environment and limits with the isolation its platform has.
 */
import { randomBytes } from "node:crypto";
import type { EgressDecision } from "./proxy.ts";

export type Phase = "fetch" | "analyse";

export type DriverName = "oci-rootless" | "k8s-job" | "fly-machine";

/**
 * What one phase may use. Memory, CPUs, CPU time and the wall clock are
 * enforced by every driver. The process ceiling is set per container by
 * docker and podman; a Kubernetes cluster sets it per node (the kubelet's
 * `podPidsLimit`). Scratch space is a sized tmpfs under docker and podman
 * and a sized `emptyDir` under Kubernetes. A Fly machine is a VM running
 * nothing else, so its processes and its scratch space are bounded by the
 * machine itself rather than by these two numbers.
 */
export interface Limits {
  /** Memory, in MiB, with no swap beyond it. */
  memoryMb: number;
  /** CPU cores the phase may use at once. */
  cpus: number;
  /** CPU time, in seconds, summed over a process's life (`RLIMIT_CPU`). */
  cpuSeconds: number;
  /** Wall-clock time, in seconds, after which the phase is killed. */
  wallSeconds: number;
  /** Processes and threads at once, so a fork bomb stops at the ceiling. */
  pids: number;
  /** The scratch directory at `/tmp`, in MiB. */
  tmpMb: number;
}

/**
 * Enough for stripe-node checked twice by the TypeScript compiler, and for
 * pyright over a large Django project. A fetch downloads and unpacks and
 * needs far less.
 */
export const DEFAULT_LIMITS: Readonly<Record<Phase, Readonly<Limits>>> = {
  fetch: {
    memoryMb: 1024,
    cpus: 1,
    cpuSeconds: 600,
    wallSeconds: 900,
    pids: 256,
    tmpMb: 1024,
  },
  analyse: {
    memoryMb: 4096,
    cpus: 2,
    cpuSeconds: 3600,
    wallSeconds: 3600,
    pids: 512,
    tmpMb: 2048,
  },
};

/** The limits a phase runs under: the defaults, with what the caller set. */
export function limitsFor(phase: Phase, overrides: Partial<Limits> = {}): Limits {
  const limits = { ...DEFAULT_LIMITS[phase], ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new SandboxError(
        "driver",
        `the ${phase} phase's ${name} limit must be a positive number, not ${value}`,
        { phase },
      );
    }
  }
  return limits;
}

/**
 * The parts of a workspace, and where each appears inside the sandbox. The
 * paths are the same under every driver, so what runs inside never needs
 * to know which one it is under.
 */
export const WORKSPACE = {
  /** What the phase is asked to do: a request file the caller wrote. */
  request: "/work/request",
  /** The consumer's repository, as files. */
  repo: "/work/repo",
  /** What the fetch phase downloaded. */
  packages: "/work/packages",
  /** What the analyse phase found. */
  out: "/work/out",
} as const;

export type WorkspacePart = keyof typeof WORKSPACE;

/** Scratch space: writable, sized by `Limits.tmpMb`, and gone with the phase. */
export const SCRATCH = "/tmp";

/**
 * Where the code a phase runs is mounted, read-only, when the image does not
 * carry it: `invariant migrate` on a laptop runs the installation it was
 * started from, so what runs inside is exactly what would have run outside.
 * A service's image carries its own, and leaves this out.
 */
export const ENGINE = "/opt/invariant";

export interface Mount {
  part: WorkspacePart;
  target: string;
  readOnly: boolean;
}

/**
 * What each phase sees of the workspace. The fetch phase is not given the
 * repository at all: nothing it downloads is decided by reading it, since
 * the caller put every name and version in the request, so a repository
 * crafted to steer a download has nothing to steer.
 */
export function mountsFor(phase: Phase): Mount[] {
  const mount = (part: WorkspacePart, readOnly: boolean): Mount => ({
    part,
    target: WORKSPACE[part],
    readOnly,
  });
  return phase === "fetch"
    ? [mount("request", true), mount("packages", false)]
    : [
        mount("request", true),
        mount("repo", true),
        mount("packages", true),
        mount("out", false),
      ];
}

/**
 * The environment each phase runs in, laid over whatever the caller passes,
 * so a caller cannot turn install scripts back on or point a phase at a
 * proxy of its own by accident.
 *
 * The fetch phase's every client is sent through the proxy: npm and the go
 * command read `HTTPS_PROXY`, and Node's own `fetch`, which the PyPI wheels
 * arrive by, does when `NODE_USE_ENV_PROXY` is set. Install scripts are off
 * for npm, pip may only take wheels, and the go command may not fetch a
 * toolchain or reach a version-control host. In the analyse phase there is
 * no proxy and the module proxy is `off`, so a tool that tries the network
 * fails at once instead of waiting on a connection that cannot open.
 */
export function phaseEnvironment(
  phase: Phase,
  options: { proxy?: string; env?: Readonly<Record<string, string>> } = {},
): Record<string, string> {
  const common: Record<string, string> = {
    HOME: SCRATCH,
    TMPDIR: SCRATCH,
    INVARIANT_SANDBOX_PHASE: phase,
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_cache: `${SCRATCH}/npm-cache`,
    GOTOOLCHAIN: "local",
    GOFLAGS: "-mod=readonly",
    GOVCS: "*:off",
    GOWORK: "off",
    GOENV: "off",
    GOTELEMETRY: "off",
    CGO_ENABLED: "0",
    GONOPROXY: "",
    GONOSUMDB: "",
    GOPRIVATE: "",
    GOINSECURE: "",
    PIP_ONLY_BINARY: ":all:",
    PIP_NO_INPUT: "1",
  };
  if (phase === "analyse") {
    // No proxy of any kind, whatever the caller passed: there is nothing to
    // reach, and a client should not spend its time trying.
    const caller = Object.fromEntries(
      Object.entries(options.env ?? {}).filter(([key]) => !/proxy/i.test(key)),
    );
    return {
      ...caller,
      ...common,
      GOPROXY: "off",
      // Every checksum the analysis needs was verified against the checksum
      // database by the fetch, which cached what it looked up.
      GOSUMDB: "off",
      npm_config_offline: "true",
    };
  }
  if (!options.proxy) {
    throw new SandboxError("driver", "the fetch phase needs the egress proxy's address", {
      phase,
    });
  }
  return {
    ...options.env,
    ...common,
    HTTPS_PROXY: options.proxy,
    HTTP_PROXY: options.proxy,
    https_proxy: options.proxy,
    http_proxy: options.proxy,
    NO_PROXY: "",
    no_proxy: "",
    NODE_USE_ENV_PROXY: "1",
    npm_config_https_proxy: options.proxy,
    npm_config_proxy: options.proxy,
    GOPROXY: "https://proxy.golang.org",
    GOSUMDB: "sum.golang.org",
  };
}

/**
 * `command` run with its CPU time capped, for platforms with no way to set
 * `RLIMIT_CPU` on a container of their own. Past the limit the process gets
 * SIGXCPU, which ends it.
 */
export function withCpuLimit(command: readonly string[], seconds: number): string[] {
  return [
    "/bin/sh",
    "-c",
    'ulimit -t "$0" && exec "$@"',
    String(Math.ceil(seconds)),
    ...command,
  ];
}

export interface PhaseRequest<Workspace> {
  /** Where the phase's inputs are and its outputs go, in the driver's terms. */
  workspace: Workspace;
  /** What runs inside, as an argument vector: never through a shell. */
  command: readonly string[];
  env?: Readonly<Record<string, string>>;
  limits?: Partial<Limits>;
}

export interface FetchRequest<Workspace> extends PhaseRequest<Workspace> {
  /** Hosts the fetch may reach beyond `REGISTRIES`, such as a private registry. */
  allow?: readonly string[];
}

export type AnalyseRequest<Workspace> = PhaseRequest<Workspace>;

/** A phase that ran to the end and exited 0. Anything else is a `SandboxError`. */
export interface PhaseResult {
  phase: Phase;
  driver: DriverName;
  durationMs: number;
  /** The end of what the phase printed, where the driver can read it. */
  output: string;
  /** What the egress proxy allowed and refused, for a fetch whose driver can say. */
  egress?: EgressDecision[];
}

export interface Sandbox<Workspace> {
  readonly driver: DriverName;
  fetch(request: FetchRequest<Workspace>): Promise<PhaseResult>;
  analyse(request: AnalyseRequest<Workspace>): Promise<PhaseResult>;
}

/**
 * Why a phase did not finish.
 * - `unavailable`: the driver cannot run here (no container runtime, say).
 * - `timeout`: the wall clock ran out and the phase was killed.
 * - `memory`: the phase was killed for going over its memory limit.
 * - `cpu`: the phase used up its CPU time.
 * - `exit`: what ran inside exited non-zero on its own.
 * - `driver`: the platform refused or failed to run the phase at all.
 */
export type SandboxErrorKind =
  | "unavailable"
  | "timeout"
  | "memory"
  | "cpu"
  | "exit"
  | "driver";

export class SandboxError extends Error {
  readonly kind: SandboxErrorKind;
  readonly phase: Phase | undefined;
  readonly exitCode: number | undefined;
  /** The end of what the phase printed, where there was any. */
  readonly output: string | undefined;
  /** What the egress proxy allowed and refused, for a fetch whose driver can say. */
  readonly egress: EgressDecision[] | undefined;

  constructor(
    kind: SandboxErrorKind,
    message: string,
    details: {
      phase?: Phase;
      exitCode?: number;
      output?: string;
      egress?: EgressDecision[];
      cause?: unknown;
    } = {},
  ) {
    super(message, details.cause === undefined ? {} : { cause: details.cause });
    this.name = "SandboxError";
    this.kind = kind;
    this.phase = details.phase;
    this.exitCode = details.exitCode;
    this.output = details.output;
    this.egress = details.egress;
  }
}

/** SIGXCPU's exit status through a shell: 128 plus the signal's number. */
const CPU_EXIT = 128 + 24;

/**
 * What a finished phase's status means. Drivers report what their platform
 * told them; this is the one place those facts become a kind of failure, so
 * a phase killed for memory reads the same under every driver.
 */
export function outcomeOf(status: {
  exitCode: number | null;
  signal?: string | null;
  oomKilled?: boolean;
  timedOut?: boolean;
  /** What the phase printed, where the driver has it. */
  output?: string;
}): SandboxErrorKind | "ok" {
  if (status.timedOut) return "timeout";
  if (status.oomKilled) return "memory";
  if (status.signal === "SIGXCPU" || status.exitCode === CPU_EXIT) return "cpu";
  if (status.exitCode === 0) return "ok";
  // Node sizes its heap to the memory it is given, and may give up on its
  // own before the kernel steps in: that is the same limit, reached first.
  if (status.output && NODE_OUT_OF_MEMORY.test(status.output)) return "memory";
  return "exit";
}

const NODE_OUT_OF_MEMORY =
  /FATAL ERROR: .*(heap out of memory|Allocation failed)|ERR_MEMORY_ALLOCATION_FAILED|Array buffer allocation failed/;

/** A message for each kind of failure, naming the phase and the limit it hit. */
export function describeFailure(
  kind: Exclude<SandboxErrorKind, "unavailable" | "driver">,
  phase: Phase,
  limits: Limits,
  exitCode: number | null,
): string {
  switch (kind) {
    case "timeout":
      return `the ${phase} phase ran past its ${limits.wallSeconds}s wall clock and was killed`;
    case "memory":
      return `the ${phase} phase went over its ${limits.memoryMb} MiB of memory and was killed`;
    case "cpu":
      return `the ${phase} phase used up its ${limits.cpuSeconds}s of CPU time`;
    case "exit":
      return `the ${phase} phase exited ${exitCode ?? "without a status"}`;
  }
}

/** Keeps the last `limit` characters of what a phase prints. */
export class OutputTail {
  #text = "";
  readonly #limit: number;

  constructor(limit = 64 * 1024) {
    this.#limit = limit;
  }

  push(chunk: string | Buffer): void {
    this.#text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (this.#text.length > this.#limit * 2) this.#text = this.#text.slice(-this.#limit);
  }

  toString(): string {
    return this.#text.slice(-this.#limit);
  }
}

/** A name no two runs share, for containers, networks and Kubernetes objects. */
export function runId(): string {
  return `${Date.now().toString(36)}-${randomBytes(5).toString("hex")}`;
}
