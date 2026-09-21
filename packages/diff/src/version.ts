/**
 * The one oasdiff release everything here is built and tested against.
 *
 * It used to be written in three places, as three different versions: the
 * published GitHub Action installed v1.32.1, CI installed v1.33.0-rc.1, and the
 * error a provider saw said `@latest`. v1.32.1 is the release that returns a
 * different answer on each run for documents with reference cycles (oasdiff
 * #1230), so the action a provider would actually use shipped the one version
 * this project's own CI had moved away from. Every other reference is now
 * checked against this constant by a test.
 */
export const OASDIFF_VERSION = "v1.33.0-rc.1";

/** The command that installs exactly the pinned release. */
export const OASDIFF_INSTALL = `go install github.com/oasdiff/oasdiff@${OASDIFF_VERSION}`;

interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release tag, empty for a release. */
  pre: string;
}

function parse(version: string): Semver | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim());
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ?? "",
  };
}

/** Negative when a is older than b. Only as much of semver as tags here use. */
export function compareVersions(a: string, b: string): number | undefined {
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return undefined;
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.pre === right.pre) return 0;
  // A release sorts after any of its pre-releases.
  if (left.pre === "") return 1;
  if (right.pre === "") return -1;
  return left.pre.localeCompare(right.pre, "en", { numeric: true });
}

/**
 * Why this binary must not be used, or undefined when it may be.
 *
 * `oasdiff --version` prints `oasdiff version <v>`. A binary built with
 * `go install` prints `main`, which says nothing about which release it came
 * from; that is accepted rather than refused, because refusing it would refuse
 * the install command this project itself recommends. Only a version that is
 * positively older than the pin is turned away.
 */
export function unusableVersion(versionOutput: string): string | undefined {
  const reported = versionOutput.trim().split(/\s+/).at(-1) ?? "";
  const order = compareVersions(reported, OASDIFF_VERSION);
  if (order === undefined || order >= 0) return undefined;
  return (
    `oasdiff ${reported} is older than ${OASDIFF_VERSION}, and releases before it ` +
    "can return a different answer on each run for documents with reference " +
    `cycles. Install the pinned release with "${OASDIFF_INSTALL}".`
  );
}
