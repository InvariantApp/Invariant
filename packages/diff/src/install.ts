/**
 * Downloading an oasdiff release binary, and refusing it unless it is the one
 * this project pinned.
 *
 * Used where no platform package is installed: the GitHub Action, which runs
 * from this repository rather than from npm, and the script that fills the
 * platform packages before they are published. Every asset has to match two
 * hashes, upstream's checksums.txt and the one committed in binaries.ts, and
 * the binary has to report the pinned version when run.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PlatformBinary } from "./binaries.ts";
import { OASDIFF_VERSION } from "./version.ts";

const run = promisify(execFile);

export const RELEASE_BASE = `https://github.com/oasdiff/oasdiff/releases/download/${OASDIFF_VERSION}`;

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallError";
  }
}

async function download(name: string): Promise<Buffer> {
  const response = await fetch(`${RELEASE_BASE}/${name}`, { redirect: "follow" });
  if (!response.ok) throw new InstallError(`${response.status} fetching ${name}`);
  return Buffer.from(await response.arrayBuffer());
}

const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Upstream's published hash for each asset of the pinned release. */
export async function upstreamChecksums(): Promise<Map<string, string>> {
  return new Map(
    (await download("checksums.txt"))
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const [hash, file] = line.trim().split(/\s+/);
        return [file as string, hash as string];
      }),
  );
}

/**
 * The asset's hash, if it matches both what upstream published and what this
 * project pinned. Either disagreeing is a refusal, and says which.
 */
export function verifyAsset(
  binary: PlatformBinary,
  bytes: Buffer,
  upstream: Map<string, string>,
): string {
  const actual = sha256(bytes);
  if (upstream.get(binary.asset) !== actual) {
    throw new InstallError(`${binary.asset} does not match upstream's checksums.txt`);
  }
  if (binary.sha256 !== actual) {
    throw new InstallError(
      `${binary.asset} hashes to ${actual}, not the ${binary.sha256} this release ` +
        "pinned. Refusing it.",
    );
  }
  return actual;
}

export interface Installed {
  /** The executable. */
  executable: string;
  /** Upstream's licence, extracted beside it. */
  license: string;
  sha256: string;
}

/**
 * Downloads one platform's asset, verifies it twice over, and extracts the
 * executable and licence into `dir`.
 */
export async function installBinary(
  binary: PlatformBinary,
  dir: string,
  checksums?: Map<string, string>,
): Promise<Installed> {
  const upstream = checksums ?? (await upstreamChecksums());
  const bytes = await download(binary.asset);
  const actual = verifyAsset(binary, bytes, upstream);

  const work = await mkdtemp(join(tmpdir(), "oasdiff-"));
  try {
    const archive = join(work, binary.asset);
    await writeFile(archive, bytes);
    await run("tar", ["-xzf", archive, "-C", work]);

    await mkdir(dir, { recursive: true });
    const executable = join(dir, binary.executable);
    await copyFile(join(work, binary.executable), executable);
    await chmod(executable, 0o755);
    const license = join(dir, "LICENSE");
    await copyFile(join(work, "LICENSE"), license);
    return { executable, license, sha256: actual };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Throws unless the binary runs and reports the pinned version. */
export async function assertPinnedVersion(executable: string): Promise<void> {
  const { stdout } = await run(executable, ["--version"]);
  const reported = stdout.trim().split(/\s+/).at(-1) ?? "";
  if (reported.replace(/^v/, "") !== OASDIFF_VERSION.replace(/^v/, "")) {
    throw new InstallError(
      `${executable} reports ${stdout.trim()}, not ${OASDIFF_VERSION}`,
    );
  }
}
