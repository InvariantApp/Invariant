/**
 * The provider's `invariant.yaml`.
 *
 * Everything the tool needs lives in the provider's repository: which contracts
 * are still served, where each one's specification comes from, and what the
 * release gate blocks on. Nothing is fetched, so `invariant check` gives the
 * same answer on a laptop with no network as it does in CI.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isJsonObject, type JsonValue } from "@invariant/ir";
import { parse as parseYaml } from "yaml";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type GateLevel = "block" | "warn" | "allow";

/**
 * How to stand up a build, so the differential check has something to compare.
 *
 * `${contract}` in the environment is replaced with the contract label being
 * built, which is how one command serves every historical build. Without this
 * section the release is still checked, but only against the specifications;
 * the report says so rather than implying more was proved than was.
 */
export interface BuildConfig {
  command: string;
  args: string[];
  /** Environment for the current build. */
  headEnv: Record<string, string>;
  /** Environment for a historical build, before `${contract}` is filled in. */
  baseEnv: Record<string, string>;
  /** Path that returns 200 once the server is ready. */
  healthPath: string;
}

export interface InvariantConfig {
  /** Directory the configuration was loaded from. */
  root: string;
  api: string;
  /** Absolute path to the current contract's specification. */
  currentSpec: string;
  /** Label to absolute specification path, for every contract still served. */
  releasedSpecs: Map<string, string>;
  /** Where Changes live, absolute. */
  invariantDir: string;
  /** The header a caller uses to declare its contract, if the provider has one. */
  contractHeader: string | undefined;
  build: BuildConfig | undefined;
  gate: { declaredLossy: GateLevel; unmigratableWithActiveConsumers: GateLevel };
}

function env(value: JsonValue | undefined): Record<string, string> {
  if (!isJsonObject(value)) return {};
  const out: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[name] = entry;
    else if (typeof entry === "number" || typeof entry === "boolean") {
      out[name] = String(entry);
    }
  }
  return out;
}

/** Splits a shell-ish command into a program and its arguments. */
function words(command: string): { command: string; args: string[] } {
  const parts = command.trim().split(/\s+/);
  return { command: parts[0] ?? "", args: parts.slice(1) };
}

function buildFrom(raw: JsonValue | undefined): BuildConfig | undefined {
  if (!isJsonObject(raw)) return undefined;
  const head = raw["head"];
  const base = raw["base"];
  if (!isJsonObject(head) || typeof head["command"] !== "string") return undefined;

  const { command, args } = words(head["command"]);
  return {
    command,
    args,
    headEnv: env(head["env"]),
    baseEnv: isJsonObject(base) ? env(base["env"]) : {},
    healthPath: typeof raw["healthPath"] === "string" ? raw["healthPath"] : "/__health",
  };
}

/** The first header strategy, which is what the differential check sets. */
function headerStrategy(raw: JsonValue | undefined): string | undefined {
  if (!Array.isArray(raw)) return undefined;
  for (const entry of raw) {
    if (
      isJsonObject(entry) &&
      entry["kind"] === "header" &&
      typeof entry["name"] === "string"
    ) {
      return entry["name"];
    }
  }
  return undefined;
}

function level(value: unknown, field: string): GateLevel {
  if (value === undefined) return "warn";
  if (value === "block" || value === "warn" || value === "allow") return value;
  throw new ConfigError(`gate.${field} must be block, warn or allow`);
}

export async function loadConfig(path: string): Promise<InvariantConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new ConfigError(`No configuration at ${path}. Run "invariant init" first.`);
  }

  const parsed: unknown = parseYaml(text);
  if (!isJsonObject(parsed)) throw new ConfigError(`${path} is not a mapping`);

  const root = dirname(resolve(path));
  const api = parsed["api"];
  if (typeof api !== "string") throw new ConfigError(`${path} needs an "api" name`);

  const spec = parsed["spec"];
  if (!isJsonObject(spec) || typeof spec["current"] !== "string") {
    throw new ConfigError(`${path} needs spec.current`);
  }

  const released = new Map<string, string>();
  const releasedSpecs = spec["released"];
  if (isJsonObject(releasedSpecs)) {
    for (const [label, file] of Object.entries(releasedSpecs)) {
      if (typeof file !== "string") {
        throw new ConfigError(`spec.released.${label} must be a path`);
      }
      released.set(label, resolve(root, file));
    }
  }

  const gate = isJsonObject(parsed["gate"]) ? parsed["gate"] : {};

  return {
    root,
    api,
    currentSpec: resolve(root, spec["current"]),
    releasedSpecs: released,
    invariantDir: resolve(root, "invariant"),
    contractHeader: headerStrategy(parsed["identity"]),
    build: buildFrom(parsed["build"]),
    gate: {
      declaredLossy: level(gate["declaredLossy"], "declaredLossy"),
      unmigratableWithActiveConsumers: level(
        gate["unmigratableWithActiveConsumers"],
        "unmigratableWithActiveConsumers",
      ),
    },
  };
}
