/**
 * The provider's `invariant.yaml`.
 *
 * Everything the tool needs lives in the provider's repository: which contracts
 * are still served, where each one's specification comes from, and what the
 * release gate blocks on. Nothing is fetched, so `invariant check` gives the
 * same answer on a laptop with no network as it does in CI.
 */
import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { type IdentityStrategy, isJsonObject, type JsonValue } from "@invariant/ir";
import { parse as parseYaml } from "yaml";

const execShell = promisify(exec);

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
  /**
   * Where a released contract's build comes from, when it is not the current
   * code started with the base environment. Keyed by contract label.
   */
  contracts: Map<string, BuildSource>;
}

/**
 * One released contract's build, stood up the way the provider can: an
 * environment already running, the image that was released, or the commit it
 * was released from, installed and started beside the repository.
 */
export type BuildSource =
  | { kind: "url"; url: string }
  | { kind: "image"; image: string; port: number; env: Record<string, string> }
  | {
      kind: "worktree";
      ref: string;
      install: { command: string; args: string[] } | undefined;
      command: string;
      args: string[];
      env: Record<string, string>;
    };

export interface InvariantConfig {
  /** The configuration file itself, which a release edits. */
  path: string;
  /** Directory the configuration was loaded from. */
  root: string;
  api: string;
  /** Absolute path to the current contract's specification. */
  currentSpec: string;
  /**
   * What the contract being built is called, before it is released.
   *
   * Left out, this falls back to today's date, and that makes the compiled
   * program depend on the day it was built: the same commit produces a
   * different artifact tomorrow, which is exactly the property bundles are
   * signed to rule out. A provider who pins it here gets a build that depends
   * only on their repository.
   */
  currentLabel: string | undefined;
  /** Label to absolute specification path, for every contract still served. */
  releasedSpecs: Map<string, string>;
  /** Where Changes live, absolute. */
  invariantDir: string;
  /** The header a caller uses to declare its contract, if the provider has one. */
  contractHeader: string | undefined;
  /**
   * Scenarios made from each released contract's own document: for a
   * contract with none written by hand (`missing`, the default), beside them
   * (`always`), or not at all (`never`), with headers every request carries.
   */
  scenarios: {
    generate: "missing" | "always" | "never";
    headers: Record<string, string>;
  };
  /**
   * How a request names its contract, compiled into the program so every
   * binding and the proxy read this one declaration.
   */
  identity: IdentityStrategy[] | undefined;
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

function buildFrom(raw: JsonValue | undefined, path: string): BuildConfig | undefined {
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
    contracts: sourcesFrom(raw["contracts"], path),
  };
}

function scenariosFrom(
  raw: JsonValue | undefined,
  path: string,
): InvariantConfig["scenarios"] {
  if (raw === undefined) return { generate: "missing", headers: {} };
  if (!isJsonObject(raw)) throw new ConfigError(`${path}: scenarios must be a mapping`);
  for (const key of Object.keys(raw)) {
    if (key !== "generate" && key !== "headers") {
      throw new ConfigError(
        `${path}: scenarios.${key} is not a setting (generate, headers)`,
      );
    }
  }
  const generate = raw["generate"] ?? "missing";
  if (generate !== "missing" && generate !== "always" && generate !== "never") {
    throw new ConfigError(`${path}: scenarios.generate must be missing, always or never`);
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(env(raw["headers"]))) {
    headers[name.toLowerCase()] = value;
  }
  return { generate, headers };
}

/** `build.contracts`: each released contract's own source, checked here. */
function sourcesFrom(raw: JsonValue | undefined, path: string): Map<string, BuildSource> {
  const sources = new Map<string, BuildSource>();
  if (raw === undefined) return sources;
  if (!isJsonObject(raw)) {
    throw new ConfigError(
      `${path}: build.contracts must map contract labels to a source`,
    );
  }
  for (const [label, entry] of Object.entries(raw)) {
    const where = `${path}: build.contracts.${label}`;
    if (!isJsonObject(entry)) throw new ConfigError(`${where} must be an object`);
    const kinds = ["url", "image", "worktree"].filter(
      (kind) => entry[kind] !== undefined,
    );
    if (kinds.length !== 1) {
      throw new ConfigError(`${where} must name exactly one of url, image or worktree`);
    }
    const text = (key: string): string => {
      const value = entry[key];
      if (typeof value !== "string" || value.trim() === "") {
        throw new ConfigError(`${where}.${key} must be a non-empty string`);
      }
      return value;
    };
    const allowed: Record<string, string[]> = {
      url: ["url"],
      image: ["image", "port", "env"],
      worktree: ["worktree", "install", "command", "env"],
    };
    const kind = kinds[0] as string;
    for (const key of Object.keys(entry)) {
      if (!allowed[kind]?.includes(key)) {
        throw new ConfigError(
          `${where}.${key} is not a setting of ${kind === "image" ? "an" : "a"} ${kind} source`,
        );
      }
    }
    if (kind === "url") {
      const url = text("url");
      if (!/^https?:\/\//.test(url))
        throw new ConfigError(`${where}.url must be http or https`);
      sources.set(label, { kind: "url", url: url.replace(/\/$/, "") });
    } else if (kind === "image") {
      const port = entry["port"] ?? 8080;
      if (
        typeof port !== "number" ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
      ) {
        throw new ConfigError(`${where}.port must be the port the image listens on`);
      }
      sources.set(label, {
        kind: "image",
        image: text("image"),
        port,
        env: env(entry["env"]),
      });
    } else {
      sources.set(label, {
        kind: "worktree",
        ref: text("worktree"),
        install: entry["install"] === undefined ? undefined : words(text("install")),
        ...words(text("command")),
        env: env(entry["env"]),
      });
    }
  }
  return sources;
}

/** The first header strategy, which is what the differential check sets. */
/**
 * The identity strategies, as the program carries them: checked here, where a
 * mistake names a line in `invariant.yaml`, rather than at a runtime's start.
 * A strategy's `description` is for whoever reads the file and is left out.
 */
function identityFrom(
  raw: JsonValue | undefined,
  path: string,
): IdentityStrategy[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ConfigError(`${path}: identity must list at least one strategy`);
  }
  return raw.map((entry, index): IdentityStrategy => {
    const where = `${path}: identity[${index}]`;
    if (!isJsonObject(entry)) throw new ConfigError(`${where} must be an object`);
    const text = (key: string) => {
      const value = entry[key];
      if (typeof value !== "string" || value === "") {
        throw new ConfigError(`${where}.${key} must be a non-empty string`);
      }
      return value;
    };
    switch (entry["kind"]) {
      case "header":
        return { kind: "header", name: text("name").toLowerCase() };
      case "urlPrefix": {
        const map = entry["map"];
        if (
          !isJsonObject(map) ||
          Object.values(map).some((label) => typeof label !== "string")
        ) {
          throw new ConfigError(`${where}.map must map path prefixes to contract labels`);
        }
        return { kind: "urlPrefix", map: map as Record<string, string> };
      }
      case "principal":
        return { kind: "principal" };
      case "default":
        return { kind: "default", label: text("label") };
      default:
        throw new ConfigError(
          `${where}.kind must be header, urlPrefix, principal or default, got ${String(entry["kind"])}`,
        );
    }
  });
}

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

/**
 * Where the current contract's specification comes from.
 *
 * A path, for a provider who writes OpenAPI and commits it. Or a command, for
 * a provider whose specification is generated from their code, which is most
 * of them.
 *
 * The command matters more than it looks. The likeliest thing this tool will
 * ever tell a code-first provider is that their document does not describe
 * their service, and by far the commonest reason is that they changed a
 * handler and did not regenerate. Running the generator here means the gate is
 * always reading what the code says right now, so that failure stops being a
 * first impression and starts being a real finding.
 */
async function currentSpecOf(
  raw: JsonValue | undefined,
  root: string,
  path: string,
): Promise<string> {
  if (typeof raw === "string") return resolve(root, raw);
  if (!isJsonObject(raw) || typeof raw["command"] !== "string") {
    throw new ConfigError(`${path} needs spec.current`);
  }
  if (typeof raw["out"] !== "string") {
    throw new ConfigError(
      `${path}: spec.current.command needs an "out" saying which file it writes`,
    );
  }

  const out = resolve(root, raw["out"]);
  try {
    // Through the shell, as the provider wrote it. Generators are usually run
    // with a redirect or through a package script, and splitting on spaces
    // broke both. The command comes from the provider's own repository and
    // runs in their own CI, so nothing here widens what can run.
    await execShell(raw["command"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    // Their generator failing is their problem to fix, but a gate that reported
    // it as a stale specification would send them looking in the wrong place.
    throw new ConfigError(
      `spec.current.command failed: ${raw["command"]}\n` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!existsSync(out)) {
    throw new ConfigError(
      `spec.current.command ran but wrote no ${raw["out"]}. Check that "out" names the file it produces.`,
    );
  }
  return out;
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
  if (!isJsonObject(spec)) throw new ConfigError(`${path} needs spec.current`);
  const currentSpec = await currentSpecOf(spec["current"], root, path);

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
    path: resolve(path),
    root,
    api,
    currentSpec,
    currentLabel:
      typeof spec["currentLabel"] === "string" ? spec["currentLabel"] : undefined,
    releasedSpecs: released,
    invariantDir: resolve(root, "invariant"),
    contractHeader: headerStrategy(parsed["identity"]),
    scenarios: scenariosFrom(parsed["scenarios"], path),
    identity: identityFrom(parsed["identity"], path),
    build: buildFrom(parsed["build"], path),
    gate: {
      declaredLossy: level(gate["declaredLossy"], "declaredLossy"),
      unmigratableWithActiveConsumers: level(
        gate["unmigratableWithActiveConsumers"],
        "unmigratableWithActiveConsumers",
      ),
    },
  };
}
