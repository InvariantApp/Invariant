/**
 * Fills the oasdiff platform packages with upstream's release binaries.
 *
 * Every asset is checked against upstream's checksums.txt and against the hash
 * committed in packages/diff/src/binaries.ts, and refused if either disagrees.
 * The binary for this machine is then run, and must report the pinned version.
 *
 *   node --import tsx scripts/fetch-oasdiff.mts          every platform
 *   node --import tsx scripts/fetch-oasdiff.mts --host   this machine only
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { binaryFor, OASDIFF_VERSION, PLATFORM_BINARIES } from "@invariant/diff";

const run = promisify(execFile);
const ROOT = new URL("..", import.meta.url).pathname;
const BASE = `https://github.com/oasdiff/oasdiff/releases/download/${OASDIFF_VERSION}`;

async function download(name: string): Promise<Buffer> {
  const response = await fetch(`${BASE}/${name}`, { redirect: "follow" });
  if (!response.ok) throw new Error(`${response.status} fetching ${name}`);
  return Buffer.from(await response.arrayBuffer());
}

const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

const upstream = new Map(
  (await download("checksums.txt"))
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const [hash, file] = line.trim().split(/\s+/);
      return [file as string, hash as string];
    }),
);

const host = binaryFor();
const wanted = process.argv.includes("--host")
  ? PLATFORM_BINARIES.filter((binary) => binary === host)
  : PLATFORM_BINARIES;

for (const binary of wanted) {
  const bytes = await download(binary.asset);
  const actual = sha256(bytes);
  if (upstream.get(binary.asset) !== actual) {
    throw new Error(`${binary.asset} does not match upstream's checksums.txt`);
  }
  if (binary.sha256 !== actual) {
    throw new Error(
      `${binary.asset} hashes to ${actual}, not the ${binary.sha256} committed in ` +
        "packages/diff/src/binaries.ts. Refusing it.",
    );
  }

  const work = await mkdtemp(join(tmpdir(), "oasdiff-"));
  try {
    const archive = join(work, binary.asset);
    await writeFile(archive, bytes);
    await run("tar", ["-xzf", archive, "-C", work]);

    const dir = join(ROOT, "packages", binary.package.replace("@invariant/", ""));
    await mkdir(join(dir, "bin"), { recursive: true });
    const target = join(dir, "bin", binary.executable);
    await copyFile(join(work, binary.executable), target);
    await chmod(target, 0o755);
    await copyFile(join(work, "LICENSE"), join(dir, "LICENSE"));
    await writeFile(
      join(dir, "NOTICE"),
      `This package contains the oasdiff ${OASDIFF_VERSION} release binary,\n` +
        `unmodified, from ${BASE}/${binary.asset}\n` +
        `(sha256 ${actual}).\n\n` +
        "oasdiff is Copyright oasdiff contributors and licensed under the Apache\n" +
        "License, Version 2.0, included here as LICENSE.\n",
      "utf8",
    );
    process.stdout.write(`${binary.package}: ${binary.asset} verified\n`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (host && wanted.includes(host)) {
  const dir = join(ROOT, "packages", host.package.replace("@invariant/", ""));
  const { stdout } = await run(join(dir, "bin", host.executable), ["--version"]);
  const reported = stdout.trim().split(/\s+/).at(-1);
  if (reported?.replace(/^v/, "") !== OASDIFF_VERSION.replace(/^v/, "")) {
    throw new Error(`the binary reports ${stdout.trim()}, not ${OASDIFF_VERSION}`);
  }
  process.stdout.write(`${host.package} runs and reports ${OASDIFF_VERSION}\n`);
}
