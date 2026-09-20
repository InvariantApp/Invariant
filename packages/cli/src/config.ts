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
import { isJsonObject } from "@invariant/ir";
import { parse as parseYaml } from "yaml";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type GateLevel = "block" | "warn" | "allow";

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
  gate: { declaredLossy: GateLevel; unmigratableWithActiveConsumers: GateLevel };
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
    gate: {
      declaredLossy: level(gate["declaredLossy"], "declaredLossy"),
      unmigratableWithActiveConsumers: level(
        gate["unmigratableWithActiveConsumers"],
        "unmigratableWithActiveConsumers",
      ),
    },
  };
}
