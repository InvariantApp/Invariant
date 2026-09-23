/**
 * Rig E for Python: what a PyPI case needs before the engine can read it.
 *
 * Which release of the SDK the repository used on each side comes from its
 * own pins, the way the npm cases read their lockfiles: a requirements file,
 * a Poetry, uv or PDM lock, a Pipfile lock, or a manifest's requirement. A
 * bump's title can name only a major version (Renovate's "to v13"), and the
 * newest release of that major may be later than the one the humans moved to.
 *
 * The SDK is then unpacked from its wheels (`@invariant-app/migrate-py`) and
 * the engine reads only the files that import it, and what they lead to.
 * Nothing from the repository is run, and nothing is built.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compareVersions, normalizeName } from "@invariant-app/migrate-py";

/** Files a Python repository pins its dependencies in. */
export const PYTHON_PINS =
  /(^|\/)(requirements[^/]*\.(txt|in)|poetry\.lock|uv\.lock|pdm\.lock|Pipfile\.lock|pyproject\.toml|setup\.cfg|setup\.py)$/;

/**
 * The version of `name` a commit pinned, from the files that pin it. An exact
 * pin wins over a range; a range gives its lower bound, which is the release
 * the humans were on at least. Where several files pin it, the one whose major
 * version `wanted` names is taken, as for npm.
 */
export function pinnedPython(
  files: readonly { path: string; text: string }[],
  name: string,
  wanted?: string,
): string | undefined {
  const target = normalizeName(name);
  const exact: string[] = [];
  const bounds: string[] = [];
  const nameAt = (raw: string) => normalizeName(raw.replace(/\[.*\]$/, "").trim());
  for (const { path, text } of files) {
    if (/(poetry|uv|pdm)\.lock$/.test(path)) {
      for (const block of text.split(/^\[\[package\]\]$/m)) {
        const found = /^name = "([^"]+)"$/m.exec(block);
        const version = /^version = "([^"]+)"$/m.exec(block);
        if (found && version && nameAt(found[1] as string) === target) {
          exact.push(version[1] as string);
        }
      }
      continue;
    }
    if (path.endsWith("Pipfile.lock")) {
      try {
        const lock = JSON.parse(text) as Record<
          string,
          Record<string, { version?: string }>
        >;
        for (const section of ["default", "develop"]) {
          for (const [key, entry] of Object.entries(lock[section] ?? {})) {
            const version = /^==\s*(\S+)$/.exec(entry.version ?? "")?.[1];
            if (nameAt(key) === target && version) exact.push(version);
          }
        }
      } catch {
        // A lock that does not parse pins nothing.
      }
      continue;
    }
    // Requirement strings, wherever they are written: a requirements file's
    // lines, a PEP 621 list, setup.py's install_requires, setup.cfg.
    // Poetry 2 writes `"stripe (>=11.4.0,<12.0.0)"`, with the bounds in brackets.
    const requirement =
      /(?:^|["'\s,])([A-Za-z0-9][A-Za-z0-9._-]*(?:\[[^\]]*\])?)\s*\(?\s*(===|==|~=|>=|\^|~)\s*v?([0-9][0-9A-Za-z.+-]*)/gm;
    for (const match of text.matchAll(requirement)) {
      if (nameAt(match[1] as string) !== target) continue;
      (match[2] === "==" || match[2] === "===" ? exact : bounds).push(match[3] as string);
    }
    // Poetry's table form: `stripe = "^11.4.0"` or `stripe = { version = "^11" }`.
    const table = new RegExp(
      `^${name.replace(/[.*+?^${}()|[\]\\/-]/g, "[-_.]?")}\\s*=\\s*(?:\\{[^}\\n]*version\\s*=\\s*)?"[\\^~=>]*\\s*v?([0-9][0-9A-Za-z.+-]*)`,
      "gim",
    );
    for (const match of text.matchAll(table)) bounds.push(match[1] as string);
  }
  const major = wanted && /(\d+)/.exec(wanted)?.[1];
  const pick = (list: string[]) =>
    list.find((version) => major && version.split(".")[0] === major) ?? list[0];
  return pick(exact) ?? pick(bounds);
}

/**
 * The modules a wheel installs at the top of `site-packages`: what the
 * consumer writes after `import`. PyGithub installs `github`, slack-sdk
 * installs `slack_sdk`, and nothing in a package's name says so.
 */
export function topLevelModules(site: string): string[] {
  const found = new Set<string>();
  for (const entry of readdirSync(site, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.endsWith(".dist-info")) {
      const listed = join(site, entry.name, "top_level.txt");
      if (existsSync(listed)) {
        for (const line of readFileSync(listed, "utf8").split("\n")) {
          if (/^[A-Za-z_]\w*$/.test(line.trim())) found.add(line.trim());
        }
      }
      continue;
    }
    if (entry.isDirectory() && /^[A-Za-z_]\w*$/.test(entry.name)) {
      if (existsSync(join(site, entry.name, "__init__.py"))) found.add(entry.name);
      else if (readdirSync(join(site, entry.name)).some((file) => file.endsWith(".py"))) {
        // A namespace package, as `google` is.
        found.add(entry.name);
      }
    } else if (entry.isFile() && /^[A-Za-z_]\w*\.py$/.test(entry.name)) {
      found.add(entry.name.slice(0, -3));
    }
  }
  return [...found].sort();
}

/** The files among `paths` that import one of `modules`. */
export function importingPython(
  repo: string,
  paths: readonly string[],
  modules: readonly string[],
): string[] {
  if (modules.length === 0) return [];
  const names = modules.map((module) => module.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"));
  const imports = new RegExp(
    `^\\s*(?:from\\s+(?:${names.join("|")})(?:\\.[\\w.]+)?\\s+import\\b|import\\s+(?:[\\w.]+\\s*(?:as\\s+\\w+)?\\s*,\\s*)*(?:${names.join("|")})\\b)`,
    "m",
  );
  return paths
    .map((path) => join(repo, path))
    .filter((path) => {
      try {
        return imports.test(readFileSync(path, "utf8"));
      } catch {
        return false;
      }
    });
}

/**
 * The release a repository that pinned nothing had installed: the newest one
 * below the major version it was bumped to, published before the bump was
 * merged. Renovate names only the target ("to v5"), and a requirement with
 * no version installs whatever was newest, so this is the release a fresh
 * install on that day resolved to.
 */
export async function releaseBefore(
  name: string,
  to: string,
  mergedAt: string,
): Promise<string | undefined> {
  const response = await fetch(`https://pypi.org/pypi/${normalizeName(name)}/json`);
  if (!response.ok) return undefined;
  const project = (await response.json()) as {
    releases: Record<string, { upload_time_iso_8601: string; yanked?: boolean }[]>;
  };
  const major = Number(/^(\d+)/.exec(to)?.[1] ?? Number.NaN);
  const cutoff = Date.parse(mergedAt);
  const candidates = Object.entries(project.releases)
    .filter(([version, files]) => {
      if (!/^\d+(\.\d+)*$/.test(version)) return false;
      const first = files.find((file) => !file.yanked);
      return (
        first !== undefined &&
        Number(version.split(".")[0]) < major &&
        Date.parse(first.upload_time_iso_8601) < cutoff
      );
    })
    .map(([version]) => version)
    .sort(compareVersions);
  return candidates.at(-1);
}

/** The API version a stripe-python release is built for, where it records one. */
export function stripePythonVersion(site: string): string | undefined {
  for (const file of ["stripe/_api_version.py", "stripe/api_version.py"]) {
    const path = join(site, file);
    if (!existsSync(path)) continue;
    const found = /CURRENT\s*=\s*["']([^"']+)["']/.exec(readFileSync(path, "utf8"))?.[1];
    if (found) return found;
  }
  return undefined;
}
