/**
 * L15, the arm that needs a release: whether every artifact of the latest one
 * carries a CycloneDX bill of materials and provenance, checked from where a
 * stranger gets it, not from the workflow that made it.
 *
 * - each npm package at its latest version: the registry's provenance
 *   attestation, and a CycloneDX bill of materials inside the tarball, naming
 *   the package it ships in (so the provenance covers it too);
 * - the action, as the bundle the v0 tag points at: a build provenance and a
 *   CycloneDX attestation from this repository, verified by `gh attestation`;
 * - the proxy image at the sidecar's latest version: the same two
 *   attestations, verified from the registry, and a keyless signature by this
 *   repository's image workflow, verified by cosign.
 *
 * Writes proving/releases/results.json, which the scoreboard reads. Needs
 * npm, git, gh (with GH_TOKEN) and cosign, and a registry login able to pull
 * the image.
 *
 *   node --import tsx proving/releases/verify.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");
const REPO = "InvariantApp/Invariant";
const IMAGE = "ghcr.io/invariantapp/sidecar";
const CYCLONEDX = "https://cyclonedx.org/bom";
const SLSA = "https://slsa.dev/provenance/v1";

export interface ReleaseArtifact {
  artifact: string;
  version: string;
  sbom: boolean;
  provenance: boolean;
  /** Only images are signed on their own; the others are signed by their attestations. */
  signed?: boolean;
  /** What failed, when anything did. */
  problem?: string;
}

export interface ReleaseResults {
  artifacts: ReleaseArtifact[];
}

const run = (command: string, args: string[], cwd = ROOT) =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });

/** Whether a command succeeds, and if not, the last line it printed about why. */
function passes(command: string, args: string[]): true | string {
  try {
    run(command, args);
    return true;
  } catch (error) {
    const { stderr, message } = error as { stderr?: string; message: string };
    return (stderr?.trim() || message).split("\n").at(-1) ?? message;
  }
}

/** The packages this repository publishes to npm, by name. */
function published(): string[] {
  const names: string[] = [];
  for (const dir of readdirSync(join(ROOT, "packages"))) {
    let manifest: { name: string; private?: boolean };
    try {
      manifest = JSON.parse(
        readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8"),
      );
    } catch {
      continue;
    }
    if (!manifest.private) names.push(manifest.name);
  }
  return names.sort();
}

function npmPackage(name: string, scratch: string): ReleaseArtifact {
  const version = run("npm", ["view", name, "dist-tags.latest"]).trim();
  const result: ReleaseArtifact = {
    artifact: name,
    version,
    sbom: false,
    provenance: false,
  };
  const attestations = run("npm", [
    "view",
    `${name}@${version}`,
    "dist.attestations",
    "--json",
  ]);
  result.provenance =
    attestations.trim() !== "" &&
    (JSON.parse(attestations) as { provenance?: { predicateType?: string } }).provenance
      ?.predicateType === SLSA;
  const dir = mkdtempSync(join(scratch, "npm-"));
  const [packed] = JSON.parse(
    run("npm", ["pack", `${name}@${version}`, "--pack-destination", dir, "--json"], dir),
  ) as { filename: string }[];
  try {
    const bom = JSON.parse(
      run("tar", ["-xzOf", join(dir, packed?.filename ?? ""), "package/sbom.cdx.json"]),
    ) as {
      bomFormat?: string;
      metadata?: { component?: { name?: string; version?: string } };
    };
    const component = bom.metadata?.component;
    result.sbom =
      bom.bomFormat === "CycloneDX" &&
      name.endsWith(`/${component?.name}`) &&
      component?.version === version;
    if (!result.sbom) result.problem = "the bill of materials names another package";
  } catch {
    result.problem = "no sbom.cdx.json in the tarball";
  }
  if (!result.provenance) result.problem = "no provenance on the registry";
  return result;
}

function action(scratch: string): ReleaseArtifact {
  const bundle = join(scratch, "main.js");
  writeFileSync(bundle, run("git", ["show", "v0:packages/action/bundle/main.js"]));
  const version = run("git", ["rev-parse", "v0^{commit}"]).trim();
  const sbom = passes("gh", [
    "attestation",
    "verify",
    bundle,
    "--repo",
    REPO,
    "--predicate-type",
    CYCLONEDX,
  ]);
  const provenance = passes("gh", ["attestation", "verify", bundle, "--repo", REPO]);
  return {
    artifact: "the action (v0)",
    version,
    sbom: sbom === true,
    provenance: provenance === true,
    ...(sbom !== true || provenance !== true
      ? { problem: [sbom, provenance].find((outcome) => outcome !== true) as string }
      : {}),
  };
}

function image(version: string): ReleaseArtifact {
  const ref = `${IMAGE}:${version}`;
  const sbom = passes("gh", [
    "attestation",
    "verify",
    `oci://${ref}`,
    "--repo",
    REPO,
    "--predicate-type",
    CYCLONEDX,
  ]);
  const provenance = passes("gh", [
    "attestation",
    "verify",
    `oci://${ref}`,
    "--repo",
    REPO,
  ]);
  const signed = passes("cosign", [
    "verify",
    ref,
    "--certificate-identity-regexp",
    `^https://github\\.com/${REPO}/\\.github/workflows/image\\.yml@`,
    "--certificate-oidc-issuer",
    "https://token.actions.githubusercontent.com",
  ]);
  const problem = [sbom, provenance, signed].find((outcome) => outcome !== true);
  return {
    artifact: IMAGE,
    version,
    sbom: sbom === true,
    provenance: provenance === true,
    signed: signed === true,
    ...(problem ? { problem: problem as string } : {}),
  };
}

if (process.argv[1]?.endsWith("verify.mts")) {
  const scratch = mkdtempSync(join(tmpdir(), "invariant-releases-"));
  try {
    run("git", ["fetch", "--force", "origin", "tag", "v0"]);
    const artifacts = published().map((name) => npmPackage(name, scratch));
    artifacts.push(action(scratch));
    const sidecar = artifacts.find(
      (entry) => entry.artifact === "@invariant-app/sidecar",
    );
    if (sidecar) artifacts.push(image(sidecar.version));
    const results: ReleaseResults = { artifacts };
    writeFileSync(
      join(ROOT, "proving/releases/results.json"),
      `${JSON.stringify(results, null, 2)}\n`,
    );
    for (const entry of artifacts) {
      console.log(
        `${entry.problem ? "MISSING" : "ok"} ${entry.artifact}@${entry.version}${entry.problem ? `: ${entry.problem}` : ""}`,
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
