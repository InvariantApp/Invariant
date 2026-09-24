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
 * The version of `name` a commit pinned, from the files that pin it. A pin in
 * the major version `wanted` names is taken first, as for npm, an exact one
 * over a range, then an exact pin in a later major; otherwise an exact pin
 * wins over a range. A range gives its lower bound, which is the release the
 * humans were on at least.
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
  const majorOf = (version: string) => Number(version.split(".")[0]);
  const inMajor = (list: string[]) =>
    list.find((version) => major && version.split(".")[0] === major);
  // An exact pin in a later major than the one named is what a lock
  // installed (polar's uv.lock at 11.6.0 beside `stripe>=10.12.0`); one in
  // an earlier major was left behind, and a range in the named major wins
  // over it: helm's head kept a frozen `openai==0.27.10` in requirements.txt
  // beside `openai~=1.0` in setup.cfg, and replaying it from 0.27.10 to
  // 0.27.10 found nothing.
  const later = exact.find((version) => major && majorOf(version) > Number(major));
  return inMajor(exact) ?? later ?? inMajor(bounds) ?? exact[0] ?? bounds[0];
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
 * The dotted module names an import statement in a file reaches: `from
 * app.services.billing import stripe_gateway` reaches `app.services.billing`
 * and `app.services.billing.stripe_gateway`, and a relative import is read
 * from the file's own package (`path` is relative to the repository).
 */
export function importedPaths(path: string, text: string): string[] {
  const packageOf = (dots: number) =>
    path
      .split("/")
      .slice(0, -1)
      .slice(0, Math.max(0, path.split("/").length - dots))
      .join(".");
  const found: string[] = [];
  const statement =
    /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n#]+)|^[ \t]*import[ \t]+([^\n#]+)/gm;
  for (const match of text.matchAll(statement)) {
    if (match[4] !== undefined) {
      for (const part of match[4].split(",")) {
        const name = part
          .trim()
          .split(/\s+as\s+/)[0]
          ?.trim();
        if (name && /^[\w.]+$/.test(name)) found.push(name);
      }
      continue;
    }
    const dots = (match[1] ?? "").length;
    const base =
      dots > 0 ? [packageOf(dots), match[2]].filter(Boolean).join(".") : (match[2] ?? "");
    if (!base) continue;
    found.push(base);
    for (const part of (match[3] ?? "").replace(/[()]/g, "").split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name && /^\w+$/.test(name)) found.push(`${base}.${name}`);
    }
  }
  return found;
}

/**
 * The files among `paths` that import one of `sources`, the consumer's own
 * modules that use the SDK, and write one of `names`: a webhook route that
 * never imports stripe itself, reading `data.get("subscription")` from an
 * event its billing service hands it. greensecops moved that read when
 * basil moved an invoice's subscription, in a file the replay never showed
 * the engine, since it read only the files that import the SDK.
 */
export function importersPython(
  repo: string,
  paths: readonly string[],
  sources: readonly string[],
  names: readonly string[],
): string[] {
  if (names.length === 0 || sources.length === 0) return [];
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"));
  const named = new RegExp(`\\b(?:${escaped.join("|")})\\b`);
  // Each source as a dotted name from the repository's root; an import names
  // the end of it, from wherever the project's root package starts.
  const dotted = sources.map((source) =>
    source
      .slice(repo.length + 1)
      .replace(/\.py$/, "")
      .replace(/\/__init__$/, "")
      .replaceAll("/", "."),
  );
  const given = new Set(sources);
  return paths
    .filter((path) => !given.has(join(repo, path)))
    .filter((path) => {
      let text: string;
      try {
        text = readFileSync(join(repo, path), "utf8");
      } catch {
        return false;
      }
      if (!named.test(text)) return false;
      return importedPaths(path, text).some((module) =>
        dotted.some((source) => source === module || source.endsWith(`.${module}`)),
      );
    })
    .map((path) => join(repo, path));
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
