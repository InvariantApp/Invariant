/**
 * An SDK's code, as a type checker needs it, without running any of it.
 *
 * A Python package is installed by unpacking a wheel: a zip of the files that
 * land in `site-packages`, with nothing to execute. A source distribution is
 * installed by running its `setup.py` or its build backend, which is arbitrary
 * code, so one is never used here, not even as a fallback. A release that
 * publishes no wheel is refused with a typed error, and the migration says so
 * rather than building it.
 *
 * Each wheel is checked against the SHA-256 digest the index publishes for it
 * before a single file is written.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { unzipSync } from "fflate";

/** A release with no wheel: installing it would mean running its build. */
export class NoWheelError extends Error {
  constructor(name: string, version: string) {
    super(
      `${name} ${version} publishes no pure-Python wheel; a source distribution is never built`,
    );
    this.name = "NoWheelError";
  }
}

export interface WheelFile {
  filename: string;
  url: string;
  sha256: string;
}

interface ReleaseFile {
  filename: string;
  url: string;
  packagetype: string;
  digests: { sha256: string };
  yanked?: boolean;
}

const INDEX = "https://pypi.org/pypi";

/** PEP 503: the one spelling of a project's name every index agrees on. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/**
 * The wheel to unpack among a release's files: one for any platform
 * (`none-any`), since only its Python source and stubs are read. A wheel with
 * compiled parts still carries its `.py` files, so one of those is taken when
 * there is nothing else, preferring Linux on x86-64, the machine this runs on.
 */
export function pickWheel(files: readonly ReleaseFile[]): WheelFile | undefined {
  const wheels = files.filter(
    (file) => file.packagetype === "bdist_wheel" && file.filename.endsWith(".whl"),
  );
  const rank = (name: string) =>
    /-none-any\.whl$/.test(name)
      ? 0
      : /manylinux[^-]*x86_64\.whl$/.test(name)
        ? 1
        : /linux/.test(name)
          ? 2
          : 3;
  const best = [...wheels].sort((a, b) => rank(a.filename) - rank(b.filename))[0];
  return best && { filename: best.filename, url: best.url, sha256: best.digests.sha256 };
}

async function json<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  return (await response.json()) as T;
}

/** Every release of a project that publishes files, oldest first. */
export async function releasesOf(name: string): Promise<string[]> {
  const project = await json<{ releases: Record<string, ReleaseFile[]> }>(
    `${INDEX}/${normalizeName(name)}/json`,
  );
  return Object.entries(project.releases)
    .filter(([, files]) => files.some((file) => !file.yanked))
    .map(([version]) => version)
    .sort(compareVersions);
}

/**
 * Orders release numbers as PEP 440 does for the ones SDKs publish: numeric
 * parts first, and a pre-release before its final release.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const match = /^v?(\d+(?:\.\d+)*)(.*)$/.exec(version.trim());
    const numbers = (match?.[1] ?? "0").split(".").map(Number);
    return { numbers, rest: match?.[2] ?? "" };
  };
  const left = parse(a);
  const right = parse(b);
  for (let at = 0; at < Math.max(left.numbers.length, right.numbers.length); at += 1) {
    const difference = (left.numbers[at] ?? 0) - (right.numbers[at] ?? 0);
    if (difference !== 0) return difference;
  }
  if (left.rest === right.rest) return 0;
  // `13.0.0` is after `13.0.0b1`; `.post1` is after both.
  const weight = (rest: string) => (rest === "" ? 1 : /^\.?post/.test(rest) ? 2 : 0);
  return weight(left.rest) - weight(right.rest) || left.rest.localeCompare(right.rest);
}

/**
 * The release a loose requirement means: `13` or `13.x` is the newest 13,
 * `==11.4.0` is itself, and an exact number that exists is taken as it is.
 */
export function resolveVersion(
  wanted: string,
  releases: readonly string[],
): string | undefined {
  const spec = wanted.trim().replace(/^[=v]+/, "");
  if (releases.includes(spec)) return spec;
  // `5.4.*` and a `5.4.` cut short of its wildcard both mean the newest 5.4.
  const prefix = spec
    .replace(/(\.[x*])+$/, "")
    .replace(/\.+$/, "")
    .replace(/\.0+$/, "");
  const finals = releases.filter((release) => /^\d+(\.\d+)*$/.test(release));
  const matching = finals.filter(
    (release) => release === prefix || release.startsWith(`${prefix}.`),
  );
  return matching.at(-1);
}

/**
 * Unpacks `files` from a wheel into `site`, as an installer would: the
 * package's own directories at the top, and a `.data/purelib` or `platlib`
 * directory's contents moved up beside them. Nothing else from `.data`
 * (scripts, headers) is written, and no path may leave `site`.
 */
export async function unpackWheel(bytes: Uint8Array, site: string): Promise<string[]> {
  const entries = unzipSync(bytes);
  const written: string[] = [];
  for (const [name, content] of Object.entries(entries)) {
    if (name.endsWith("/")) continue;
    let relative = name;
    const data = /^[^/]+\.data\/(purelib|platlib|[^/]+)\/(.*)$/.exec(name);
    if (data) {
      if (data[1] !== "purelib" && data[1] !== "platlib") continue;
      relative = data[2] as string;
    }
    const target = normalize(join(site, relative));
    if (!target.startsWith(`${normalize(site)}${sep}`)) {
      throw new Error(`the wheel writes outside site-packages: ${name}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    written.push(relative);
  }
  return written;
}

/**
 * The release `version` of `name`, unpacked once into `cache` and reused.
 * Returns the `site-packages` directory that holds it.
 */
export async function installWheel(
  name: string,
  version: string,
  cache: string,
): Promise<{ site: string; version: string; wheel: string }> {
  const releases = await releasesOf(name);
  const exact = resolveVersion(version, releases);
  if (!exact) throw new Error(`${name} has no release matching ${version}`);
  const site = join(cache, `${normalizeName(name)}-${exact}`, "site-packages");
  const marker = join(dirname(site), "wheel");
  if (existsSync(marker)) return { site, version: exact, wheel: marker };

  const release = await json<{ urls: ReleaseFile[] }>(
    `${INDEX}/${normalizeName(name)}/${exact}/json`,
  );
  const wheel = pickWheel(release.urls);
  if (!wheel) throw new NoWheelError(name, exact);
  const response = await fetch(wheel.url);
  if (!response.ok) throw new Error(`${response.status} for ${wheel.url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== wheel.sha256) {
    throw new Error(`${wheel.filename} does not match the digest the index publishes`);
  }
  // Unpacked beside its final place and moved there whole, so a run that
  // stops halfway never leaves a directory a later run takes as complete.
  const staging = `${dirname(site)}.partial`;
  await rm(staging, { recursive: true, force: true });
  await unpackWheel(bytes, join(staging, "site-packages"));
  await writeFile(join(staging, "wheel"), `${wheel.filename}\n`);
  await rm(dirname(site), { recursive: true, force: true });
  await mkdir(dirname(dirname(site)), { recursive: true });
  await rename(staging, dirname(site));
  return { site, version: exact, wheel: wheel.filename };
}
