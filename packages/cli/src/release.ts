/**
 * `invariant release`: turning a merged pull request into a published contract.
 *
 * Everything this does is a consequence of things that already happened. The
 * Changes were reviewed and merged by a person, which is the confirmation; the
 * gate already proved they explain the release; the compiler already produced
 * the program. Release mints a label, moves the pending Changes into the
 * released step so the next diff starts from the right place, and signs one
 * object that says all of it.
 *
 * It refuses to run on anything the gate did not pass, and it refuses to run
 * twice. A release is the moment a contract becomes something other people
 * depend on, so it has to be the same every time it is described.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type BundleSource,
  buildBundle,
  type EvolutionBundle,
  openBundle,
  reproduces,
  signBundle,
} from "@invariant/bundle";
import {
  listReleasedLabels,
  loadContract,
  loadPendingChanges,
} from "@invariant/contract";
import type { Change } from "@invariant/ir";
import { type Evidence, inputsDigest } from "@invariant/verifier";
import { stringify as stringifyYaml } from "yaml";
import { type CheckReport, check } from "./check.ts";
import type { InvariantConfig } from "./config.ts";

export class ReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseError";
  }
}

export interface ReleaseOptions {
  /** Where the signing key is, as PEM. Read from the environment in CI. */
  signingKeyPem?: string;
  /** Repository and commit this release came from. */
  source: BundleSource;
  /** Work out what would happen without writing anything. */
  dryRun?: boolean;
  /** Start the real builds during the check. */
  full?: boolean;
}

export interface ReleaseResult {
  label: string;
  digest: string;
  bundle: EvolutionBundle;
  /** Files that were written, or would be. */
  wrote: string[];
  report: CheckReport;
}

/**
 * The label a contract gets.
 *
 * A date, because that is what every provider who has done this uses and what
 * a consumer pinning to one can reason about. Two releases on one day get a
 * suffix rather than silently overwriting each other.
 */
export function mintLabel(today: string, taken: readonly string[]): string {
  if (!taken.includes(today)) return today;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${today}.${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
  throw new ReleaseError(`${today} already has 99 releases, which cannot be right`);
}

export async function release(
  config: InvariantConfig,
  options: ReleaseOptions,
): Promise<ReleaseResult> {
  const pending = await loadPendingChanges(config.invariantDir);
  if (pending.length === 0) {
    throw new ReleaseError(
      "there are no pending Changes, so this release has nothing to describe. " +
        "An additive-only release advances the current contract in place.",
    );
  }

  const report = await check(config, { ...(options.full ? { full: true } : {}) });
  if (report.result === "block") {
    throw new ReleaseError(
      "the release gate blocked this release, so it cannot be published.\n" +
        [...report.steps.flatMap((step) => step.unexplained), ...report.problems]
          .map((line) => `  - ${line}`)
          .join("\n"),
    );
  }
  if (!report.program) {
    throw new ReleaseError("the gate passed but compiled no program, which is a bug");
  }

  const released = await listReleasedLabels(config.invariantDir);
  // Minted from the clock here and only here. A release is the one moment that
  // genuinely happens on a particular day; a build is not.
  const label = mintLabel(new Date().toISOString().slice(0, 10), released);

  const parent = released[released.length - 1];
  if (!parent) {
    throw new ReleaseError(
      "there is no released contract to release from. Run `invariant init` first.",
    );
  }

  const parentSpec = config.releasedSpecs.get(parent);
  if (!parentSpec) {
    throw new ReleaseError(`no specification on disk for the current contract ${parent}`);
  }

  const { bundle, digest } = buildBundle({
    api: config.api,
    from: { label: parent, digest: await digestOfSpec(parentSpec) },
    to: { label, digest: report.current.digest },
    source: options.source,
    changes: pending,
    evidence: [...report.evidence, ...confirmations(pending, options.source)],
    program: report.program,
    gate: {
      result: report.result,
      unexplained: report.steps.flatMap((step) => step.unexplained),
    },
  });

  const stepDir = join(config.invariantDir, "released", label);
  const bundleDir = join(config.invariantDir, "bundles");
  const specPath = join(config.root, "invariant", "contracts", `${label}.openapi.json`);

  const wrote = [
    ...pending.map((change) => join(stepDir, `${change.id}.yaml`)),
    join(stepDir, "order.yaml"),
    specPath,
    join(bundleDir, `${label}.dsse.json`),
  ];

  if (options.dryRun) return { label, digest, bundle, wrote, report };

  if (!options.signingKeyPem) {
    throw new ReleaseError(
      "a release has to be signed. Set INVARIANT_SIGNING_KEY to an ed25519 " +
        "private key in PEM form, or pass --dry-run to see what would happen.",
    );
  }
  const envelope = signBundle(bundle, digest, options.signingKeyPem);

  // Written before anything is moved, so a failure part way through leaves the
  // pending Changes where they were rather than in a half-released state.
  await mkdir(stepDir, { recursive: true });
  await mkdir(bundleDir, { recursive: true });
  await mkdir(join(config.root, "invariant", "contracts"), { recursive: true });

  await writeFile(specPath, await readFile(config.currentSpec, "utf8"), "utf8");
  await writeFile(
    join(bundleDir, `${label}.dsse.json`),
    `${JSON.stringify(envelope, null, 2)}\n`,
    "utf8",
  );

  const changesDir = join(config.invariantDir, "changes");
  for (const change of pending) {
    const from = await findChangeFile(changesDir, change.id);
    await rename(from, join(stepDir, `${change.id}.yaml`));
  }

  await writeFile(
    join(stepDir, "order.yaml"),
    // Quoted, because a contract label looks exactly like a date. This file is
    // read back by this tool and potentially by others, and a YAML 1.1 parser
    // would hand them a timestamp where a string was promised.
    stringifyYaml(
      {
        contract: label,
        parent,
        changes: pending.map((change) => change.id),
      },
      { defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN" },
    ),
    "utf8",
  );

  return { label, digest, bundle, wrote, report };
}

/**
 * E8: a person with write access merged it.
 *
 * The weakest-looking record in the list and in some ways the most important.
 * Every other kind says a machine checked something; this one says a human who
 * could have said no did not. A Change carrying no confirmation is recorded as
 * unconfirmed rather than left out, because a missing record and a passing one
 * must not look the same to whoever reads the bundle.
 */
function confirmations(changes: readonly Change[], source: BundleSource): Evidence[] {
  return changes.map((change) => {
    const confirmed = change.provenance?.confirmed_by;
    return {
      kind: "E8-merge" as const,
      subject: change.id,
      result: confirmed ? ("pass" as const) : ("skipped" as const),
      inputsDigest: inputsDigest(change),
      tool: "git",
      summary: confirmed
        ? `merged in ${confirmed.commit.slice(0, 7)}` +
          (confirmed.reviewer ? ` by ${confirmed.reviewer}` : "") +
          `, released from ${source.repo}@${source.commit.slice(0, 7)}`
        : "this Change carries no record of who merged it, so nobody is " +
          "recorded as having confirmed it",
    };
  });
}

async function digestOfSpec(path: string): Promise<string> {
  return (await loadContract(path, "parent")).digest;
}

async function findChangeFile(dir: string, id: string): Promise<string> {
  for (const extension of ["yaml", "yml"]) {
    const candidate = join(dir, `${id}.${extension}`);
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch {
      // Try the other extension.
    }
  }
  throw new ReleaseError(`could not find the file that declares ${id}`);
}

/**
 * Checks a published bundle against the repository it claims to come from.
 *
 * What anyone holding the repository can run for themselves. A registry
 * cannot: it never has the specifications a rebuild needs. A signature proves
 * who sent it; rebuilding proves it describes the release it says it does.
 * Neither one substitutes for the other.
 */
export async function verifyRelease(
  envelopePath: string,
  trustedPublicKeysPem: readonly string[],
  rebuild?: () => Promise<EvolutionBundle>,
): Promise<{
  bundle: EvolutionBundle;
  digest: string;
  keyid: string;
  reproduced: boolean;
}> {
  const envelope = JSON.parse(await readFile(envelopePath, "utf8")) as Parameters<
    typeof openBundle
  >[0];
  const opened = openBundle(envelope, trustedPublicKeysPem);

  if (!rebuild) return { ...opened, reproduced: false };

  const result = reproduces(opened.bundle, await rebuild());
  if (!result.same) {
    throw new ReleaseError(
      `this bundle does not match a rebuild from source. Differs in: ${result.differences.join(", ")}`,
    );
  }
  return { ...opened, reproduced: true };
}

export function renderRelease(result: ReleaseResult, dryRun: boolean): string {
  const lines: string[] = [];
  lines.push(
    dryRun
      ? `Would release contract ${result.label}`
      : `Released contract ${result.label}`,
    "",
    `  bundle    ${result.digest}`,
    `  from      ${result.bundle.from.label} (${result.bundle.from.digest.slice(0, 19)})`,
    `  to        ${result.bundle.to.label} (${result.bundle.to.digest.slice(0, 19)})`,
    `  changes   ${result.bundle.changes.length}`,
    `  evidence  ${result.bundle.evidence.length} records, ${result.bundle.evidence.filter((entry) => entry.result === "pass").length} passing`,
    "",
    dryRun ? "Would write:" : "Wrote:",
  );
  for (const path of result.wrote) lines.push(`  ${path}`);

  if (dryRun) {
    lines.push(
      "",
      "Nothing was written. Set INVARIANT_SIGNING_KEY and run without --dry-run",
      "to sign and publish.",
    );
  }

  return lines.join("\n");
}
