/**
 * Puts the licence, the notice and a bill of materials beside a package as it
 * is packed.
 *
 * npm only ever ships a LICENSE from the package's own directory. Keeping
 * fourteen copies in the repository would be fourteen chances for one to
 * differ from the others, so they are copied from the root at pack time and
 * ignored by git.
 *
 * The bill of materials is CycloneDX, of what the package depends on at run
 * time, from the lockfile, so it names the exact versions a consumer resolves
 * alongside it. Inside the tarball it is covered by the tarball's provenance.
 */
import { execFileSync } from "node:child_process";
import { copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath rather than URL.pathname, which on Windows yields "/D:/..." and
// then "D:\D:\..." once joined.
const root = fileURLToPath(new URL("..", import.meta.url));
for (const name of ["LICENSE", "NOTICE"]) {
  await copyFile(join(root, name), join(process.cwd(), name));
}

const { name } = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
execFileSync(
  "pnpm",
  [
    "--dir",
    root,
    "sbom",
    "--sbom-format",
    "cyclonedx",
    "--prod",
    "--lockfile-only",
    "--filter",
    name,
    "--out",
    join(process.cwd(), "sbom.cdx.json"),
  ],
  { stdio: ["ignore", "ignore", "inherit"], shell: process.platform === "win32" },
);
