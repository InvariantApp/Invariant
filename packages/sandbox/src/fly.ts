/**
 * The `fly-machine` driver: each phase in a one-shot Fly Machine, a
 * Firecracker microVM with a kernel of its own.
 *
 * A machine per phase, created with the phase's command, `auto_destroy` so
 * it is gone once the command exits, a restart policy of `no` so a phase
 * that failed is never run again on its own, and a guest sized to the
 * phase's memory and CPUs. The CPU time is capped inside with `ulimit`, and
 * the wall clock here: a machine still running at its end is killed and
 * destroyed. It is not registered in the organisation's private DNS, so
 * nothing else on the network can find it by name.
 *
 * Each phase runs in an app of its own, because Fly's network policies are
 * set per app: the operator gives the analyse app a policy that denies all
 * egress, and the fetch app one that reaches only the egress proxy's app.
 * Those policies are the operator's to set and to prove; nothing in this
 * file can, and the Machines API documents rules by port, not by
 * destination, so what they can express has to be checked where they run.
 *
 * The workspace is a Fly volume mounted at `/work`, with a directory per
 * part. A volume mounts whole and writable, so the read-only parts are
 * read-only by convention here, not by the mount; the service writes the
 * repository onto the volume only after the fetch has finished, so the
 * fetch never sees it.
 */
import {
  describeFailure,
  limitsFor,
  outcomeOf,
  type Phase,
  type PhaseRequest,
  type PhaseResult,
  phaseEnvironment,
  runId,
  type Sandbox,
  SandboxError,
  withCpuLimit,
} from "./sandbox.ts";

/** What the driver needs of an HTTP client: `fetch`'s shape, so `fetch` itself will do. */
export type HttpClient = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface FlyWorkspace {
  /** The volume holding the workspace, in the phase's app and region. */
  volume: string;
}

export interface FlyOptions {
  /** The app each phase's machines are created in; see the module comment. */
  apps: { fetch: string; analyse: string };
  /** A token able to create and destroy machines in both apps. */
  token: string;
  image: string;
  /** The egress proxy, as the fetch app reaches it: `http://<proxy-app>.flycast:3128`, say. */
  proxy: { url: string };
  region?: string;
  cpuKind?: "shared" | "performance";
  /** The Machines API; `https://api.machines.dev` by default. */
  apiUrl?: string;
  http?: HttpClient;
  /** How long each wait asks the API to hold, in seconds; the API's ceiling is 60. */
  waitSeconds?: number;
}

/** Where a volume is mounted in each phase's machine. */
export const FLY_WORKSPACE = "/work";

/** A machine's memory is a multiple of 256 MiB. */
export function guestMemory(memoryMb: number): number {
  return Math.max(256, Math.ceil(memoryMb / 256) * 256);
}

export interface MachineRequestInput {
  phase: Phase;
  id: string;
  image: string;
  command: readonly string[];
  env: Readonly<Record<string, string>>;
  memoryMb: number;
  cpus: number;
  cpuSeconds: number;
  volume: string;
  region?: string;
  cpuKind?: "shared" | "performance";
}

/** The body of `POST /v1/apps/{app}/machines` for one phase. */
export function machineRequest(input: MachineRequestInput): Record<string, unknown> {
  return {
    name: `invariant-${input.phase}-${input.id}`,
    ...(input.region ? { region: input.region } : {}),
    config: {
      image: input.image,
      guest: {
        cpu_kind: input.cpuKind ?? "shared",
        cpus: Math.max(1, Math.ceil(input.cpus)),
        memory_mb: guestMemory(input.memoryMb),
      },
      auto_destroy: true,
      restart: { policy: "no" },
      // `exec` replaces the image's entrypoint and command both, so nothing
      // the image names runs before or around the phase.
      init: { exec: withCpuLimit(input.command, input.cpuSeconds) },
      env: { ...input.env },
      mounts: [{ volume: input.volume, path: FLY_WORKSPACE }],
      dns: { skip_registration: true },
      metadata: {
        invariant_sandbox_run: input.id,
        invariant_sandbox_phase: input.phase,
      },
    },
  };
}

interface MachineEvent {
  type?: string;
  status?: string;
  timestamp?: number;
  request?: {
    exit_event?: { exit_code?: number; oom_killed?: boolean; signal?: number };
  };
}

/** How a machine's last exit went, from its events. */
export function exitOf(
  events: readonly MachineEvent[],
): { exitCode: number; oomKilled: boolean } | undefined {
  const exits = events
    .filter((event) => event.type === "exit" && event.request?.exit_event)
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  const exit = exits[0]?.request?.exit_event;
  if (!exit) return undefined;
  return { exitCode: exit.exit_code ?? -1, oomKilled: exit.oom_killed === true };
}

export function flySandbox(options: FlyOptions): Sandbox<FlyWorkspace> {
  const api = (options.apiUrl ?? "https://api.machines.dev").replace(/\/+$/, "");
  const http: HttpClient = options.http ?? ((url, init) => fetch(url, init));
  const waitSeconds = Math.min(60, options.waitSeconds ?? 60);

  const call = async (method: string, path: string, body?: unknown) => {
    const response = await http(`${api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: response.status, json, text };
  };

  async function runPhase(
    phase: Phase,
    request: PhaseRequest<FlyWorkspace>,
    env: Record<string, string>,
  ): Promise<PhaseResult> {
    const limits = limitsFor(phase, request.limits);
    const app = encodeURIComponent(options.apps[phase]);
    const id = runId();
    const started = Date.now();
    const created = await call(
      "POST",
      `/v1/apps/${app}/machines`,
      machineRequest({
        phase,
        id,
        image: options.image,
        command: request.command,
        env,
        memoryMb: limits.memoryMb,
        cpus: limits.cpus,
        cpuSeconds: limits.cpuSeconds,
        volume: request.workspace.volume,
        ...(options.region ? { region: options.region } : {}),
        ...(options.cpuKind ? { cpuKind: options.cpuKind } : {}),
      }),
    );
    const machine = created.json as { id?: string; instance_id?: string } | undefined;
    if (created.status >= 300 || !machine?.id) {
      throw new SandboxError(
        "driver",
        `Fly refused the ${phase} machine (${created.status}): ${created.text.slice(0, 300)}`,
        { phase },
      );
    }
    const path = `/v1/apps/${app}/machines/${encodeURIComponent(machine.id)}`;
    try {
      const until = started + limits.wallSeconds * 1000;
      let stopped = false;
      while (!stopped && Date.now() < until) {
        const left = Math.max(
          1,
          Math.min(waitSeconds, Math.ceil((until - Date.now()) / 1000)),
        );
        const query = new URLSearchParams({ state: "stopped", timeout: String(left) });
        if (machine.instance_id) query.set("instance_id", machine.instance_id);
        const waited = await call("GET", `${path}/wait?${query}`);
        if (waited.status === 200) stopped = true;
        // 408 is the wait running out, which is asked again. Anything else
        // (the machine already destroyed, say) is settled by reading it.
        else if (waited.status !== 408) break;
      }
      const read = await call("GET", path);
      const state = (read.json as { state?: string } | undefined)?.state;
      const running =
        read.status === 200 && (state === "started" || state === "starting");
      if (running && Date.now() >= until) {
        await call("POST", `${path}/stop`, { signal: "SIGKILL" });
        throw new SandboxError(
          "timeout",
          describeFailure("timeout", phase, limits, null),
          {
            phase,
          },
        );
      }
      const exit = exitOf(
        ((read.json as { events?: MachineEvent[] })?.events ?? []) as MachineEvent[],
      );
      if (!exit) {
        throw new SandboxError(
          "driver",
          `Fly did not say how the ${phase} machine exited`,
          {
            phase,
          },
        );
      }
      const outcome = outcomeOf({ exitCode: exit.exitCode, oomKilled: exit.oomKilled });
      if (outcome !== "ok") {
        throw new SandboxError(
          outcome,
          describeFailure(
            outcome as Exclude<typeof outcome, "unavailable" | "driver">,
            phase,
            limits,
            exit.exitCode,
          ),
          { phase, exitCode: exit.exitCode },
        );
      }
      return {
        phase,
        driver: "fly-machine",
        durationMs: Date.now() - started,
        output: "",
      };
    } finally {
      // auto_destroy removes a machine that exited; this removes one that
      // did not, and is a no-op on one already gone.
      await call("DELETE", `${path}?force=true`).catch(() => undefined);
    }
  }

  return {
    driver: "fly-machine",
    fetch: (request) =>
      runPhase(
        "fetch",
        request,
        phaseEnvironment("fetch", {
          proxy: options.proxy.url,
          ...(request.env ? { env: request.env } : {}),
        }),
      ),
    analyse: (request) =>
      runPhase(
        "analyse",
        request,
        phaseEnvironment("analyse", request.env ? { env: request.env } : {}),
      ),
  };
}
