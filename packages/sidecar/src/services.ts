/**
 * What the proxy connects to beside its upstream: the kill switch, where
 * counters go, and the heartbeat that says it is running.
 *
 * All of it is optional and none of it is in the request path. A control
 * plane that cannot be reached costs counters and fresh flags, never a
 * request: the last flags read are kept, on disk when a cache is configured,
 * and counters wait for the next attempt.
 */
import { createHash } from "node:crypto";
import { type ControlPlaneClient, createClient } from "@invariant/client";
import {
  combineFlags,
  type FlagsSource,
  flagsFrom,
  type RemoteFlagsSource,
  remoteFlags,
} from "@invariant/flags";
import {
  type OutcomeEvent,
  RUNTIME_VERSION,
  type RuntimeFlags,
  type UsageEvent,
} from "@invariant/runtime";
import {
  controlPlaneSink,
  createTelemetry,
  jsonlSink,
  type Sink,
  startHeartbeat,
  type Telemetry,
} from "@invariant/telemetry";
import { ConfigError, type SidecarConfig } from "./config.ts";

export interface Services {
  /** The runtime's flags, or nothing when no source is configured. */
  flags?: () => RuntimeFlags;
  onUsage?: (event: UsageEvent) => void;
  /** Counts every outcome, and logs each refusal and failure with its id. */
  onOutcome: (event: OutcomeEvent) => void;
  /**
   * Resolves once the first read of remote flags has finished, whatever it
   * found, so a proxy can know its kill switch before taking traffic.
   * Immediately when there is no remote source. Never rejects.
   */
  ready(): Promise<void>;
  /** Begins the heartbeat once the program is loaded, and names a reloaded one. */
  started(program: { text: string; currentLabel: string }): void;
  /** Sends what is counted and stops polling. Never rejects. */
  close(): Promise<void>;
}

export interface ServicesOptions {
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
  /** Where refusals and failures are logged, one JSON object per line. Default stdout. */
  record?: (line: string) => void;
  /** Substituted in tests. */
  fetch?: typeof fetch;
}

export function servicesFor(
  config: SidecarConfig,
  options: ServicesOptions = {},
): Services {
  const env = options.env ?? process.env;
  const log =
    options.log ?? ((message) => process.stderr.write(`invariant-sidecar: ${message}\n`));
  const record = options.record ?? ((line) => process.stdout.write(`${line}\n`));

  let client: ControlPlaneClient | undefined;
  if (config.controlPlane) {
    const token = env[config.controlPlane.tokenEnv];
    if (!token) {
      // Refused before the port opens: a proxy that silently never reports
      // is how "no traffic" and "never wired" become the same silence.
      throw new ConfigError(
        `"controlPlane.tokenEnv" names ${config.controlPlane.tokenEnv}, which is not set.`,
      );
    }
    client = createClient({
      baseUrl: config.controlPlane.url,
      token,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  const sources: FlagsSource[] = [];
  let remote: RemoteFlagsSource | undefined;
  if (config.flags?.file !== undefined || config.flags?.env !== undefined) {
    sources.push(
      flagsFrom({
        ...(config.flags.file === undefined ? {} : { path: config.flags.file }),
        ...(config.flags.env === undefined ? {} : { env: config.flags.env }),
        onError: log,
      }),
    );
  }
  if (config.flags?.remote && client) {
    remote = remoteFlags({
      client,
      pollMs: config.flags.remote.pollMs,
      ...(config.flags.remote.cache === undefined
        ? {}
        : { cachePath: config.flags.remote.cache }),
      onError: log,
    });
    sources.push(remote);
  }
  const flags = sources.length > 0 ? combineFlags(...sources) : undefined;

  const sinks: Sink[] = [];
  if (config.telemetry?.file !== undefined) sinks.push(jsonlSink(config.telemetry.file));
  if (config.telemetry?.controlPlane && client) sinks.push(controlPlaneSink(client));
  const telemetry: Telemetry | undefined =
    sinks.length > 0
      ? createTelemetry({
          sinks,
          onError: log,
          ...(config.telemetry ? { flushMs: config.telemetry.flushMs } : {}),
        })
      : undefined;

  let stopHeartbeat: (() => void) | undefined;
  let running:
    | { digest: string; currentLabel: string; compiledBy?: string; minRuntime?: string }
    | undefined;

  return {
    ...(flags ? { flags: flags.read } : {}),
    ...(telemetry ? { onUsage: telemetry.onUsage } : {}),
    onOutcome(event) {
      telemetry?.onOutcome(event);
      if (event.outcome === "adapted") return;
      // The id the caller was sent, beside what happened, so what they quote
      // can be found. Never a body or a field value.
      record(
        JSON.stringify({
          at: new Date().toISOString(),
          event: event.outcome,
          errorId: event.errorId,
          contract: event.contract,
          operation: event.operation,
          direction: event.direction,
          reason: event.reason,
        }),
      );
    },
    ready: () => remote?.refresh() ?? Promise.resolve(),
    started(program) {
      // Called again after a reload, so the heartbeat names the new program.
      const parsed = JSON.parse(program.text) as {
        compiledBy?: string;
        minRuntime?: string;
      };
      running = {
        digest: `sha256:${createHash("sha256").update(program.text).digest("hex")}`,
        currentLabel: program.currentLabel,
        ...(parsed.compiledBy === undefined ? {} : { compiledBy: parsed.compiledBy }),
        ...(parsed.minRuntime === undefined ? {} : { minRuntime: parsed.minRuntime }),
      };
      if (stopHeartbeat || !client || !config.telemetry?.controlPlane) return;
      stopHeartbeat = startHeartbeat({
        client,
        onError: log,
        describe: () => ({
          runtime: { version: RUNTIME_VERSION, binding: "proxy" },
          program: running as NonNullable<typeof running>,
          flags: {
            source: remote
              ? remote.stale()
                ? "disk"
                : "remote"
              : flags
                ? "file"
                : "none",
          },
        }),
      });
    },
    async close() {
      stopHeartbeat?.();
      remote?.close();
      await telemetry?.close();
    },
  };
}
