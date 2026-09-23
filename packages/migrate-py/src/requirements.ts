/**
 * What an SDK's wheel says it needs, installed the same way: wheels only.
 *
 * Types need the SDK's dependencies as much as the SDK. openai's and
 * langfuse's models are pydantic models; without pydantic a model's base
 * class is unknown to the checker, and reading a field a release removed
 * from one is no error at all, because an unknown base might declare
 * anything. So the requirements a wheel's metadata lists are resolved to the
 * newest release that satisfies them and has a wheel, to a bounded depth, and
 * unpacked beside it. Nothing is built and nothing is run, and a requirement
 * that cannot be met from a wheel is left out rather than failing the SDK:
 * its types then read as unknown, which costs precision, never correctness.
 *
 * The version and marker grammar is the part of PEP 440 and PEP 508 that
 * SDKs' metadata uses: comparison operators, `~=`, wildcards, and markers on
 * the Python version, the platform and extras. The interpreter being typed
 * for is CPython 3.12 on Linux.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compareVersions, installWheel, normalizeName, releasesOf } from "./wheels.ts";

export interface Requirement {
  name: string;
  /** Comma-separated specifiers, as `>=1.9.0,<3`, or empty for any. */
  specifier: string;
  /** The environment marker after `;`, if any. */
  marker: string;
}

/** The requirements in a wheel's METADATA, as its `Requires-Dist` lines give them. */
export function requirementsOf(metadata: string): Requirement[] {
  const found: Requirement[] = [];
  for (const line of metadata.split("\n")) {
    const match =
      /^Requires-Dist:\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*\(?([^;)]*)\)?\s*(?:;\s*(.*))?$/.exec(
        line.trim(),
      );
    if (!match) continue;
    found.push({
      name: match[1] as string,
      specifier: (match[3] ?? "").trim(),
      marker: (match[4] ?? "").trim(),
    });
  }
  return found;
}

const ENVIRONMENT: Record<string, string> = {
  python_version: "3.12",
  python_full_version: "3.12.3",
  implementation_name: "cpython",
  platform_python_implementation: "CPython",
  sys_platform: "linux",
  platform_system: "Linux",
  os_name: "posix",
  platform_machine: "x86_64",
};

/**
 * Whether a marker holds for the environment above, with no extras asked
 * for. A marker this cannot read is taken to hold: installing one package too
 * many costs a download, while leaving one out costs types.
 */
export function markerHolds(marker: string): boolean {
  if (marker === "") return true;
  const orParts = splitTop(marker, "or");
  return orParts.some((part) => splitTop(part, "and").every(clauseHolds));
}

function splitTop(text: string, word: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  const pattern = new RegExp(`\\s${word}\\s`, "y");
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (depth === 0) {
      pattern.lastIndex = at;
      const hit = pattern.exec(text);
      if (hit) {
        parts.push(text.slice(start, at));
        start = at + hit[0].length;
        at = start - 1;
      }
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim());
}

function clauseHolds(clause: string): boolean {
  const inner = /^\((.*)\)$/.exec(clause);
  if (inner) return markerHolds(inner[1] as string);
  const match =
    /^(\w+|["'][^"']*["'])\s*(===|==|!=|<=|>=|<|>|~=|not in|in)\s*(\w+|["'][^"']*["'])$/.exec(
      clause,
    );
  if (!match) return true;
  const value = (token: string) =>
    /^["']/.test(token)
      ? token.slice(1, -1)
      : (ENVIRONMENT[token] ?? (token === "extra" ? "" : undefined));
  const left = value(match[1] as string);
  const right = value(match[3] as string);
  // An extra is never asked for: the SDK's optional parts are not typed.
  if ((match[1] as string) === "extra" || (match[3] as string) === "extra") return false;
  if (left === undefined || right === undefined) return true;
  const operator = match[2] as string;
  if (operator === "in") return right.includes(left);
  if (operator === "not in") return !right.includes(left);
  const versions =
    /version/.test(match[1] as string) || /version/.test(match[3] as string);
  if (!versions) {
    if (operator === "==" || operator === "===") return left === right;
    if (operator === "!=") return left !== right;
    return true;
  }
  return satisfies(left, `${operator}${right}`);
}

/** Whether `version` meets every specifier in a comma-separated list. */
export function satisfies(version: string, specifier: string): boolean {
  return specifier
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .every((part) => {
      const match = /^(===|==|!=|<=|>=|<|>|~=)\s*(.+)$/.exec(part);
      if (!match) return true;
      const operator = match[1] as string;
      const target = (match[2] as string).trim();
      if (target.endsWith(".*")) {
        const prefix = target.slice(0, -2);
        const matches = version === prefix || version.startsWith(`${prefix}.`);
        return operator === "!=" ? !matches : matches;
      }
      const order = compareVersions(version, target);
      switch (operator) {
        case "==":
        case "===":
          return order === 0;
        case "!=":
          return order !== 0;
        case "<=":
          return order <= 0;
        case ">=":
          return order >= 0;
        case "<":
          return order < 0;
        case ">":
          return order > 0;
        default: {
          // `~=1.4.5` is `>=1.4.5, ==1.4.*`.
          const parts = target.split(".");
          const prefix = parts.slice(0, Math.max(1, parts.length - 1)).join(".");
          return order >= 0 && (version === prefix || version.startsWith(`${prefix}.`));
        }
      }
    });
}

function metadataIn(site: string): string {
  for (const entry of readdirSync(site, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.endsWith(".dist-info")) {
      try {
        return readFileSync(join(site, entry.name, "METADATA"), "utf8");
      } catch {
        return "";
      }
    }
  }
  return "";
}

/**
 * The SDK at `version` and what it needs, each unpacked into its own
 * directory under `cache`, the SDK's first: the `site-packages` directories
 * a type checker is given, in order.
 */
export async function installWithDependencies(
  name: string,
  version: string,
  cache: string,
  options: { depth?: number; most?: number } = {},
): Promise<{ sites: string[]; version: string; skipped: string[] }> {
  const depth = options.depth ?? 2;
  const most = options.most ?? 40;
  const root = await installWheel(name, version, cache);
  const sites = [root.site];
  const seen = new Set([normalizeName(name)]);
  const skipped: string[] = [];
  let frontier = [root.site];
  for (let level = 0; level < depth && frontier.length > 0; level += 1) {
    const next: string[] = [];
    for (const site of frontier) {
      for (const requirement of requirementsOf(metadataIn(site))) {
        const key = normalizeName(requirement.name);
        if (seen.has(key) || !markerHolds(requirement.marker)) continue;
        seen.add(key);
        if (sites.length >= most) {
          skipped.push(requirement.name);
          continue;
        }
        try {
          const releases = (await releasesOf(requirement.name)).filter(
            (release) =>
              /^\d+(\.\d+)*$/.test(release) && satisfies(release, requirement.specifier),
          );
          const chosen = releases.at(-1);
          if (!chosen) {
            skipped.push(requirement.name);
            continue;
          }
          const installed = await installWheel(requirement.name, chosen, cache);
          sites.push(installed.site);
          next.push(installed.site);
        } catch {
          // No wheel (NoWheelError), or the index would not say: typed as
          // unknown, as the module comment says.
          skipped.push(requirement.name);
        }
      }
    }
    frontier = next;
  }
  return { sites, version: root.version, skipped };
}
