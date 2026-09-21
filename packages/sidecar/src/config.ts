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
import type { IdentityStrategy } from "@invariant/runtime";

export interface SidecarConfig {
  /** The compiled program, from `invariant compile`. */
  program: string;
  upstream: string;
  listen: { port: number; host: string };
  identity: IdentityStrategy[];
  maxBodyBytes: number;
  upstreamTimeoutMs: number;
  healthPath: string;
  /** Paths passed through untouched, matched as exact paths or `prefix*`. */
  skip: string[];
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
  "healthPath",
  "skip",
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

  return {
    program: resolve(relativeTo, program),
    upstream,
    listen: { port, host },
    identity: identityFrom(value["identity"]),
    maxBodyBytes: positiveInt(value, "maxBodyBytes", 1024 * 1024),
    upstreamTimeoutMs: positiveInt(value, "upstreamTimeoutMs", 30_000),
    healthPath: optionalPath(value, "healthPath", "/__invariant/health"),
    skip: stringList(value, "skip"),
  };
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
