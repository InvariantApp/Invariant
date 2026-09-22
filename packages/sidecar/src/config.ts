/**
 * The sidecar's configuration, read once at startup and refused if anything in
 * it is wrong.
 *
 * Strict on purpose. This file decides which API a proxy fronts and how it
 * tells callers apart, and a typo that is quietly ignored surfaces as the wrong
 * contract served to real traffic. Unknown keys are errors, not warnings.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { IdentityStrategy } from "@invariant-app/runtime";

export interface SidecarConfig {
  /** The compiled program, from `invariant compile`. */
  program: string;
  upstream: string;
  listen: {
    port: number;
    host: string;
    /**
     * Terminate TLS here, serving HTTP/2 and HTTP/1.1 on the one port. Paths
     * to PEM files, relative to this configuration.
     */
    tls?: { certFile: string; keyFile: string };
  };
  /**
   * How a request names its contract. Absent means the program's own, which
   * `invariant compile` takes from `invariant.yaml`; set here only to serve a
   * program compiled without one.
   */
  identity?: IdentityStrategy[];
  maxBodyBytes: number;
  upstreamTimeoutMs: number;
  /** Longest a caller's whole request may take to arrive. */
  requestTimeoutMs: number;
  /** Longest a caller's request headers may take to arrive. */
  headersTimeoutMs: number;
  /** Most caller connections held at once. */
  maxConnections: number;
  healthPath: string;
  /** One JSON line per request on stdout, without bodies or query strings. */
  accessLog: boolean;
  /** Where Prometheus scrapes the proxy's counters, or null for nowhere. */
  metricsPath: string | null;
  /** Paths passed through untouched, matched as exact paths or `prefix*`. */
  skip: string[];
  /** The hosted service, for remote flags and telemetry. */
  controlPlane?: ControlPlaneConfig;
  /** Where the kill switch is read from. Absent means nothing is ever switched off. */
  flags?: FlagsConfig;
  /** Where counters go. Absent means nowhere. */
  telemetry?: TelemetryConfig;
}

export interface ControlPlaneConfig {
  url: string;
  /**
   * The environment variable holding the token. Only its name is written
   * here: a token in a configuration file is a token in a repository.
   */
  tokenEnv: string;
}

export interface FlagsConfig {
  /** A JSON file, re-read when it changes. */
  file?: string;
  /** An environment variable holding the same JSON, for a machine with no writable disk. */
  env?: string;
  /** Poll the control plane, which needs `controlPlane`. */
  remote?: {
    /** Where the last flags read are kept, so a switch survives a restart. */
    cache?: string;
    pollMs: number;
  };
}

export interface TelemetryConfig {
  /** A JSONL file, rotated by size, whose outcome lines `invariant release` reads. */
  file?: string;
  /** Send counters and a heartbeat to the control plane, which needs `controlPlane`. */
  controlPlane: boolean;
  flushMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const KEYS = new Set([
  "program",
  "upstream",
  "listen",
  "identity",
  "maxBodyBytes",
  "upstreamTimeoutMs",
  "requestTimeoutMs",
  "headersTimeoutMs",
  "maxConnections",
  "healthPath",
  "metricsPath",
  "accessLog",
  "skip",
  "controlPlane",
  "flags",
  "telemetry",
]);

export async function loadConfig(path: string): Promise<SidecarConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`Could not read ${path}: ${(error as Error).message}`);
  }
  return parseConfig(raw, dirname(resolve(path)));
}

export function parseConfig(raw: unknown, relativeTo: string): SidecarConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError("The configuration must be a JSON object.");
  }
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!KEYS.has(key)) {
      throw new ConfigError(`Unknown setting "${key}". Known: ${[...KEYS].join(", ")}.`);
    }
  }

  const program = requireString(value, "program");
  const upstream = requireString(value, "upstream");
  let parsed: URL;
  try {
    parsed = new URL(upstream);
  } catch {
    throw new ConfigError(`"upstream" is not a URL: ${upstream}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(`"upstream" must be http or https, got ${parsed.protocol}`);
  }

  const listen = (value["listen"] ?? {}) as Record<string, unknown>;
  const port = listen["port"] ?? 8080;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`"listen.port" must be an integer between 0 and 65535.`);
  }
  const host = listen["host"] ?? "127.0.0.1";
  if (typeof host !== "string") throw new ConfigError(`"listen.host" must be a string.`);
  for (const key of Object.keys(listen)) {
    if (!["port", "host", "tls"].includes(key)) {
      throw new ConfigError(`Unknown setting "listen.${key}". Known: port, host, tls.`);
    }
  }
  let tls: { certFile: string; keyFile: string } | undefined;
  if (listen["tls"] !== undefined) {
    const given = section(listen, "tls", ["certFile", "keyFile"], "listen.");
    tls = {
      certFile: resolve(relativeTo, requireString(given, "certFile", "listen.tls")),
      keyFile: resolve(relativeTo, requireString(given, "keyFile", "listen.tls")),
    };
  }

  const requestTimeoutMs = positiveInt(value, "requestTimeoutMs", 120_000);
  const headersTimeoutMs = positiveInt(value, "headersTimeoutMs", 30_000);
  if (headersTimeoutMs > requestTimeoutMs) {
    throw new ConfigError(
      `"headersTimeoutMs" (${headersTimeoutMs}) cannot be longer than "requestTimeoutMs" (${requestTimeoutMs}): the headers are part of the request.`,
    );
  }

  return {
    program: resolve(relativeTo, program),
    upstream,
    listen: { port, host, ...(tls ? { tls } : {}) },
    ...(value["identity"] === undefined
      ? {}
      : { identity: identityFrom(value["identity"]) }),
    maxBodyBytes: positiveInt(value, "maxBodyBytes", 1024 * 1024),
    upstreamTimeoutMs: positiveInt(value, "upstreamTimeoutMs", 30_000),
    requestTimeoutMs,
    headersTimeoutMs,
    maxConnections: positiveInt(value, "maxConnections", 10_000),
    healthPath: optionalPath(value, "healthPath", "/__invariant/health"),
    accessLog: optionalBoolean(value, "accessLog", false),
    metricsPath:
      value["metricsPath"] === null
        ? null
        : optionalPath(value, "metricsPath", "/__invariant/metrics"),
    skip: stringList(value, "skip"),
    ...optionalServices(value, relativeTo),
  };
}

/** The control plane, flags and telemetry sections, each checked against the others. */
function optionalServices(
  value: Record<string, unknown>,
  relativeTo: string,
): Pick<SidecarConfig, "controlPlane" | "flags" | "telemetry"> {
  const out: Pick<SidecarConfig, "controlPlane" | "flags" | "telemetry"> = {};

  if (value["controlPlane"] !== undefined) {
    const plane = section(value, "controlPlane", ["url", "tokenEnv"]);
    const url = requireString(plane, "url", "controlPlane");
    try {
      const parsed = new URL(url);
      if (
        parsed.protocol !== "https:" &&
        parsed.hostname !== "127.0.0.1" &&
        parsed.hostname !== "localhost"
      ) {
        throw new ConfigError(
          `"controlPlane.url" must be https: the token travels with every call.`,
        );
      }
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      throw new ConfigError(`"controlPlane.url" is not a URL: ${url}`);
    }
    out.controlPlane = {
      url,
      tokenEnv: requireString(plane, "tokenEnv", "controlPlane"),
    };
  }

  if (value["flags"] !== undefined) {
    const flags = section(value, "flags", ["file", "env", "remote"]);
    const config: FlagsConfig = {};
    if (flags["file"] !== undefined) {
      config.file = resolve(relativeTo, requireString(flags, "file", "flags"));
    }
    if (flags["env"] !== undefined) config.env = requireString(flags, "env", "flags");
    if (flags["remote"] !== undefined) {
      if (!out.controlPlane) {
        throw new ConfigError(
          `"flags.remote" reads from the control plane, so set "controlPlane" too.`,
        );
      }
      const remote = section(flags, "remote", ["cache", "pollMs"], "flags.");
      config.remote = {
        pollMs: positiveInt(remote, "pollMs", 15_000),
        ...(remote["cache"] === undefined
          ? {}
          : {
              cache: resolve(relativeTo, requireString(remote, "cache", "flags.remote")),
            }),
      };
    }
    out.flags = config;
  }

  if (value["telemetry"] !== undefined) {
    const telemetry = section(value, "telemetry", ["file", "controlPlane", "flushMs"]);
    const toPlane = telemetry["controlPlane"] ?? false;
    if (typeof toPlane !== "boolean") {
      throw new ConfigError(`"telemetry.controlPlane" must be true or false.`);
    }
    if (toPlane && !out.controlPlane) {
      throw new ConfigError(
        `"telemetry.controlPlane" sends to the control plane, so set "controlPlane" too.`,
      );
    }
    out.telemetry = {
      controlPlane: toPlane,
      flushMs: positiveInt(telemetry, "flushMs", 60_000),
      ...(telemetry["file"] === undefined
        ? {}
        : { file: resolve(relativeTo, requireString(telemetry, "file", "telemetry")) }),
    };
  }

  return out;
}

/** A nested object whose keys are all known. */
function section(
  value: Record<string, unknown>,
  key: string,
  known: readonly string[],
  prefix = "",
): Record<string, unknown> {
  const found = value[key];
  if (typeof found !== "object" || found === null || Array.isArray(found)) {
    throw new ConfigError(`"${prefix}${key}" must be an object.`);
  }
  for (const name of Object.keys(found)) {
    if (!known.includes(name)) {
      throw new ConfigError(
        `Unknown setting "${prefix}${key}.${name}". Known: ${known.join(", ")}.`,
      );
    }
  }
  return found as Record<string, unknown>;
}

function identityFrom(raw: unknown): IdentityStrategy[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ConfigError(
      `"identity" must list at least one strategy, ending in a default, such as ` +
        `[{"kind":"header","name":"api-version"},{"kind":"default","label":"2026-01-01"}].`,
    );
  }
  return raw.map((entry, index): IdentityStrategy => {
    const where = `identity[${index}]`;
    if (typeof entry !== "object" || entry === null) {
      throw new ConfigError(`${where} must be an object.`);
    }
    const strategy = entry as Record<string, unknown>;
    switch (strategy["kind"]) {
      case "header":
        return {
          kind: "header",
          name: requireString(strategy, "name", where).toLowerCase(),
        };
      case "urlPrefix": {
        const map = strategy["map"];
        if (typeof map !== "object" || map === null || Array.isArray(map)) {
          throw new ConfigError(
            `${where}.map must map path prefixes to contract labels.`,
          );
        }
        return { kind: "urlPrefix", map: map as Record<string, string> };
      }
      case "default":
        return { kind: "default", label: requireString(strategy, "label", where) };
      case "principal":
        // The account's pinned contract is known only after the provider has
        // authenticated the caller, and this proxy runs before the provider.
        throw new ConfigError(
          `${where}: "principal" is not available to the sidecar, which runs before ` +
            "the provider authenticates anyone. Have the SDK send a version header, " +
            "or use the in-process binding.",
        );
      default:
        throw new ConfigError(
          `${where}.kind must be "header", "urlPrefix" or "default", got ${String(strategy["kind"])}.`,
        );
    }
  });
}

function requireString(value: Record<string, unknown>, key: string, where = ""): string {
  const found = value[key];
  if (typeof found !== "string" || found === "") {
    throw new ConfigError(
      `${where ? `${where}.` : ""}"${key}" is required and must be a string.`,
    );
  }
  return found;
}

function positiveInt(
  value: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const found = value[key] ?? fallback;
  if (typeof found !== "number" || !Number.isInteger(found) || found <= 0) {
    throw new ConfigError(`"${key}" must be a positive integer.`);
  }
  return found;
}

function optionalPath(
  value: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const found = value[key] ?? fallback;
  if (typeof found !== "string" || !found.startsWith("/")) {
    throw new ConfigError(`"${key}" must be a path starting with "/".`);
  }
  return found;
}

function stringList(value: Record<string, unknown>, key: string): string[] {
  const found = value[key] ?? [];
  if (!Array.isArray(found) || found.some((entry) => typeof entry !== "string")) {
    throw new ConfigError(`"${key}" must be a list of paths.`);
  }
  return found as string[];
}

/** Matches a path against the skip list: exact, or `prefix*`. */
export function skipper(patterns: readonly string[]): (path: string) => boolean {
  return (path) =>
    patterns.some((pattern) =>
      pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern,
    );
}

function optionalBoolean(
  value: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const found = value[key];
  if (found === undefined) return fallback;
  if (typeof found !== "boolean")
    throw new ConfigError(`"${key}" must be true or false.`);
  return found;
}
