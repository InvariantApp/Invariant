/**
 * Reading a provider repository's Invariant directory.
 *
 * Changes live in the provider's own repo and are merged through ordinary code
 * review, so git is the record of what was confirmed and by whom. Nothing here
 * reaches out to a network.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Change, isJsonObject, parseChange } from "@invariant-app/ir";
import { parse as parseYaml } from "yaml";

export class ChangesetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangesetError";
  }
}

export interface ReleaseManifest {
  contract: string;
  parent: string;
  /** Change ids, in the order they apply going forward. */
  changes: string[];
}

export interface ReleaseStep {
  manifest: ReleaseManifest;
  changes: Change[];
}

async function readYaml(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8");
  return parseYaml(text);
}

async function readChangeFile(path: string): Promise<Change> {
  try {
    return parseChange(await readYaml(path));
  } catch (error) {
    throw new ChangesetError(
      `${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function listYaml(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries
      .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Changes staged in a pull request and not yet part of any released contract. */
export async function loadPendingChanges(invariantDir: string): Promise<Change[]> {
  const dir = join(invariantDir, "changes");
  const files = await listYaml(dir);
  const changes = await Promise.all(files.map((name) => readChangeFile(join(dir, name))));
  assertUniqueIds(changes, dir);
  return changes;
}

function assertUniqueIds(changes: readonly Change[], where: string): void {
  const seen = new Set<string>();
  for (const change of changes) {
    if (seen.has(change.id)) {
      throw new ChangesetError(`Duplicate change id "${change.id}" in ${where}`);
    }
    seen.add(change.id);
  }
}

function parseManifest(value: unknown, path: string): ReleaseManifest {
  if (!isJsonObject(value)) throw new ChangesetError(`${path} is not an object`);
  const { contract, parent, changes } = value;
  if (typeof contract !== "string" || typeof parent !== "string") {
    throw new ChangesetError(`${path} needs string "contract" and "parent" fields`);
  }
  if (!Array.isArray(changes) || changes.some((id) => typeof id !== "string")) {
    throw new ChangesetError(`${path} needs a "changes" array of change ids`);
  }
  return { contract, parent, changes: changes as string[] };
}

/** One released contract step, with its Changes in declared order. */
export async function loadReleaseStep(
  invariantDir: string,
  label: string,
): Promise<ReleaseStep> {
  const dir = join(invariantDir, "released", label);
  const manifest = parseManifest(
    await readYaml(join(dir, "order.yaml")),
    join(dir, "order.yaml"),
  );

  const files = await listYaml(dir);
  const loaded = await Promise.all(
    files
      .filter((name) => name !== "order.yaml")
      .map((name) => readChangeFile(join(dir, name))),
  );
  assertUniqueIds(loaded, dir);

  const byId = new Map(loaded.map((change) => [change.id, change]));
  const ordered = manifest.changes.map((id) => {
    const change = byId.get(id);
    if (!change)
      throw new ChangesetError(`${dir}/order.yaml lists unknown change "${id}"`);
    return change;
  });

  const listed = new Set(manifest.changes);
  for (const change of loaded) {
    if (!listed.has(change.id)) {
      throw new ChangesetError(`${dir}/${change.id}.yaml is not listed in order.yaml`);
    }
  }

  return { manifest, changes: ordered };
}

export async function listReleasedLabels(invariantDir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(invariantDir, "released"), {
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
