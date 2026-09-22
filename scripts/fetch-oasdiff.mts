/**
 * Fills the oasdiff platform packages with upstream's release binaries.
 *
 * Each asset is verified against upstream's checksums.txt and the hash
 * committed in packages/diff/src/binaries.ts, and the binary for this machine
 * must then report the pinned version. See packages/diff/src/install.ts.
 *
 *   node --import tsx scripts/fetch-oasdiff.mts          every platform
 *   node --import tsx scripts/fetch-oasdiff.mts --host   this machine only
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPinnedVersion,
  binaryFor,
  installBinary,
  OASDIFF_VERSION,
  PLATFORM_BINARIES,
  RELEASE_BASE,
  upstreamChecksums,
} from "@invariant-app/diff";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const host = binaryFor();
const wanted = process.argv.includes("--host")
  ? PLATFORM_BINARIES.filter((binary) => binary === host)
  : PLATFORM_BINARIES;

const checksums = await upstreamChecksums();
for (const binary of wanted) {
  const dir = join(ROOT, "packages", binary.package.replace("@invariant-app/", ""));
  const installed = await installBinary(binary, join(dir, "bin"), checksums);
  // Upstream's licence sits at the package root, where npm looks for it.
  await writeFile(join(dir, "LICENSE"), await readFile(installed.license));
  await rm(installed.license);
  await writeFile(
    join(dir, "NOTICE"),
    `This package contains the oasdiff ${OASDIFF_VERSION} release binary,\n` +
      `unmodified, from ${RELEASE_BASE}/${binary.asset}\n` +
      `(sha256 ${installed.sha256}).\n\n` +
      "oasdiff is Copyright oasdiff contributors and licensed under the Apache\n" +
      "License, Version 2.0, included here as LICENSE.\n",
    "utf8",
  );
  if (binary === host) await assertPinnedVersion(installed.executable);
  process.stdout.write(`${binary.package}: ${binary.asset} verified\n`);
}
