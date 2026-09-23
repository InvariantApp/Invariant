/**
 * Where a migration may write: inside the repository it migrates, and nowhere
 * else, however a path was spelled or what the repository links to.
 *
 * Every file a migration writes is named by input someone else controls. The
 * provider names the helpers module it emits and the generated files it
 * replaces, in the symbol map it publishes; the consumer's repository decides
 * which files are source, and a repository can commit a link. The service
 * runs migrations for many consumers on one machine, so a path that leaves the
 * checkout is a write into another tenant's checkout or into the service
 * itself. Found by the threat-model tests: `helpers.emit.path` of
 * `../../outside.ts` was written wherever it pointed, and so was a source file
 * committed as a link to a file outside the repository.
 */
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class MigrationPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationPathError";
  }
}

/** Whether `path` is `root` or lies beneath it, judged on the names alone. */
export function within(root: string, path: string): boolean {
  const inside = relative(resolve(root), resolve(path));
  return inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}

/**
 * A path the migration was told to write, relative to the repository, or a
 * refusal. Absolute paths and paths that climb out are refused as written,
 * before anything is read or changed.
 */
export function repositoryPath(repoDir: string, path: string, what: string): string {
  if (isAbsolute(path) || path.includes("\0")) {
    throw new MigrationPathError(
      `${what} must be a path inside the repository, relative to it; got ${JSON.stringify(path)}`,
    );
  }
  const full = resolve(repoDir, path);
  if (!within(repoDir, full)) {
    throw new MigrationPathError(
      `${what} ${JSON.stringify(path)} leaves the repository, so it is not written`,
    );
  }
  return full;
}

/**
 * Refuses a write that would land outside the repository once links are
 * followed: the file itself when it is a link, or any directory on the way to
 * it. A file that does not exist yet is judged by the nearest directory that
 * does.
 */
export async function assertWritable(repoDir: string, path: string): Promise<void> {
  if (!within(repoDir, path)) {
    throw new MigrationPathError(`${path} is outside the repository at ${repoDir}`);
  }
  const root = await realpath(repoDir);
  let existing = path;
  for (;;) {
    try {
      await lstat(existing);
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
  }
  // A link whose target does not exist yet would be created by the write, so
  // one that cannot be followed is refused rather than judged by its name.
  const real = await realpath(existing).catch(() => undefined);
  if (real === undefined || !within(root, real)) {
    throw new MigrationPathError(
      `${path} leads outside the repository through a link, so it is not written`,
    );
  }
}
