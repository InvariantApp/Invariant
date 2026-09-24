/**
 * Fills the oasdiff platform packages with upstream's release binaries.
 *
 * Each asset is verified against upstream's checksums.txt and the hash
 * committed in packages/diff/src/binaries.ts, and the binary for this machine
 * must then report the pinned version. See packages/diff/src/install.ts.
 *
 * Beside it goes the package's CycloneDX bill of materials, as every other
 * package gets one from scripts/prepack.mjs: here the one thing it carries,
 * upstream's binary, by version, source and hash, so the tarball's provenance
 * covers what is inside it.
 *
 *   node --import tsx scripts/fetch-oasdiff.mts          every platform
 *   node --import tsx scripts/fetch-oasdiff.mts --host   this machine only
 */
import { createHash, randomUUID } from "node:crypto";
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
  const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
    name: string;
    version: string;
    description: string;
  };
  await writeFile(
    join(dir, "sbom.cdx.json"),
    `${JSON.stringify(
      billOfMaterials(
        manifest,
        binary.asset,
        createHash("sha256")
          .update(await readFile(installed.executable))
          .digest("hex"),
      ),
      null,
      2,
    )}\n`,
    "utf8",
  );
  if (binary === host) await assertPinnedVersion(installed.executable);
  process.stdout.write(`${binary.package}: ${binary.asset} verified\n`);
}

/** A platform package's bill of materials: the package, and the binary in it. */
function billOfMaterials(
  manifest: { name: string; version: string; description: string },
  asset: string,
  executableSha256: string,
) {
  const [group, name] = manifest.name.split("/") as [string, string];
  const self = `pkg:npm/${encodeURIComponent(group)}/${name}@${manifest.version}`;
  const upstream = `pkg:golang/github.com/oasdiff/oasdiff@${OASDIFF_VERSION}`;
  const apache = [{ license: { id: "Apache-2.0" } }];
  return {
    $schema: "http://cyclonedx.org/schema/bom-1.6.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      lifecycles: [{ phase: "build" }],
      component: {
        type: "library",
        name,
        version: manifest.version,
        group,
        purl: self,
        "bom-ref": self,
        licenses: apache,
        description: manifest.description,
      },
    },
    components: [
      {
        type: "application",
        name: "oasdiff",
        version: OASDIFF_VERSION,
        purl: upstream,
        "bom-ref": upstream,
        licenses: apache,
        hashes: [{ alg: "SHA-256", content: executableSha256 }],
        externalReferences: [
          { type: "distribution", url: `${RELEASE_BASE}/${asset}` },
          { type: "vcs", url: "https://github.com/oasdiff/oasdiff" },
        ],
      },
    ],
    dependencies: [
      { ref: self, dependsOn: [upstream] },
      { ref: upstream, dependsOn: [] },
    ],
  };
}
