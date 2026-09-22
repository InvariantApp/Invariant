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
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import {
  type BundleSource,
  buildBundle,
  type EvolutionBundle,
  openBundle,
  reproduces,
  signBundle,
} from "@invariant-app/bundle";
import {
  listReleasedLabels,
  loadContract,
  loadPendingChanges,
  standaloneText,
} from "@invariant-app/contract";
import type { Change } from "@invariant-app/ir";
import { type Evidence, inputsDigest } from "@invariant-app/verifier";
import { isMap, parseDocument, type Scalar, stringify as stringifyYaml } from "yaml";
import { type CheckReport, check } from "./check.ts";
import { type InvariantConfig, loadConfig } from "./config.ts";

const runGit = promisify(execFile);

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
  // The name the provider gave the contract being built, which is the name the
  // compiled program already uses for it. Minting a different one here would
  // publish a bundle naming a contract the program calls something else, and a
  // caller sending the published label would be told no such contract exists.
  // Only when there is no name is one minted, from the clock, here and only
  // here: a release is the one moment that genuinely happens on a given day.
  const label =
    config.currentLabel ?? mintLabel(new Date().toISOString().slice(0, 10), released);
  if (released.includes(label) || config.releasedSpecs.has(label)) {
    throw new ReleaseError(
      `${label} is already released. Set spec.currentLabel to the name of the ` +
        "contract this release builds.",
    );
  }

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

  await writeFile(specPath, await standaloneText(config.currentSpec), "utf8");
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

  await recordRelease(config.path, label, relative(config.root, specPath));

  return { label, digest, bundle, wrote, report };
}

/**
 * Adds the released contract to invariant.yaml, as the one now being served.
 *
 * Without this the next check compared the previous contract to head with no
 * Changes pending, and blocked on everything this release had just explained.
 * Edited through the YAML document rather than as text, so the provider's
 * comments and layout survive, and with the label quoted because it looks
 * exactly like a date.
 */
async function recordRelease(
  configPath: string,
  label: string,
  spec: string,
): Promise<void> {
  const document = parseDocument(await readFile(configPath, "utf8"));
  const key = document.createNode(label) as Scalar;
  key.type = "QUOTE_DOUBLE";

  const released = document.getIn(["spec", "released"]);
  if (isMap(released)) {
    released.set(key, spec);
  } else {
    document.setIn(["spec", "released"], document.createNode({ [label]: spec }));
  }

  // The contract just released is what head is until the next breaking
  // change names a new one, so the name stays and stays quoted.
  const current = document.createNode(label) as Scalar;
  current.type = "QUOTE_DOUBLE";
  document.setIn(["spec", "currentLabel"], current);

  await writeFile(configPath, document.toString(), "utf8");
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
  rebuild?: (bundle: EvolutionBundle) => Promise<EvolutionBundle>,
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

  const result = reproduces(opened.bundle, await rebuild(opened.bundle));
  if (!result.same) {
    throw new ReleaseError(
      `this bundle does not match a rebuild from source. Differs in: ${result.differences.join(", ")}`,
    );
  }
  return { ...opened, reproduced: true };
}

/**
 * Rebuilds a published bundle from the repository at the commit it names.
 *
 * The release ran on that commit with the Changes still pending, so checking
 * it out in a separate worktree and releasing again without writing anything
 * has to produce the same object. The worktree is always removed, and the
 * checkout the provider is working in is never touched.
 */
export async function rebuildAt(
  repository: string,
  configPath: string,
  bundle: EvolutionBundle,
): Promise<EvolutionBundle> {
  const worktree = await mkdtemp(join(tmpdir(), "invariant-rebuild-"));
  try {
    await git(repository, [
      "worktree",
      "add",
      "--detach",
      worktree,
      bundle.source.commit,
    ]);
    const config = await loadConfig(join(worktree, relative(repository, configPath)));
    // The layers that need running builds are reproduced only if the release
    // ran them: a rebuild that did less than the release would not match, and
    // one that did more would be proving something else.
    const full = bundle.evidence.some(
      (entry) =>
        (entry.kind === "E6-differential" || entry.kind === "E7-conformance") &&
        entry.result !== "skipped",
    );
    const rebuilt = await release(config, {
      dryRun: true,
      source: bundle.source,
      ...(full ? { full: true } : {}),
    });
    return rebuilt.bundle;
  } finally {
    await git(repository, ["worktree", "remove", "--force", worktree]).catch(
      () => undefined,
    );
    await rm(worktree, { recursive: true, force: true });
  }
}

async function git(cwd: string, args: string[]): Promise<void> {
  try {
    await runGit("git", args, { cwd });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new ReleaseError(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
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
