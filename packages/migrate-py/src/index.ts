/**
 * Running a migration against a Python consumer.
 *
 * Nothing here executes consumer code, and nothing installs anything by
 * running it: the SDK arrives as wheels, unpacked (`wheels.ts`), and the
 * consumer's files are read as text, parsed and type-checked. The migration
 * reads the source against the release it uses today, where every name it
 * refers to still resolves, writes what the Changes determine, and then
 * checks the result against the release it is moving to.
 *
 * That last step is the verifier, and it is also the migration's widest net.
 * Anything that type-checked against the old release and does not against the
 * new one is a place the upgrade breaks, whether or not a Change named it: a
 * parameter the SDK dropped, a module it moved, an attribute it no longer
 * declares. Each is reported to a person with the checker's own words, and an
 * edit of the engine's that the checker rejects is reported the same way.
 */
import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyEdits,
  type Edit,
  groupByFile,
  type ManualSite,
  type MigrationPlan,
  originalOffset,
} from "@invariant-app/migrate-core";
import {
  type EngineResult,
  manualAt,
  runTargets,
  Sources,
  shownExtent,
} from "./engine.ts";
import { narrowedParameters } from "./narrowed.ts";
import { bumpPins } from "./pins.ts";
import { type Diagnostic, Pyright } from "./pyright.ts";
import { PyrightReferences } from "./references.ts";
import { enclosing, type Tree } from "./syntax.ts";

export { originalOffset } from "@invariant-app/migrate-core";
export { compose, manualAt, Sources } from "./engine.ts";
export { byteColumnToCharacter, LineIndex } from "./offsets.ts";
export type { Diagnostic } from "./pyright.ts";
export { Pyright } from "./pyright.ts";
export type {
  Declaration,
  ReferenceProvider,
  Span,
  Verifier,
} from "./references.ts";
export { PyrightReferences } from "./references.ts";
export * from "./requirements.ts";
export * from "./syntax.ts";
export * from "./wheels.ts";

export interface MigrateOptions {
  /** Root of the consumer repository. Nothing outside it is written. */
  repoDir: string;
  /**
   * The consumer's files to read: those that import the SDK. A file they
   * lead to, such as the settings module a pin is assigned in, is read as
   * it is reached.
   */
  sources: readonly string[];
  /** `site-packages` directories holding the release the consumer uses today. */
  packages: readonly string[];
  /**
   * The same for the release being moved to. With it, the result is checked
   * against that release and every new error is reported.
   */
  upgraded?: readonly string[];
  plan: MigrationPlan;
  /** Write the result to disk. Off by default, so a dry run stays a dry run. */
  write?: boolean;
}

export interface MigrationResult {
  edits: Edit[];
  manual: ManualSite[];
  /** New contents per file, whether or not they were written. */
  files: Map<string, string>;
  /** Errors against the old release before any edit, as `file:line rule`. */
  diagnosticsBefore: string[];
  /** Errors against the new release after the edits. */
  diagnosticsAfter: string[];
  /** Plan targets whose declaration was, or was not, found in the old release. */
  targets: { resolved: number; unresolved: number };
}

const UPGRADE = "sdk-upgrade";

export async function migrate(options: MigrateOptions): Promise<MigrationResult> {
  const repoDir = options.repoDir.replace(/\/+$/, "");
  const texts = new Map<string, string>();
  for (const file of options.sources) texts.set(file, await readFile(file, "utf8"));
  const read = [...texts.keys()];
  const sources = new Sources(texts);
  const result: EngineResult = { edits: [], manual: [] };
  let targets = { resolved: 0, unresolved: 0 };
  let before = new Map<string, Diagnostic[]>();

  // The SDK's own directory comes first; the rest are what it requires.
  const typedBefore =
    options.packages[0] !== undefined && shipsTypes(options.packages[0]);
  const server = await Pyright.start({ root: repoDir, packages: options.packages });
  try {
    for (const [file, text] of texts) await server.open(file, text);
    const references = new PyrightReferences(server, repoDir, texts);
    targets = await runTargets(references, sources, options.plan, result);
    await bumpPins(references, sources, options.plan.symbols, result);
    if (options.upgraded) before = await references.errors(read);
  } finally {
    await server.stop();
  }

  const files = new Map<string, string>();
  for (const [file, edits] of groupByFile(result.edits)) {
    if (!file.startsWith(`${repoDir}/`)) continue;
    files.set(file, applyEdits(file, texts.get(file) ?? "", edits));
  }

  let after = new Map<string, Diagnostic[]>();
  if (options.upgraded) {
    const checker = await Pyright.start({ root: repoDir, packages: options.upgraded });
    try {
      const checked = [...new Set([...read, ...files.keys()])];
      const now = new Map(
        checked.map((file) => [file, files.get(file) ?? texts.get(file) ?? ""]),
      );
      for (const [file, text] of now) await checker.open(file, text);
      const upgraded = new PyrightReferences(checker, repoDir, now);
      after = await upgraded.errors(checked);
      for (const [file, diagnostics] of after) {
        if (diagnostics.length === 0) continue;
        const fresh: Diagnostic[] = [];
        result.manual.push(
          ...broken(
            file,
            texts.get(file) ?? "",
            now.get(file) ?? "",
            diagnostics,
            before.get(file) ?? [],
            result.edits,
            await sources.tree(file),
            fresh,
            typedBefore ? () => true : breaks,
          ),
        );
        for (const diagnostic of fresh) {
          result.manual.push(
            ...(await narrowedParameters(
              upgraded,
              now,
              texts,
              file,
              diagnostic,
              result.edits,
              originalOffset,
            )),
          );
        }
      }
    } finally {
      await checker.stop();
    }
  }
  sources.dispose();

  if (options.write) {
    await Promise.all([...files].map(([file, text]) => writeFile(file, text, "utf8")));
  }
  const describe = (map: Map<string, Diagnostic[]>) =>
    [...map].flatMap(([file, diagnostics]) =>
      diagnostics.map(
        (diagnostic) =>
          `${file}:${diagnostic.range.start.line + 1} ${diagnostic.rule ?? diagnostic.code ?? "error"}`,
      ),
    );
  return {
    edits: result.edits,
    manual: result.manual,
    files,
    diagnosticsBefore: describe(before),
    diagnosticsAfter: describe(after),
    targets,
  };
}

/**
 * Whether a package ships its types for checking (PEP 561's `py.typed`).
 * stripe-python did from 7.0; before it, every object was a dictionary with
 * attributes the checker could not see.
 */
export function shipsTypes(site: string): boolean {
  try {
    return readdirSync(site, { withFileTypes: true }).some(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.endsWith(".dist-info") &&
        existsSync(join(site, entry.name, "py.typed")),
    );
  } catch {
    return false;
  }
}

/**
 * The errors that are the upgrade breaking something, rather than the SDK
 * starting to say what its types are: a name a module no longer has, an
 * import that no longer resolves, a parameter a function no longer takes,
 * a match a new value leaves incomplete.
 *
 * Across a release that first ships its types, almost every other new error
 * is the checker seeing, for the first time, that an expandable field may
 * be a string or a field may be None. okfde's froide-payment moved
 * stripe-python from 5 to 7 and had 49 of those; its authors changed none of
 * them, because at runtime nothing had changed. Across releases that were
 * both typed, every new error counts: a field that became optional there is
 * the contract saying so.
 */
export function breaks(diagnostic: Diagnostic): boolean {
  const rule = String(diagnostic.code ?? diagnostic.rule ?? "");
  if (
    ["reportCallIssue", "reportMissingImports", "reportMatchNotExhaustive"].includes(rule)
  ) {
    return true;
  }
  return (
    rule === "reportAttributeAccessIssue" &&
    /is not a known attribute of module|is unknown import symbol/.test(diagnostic.message)
  );
}

/**
 * The errors in `after` that were not in `before`, as sites in the file as it
 * was read. An error is matched by its rule, its message and the text of its
 * line, so one that only moved because an edit above it added a line is the
 * same error, and one on a line the migration changed is new.
 */
export function broken(
  file: string,
  original: string,
  now: string,
  after: readonly Diagnostic[],
  before: readonly Diagnostic[],
  edits: readonly Edit[],
  /** The file as it was read, parsed, to show each error's whole statement. */
  tree?: Tree,
  /** Collects the errors found new, for what else they point at. */
  fresh: Diagnostic[] = [],
  /** Which new errors are breaks worth a person's time (`breaks` below). */
  counts: (diagnostic: Diagnostic) => boolean = () => true,
): ManualSite[] {
  const lineOf = (text: string, line: number) => text.split("\n")[line]?.trim() ?? "";
  const keyOf = (text: string, diagnostic: Diagnostic) =>
    `${diagnostic.rule ?? diagnostic.code ?? ""}|${diagnostic.message}|${lineOf(text, diagnostic.range.start.line)}`;
  const seen = new Map<string, number>();
  for (const diagnostic of before) {
    const key = keyOf(original, diagnostic);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const mine = edits.filter((edit) => edit.file === file);
  const sites: ManualSite[] = [];
  for (const diagnostic of after) {
    const key = keyOf(now, diagnostic);
    const count = seen.get(key) ?? 0;
    if (count > 0) {
      seen.set(key, count - 1);
      continue;
    }
    if (!counts(diagnostic)) continue;
    fresh.push(diagnostic);
    const lines = now.split("\n");
    const offsetIn = (line: number, character: number) =>
      lines.slice(0, line).reduce((sum, text) => sum + text.length + 1, 0) + character;
    const start = originalOffset(
      offsetIn(diagnostic.range.start.line, diagnostic.range.start.character),
      mine,
    );
    const end = Math.max(
      start,
      originalOffset(
        offsetIn(diagnostic.range.end.line, diagnostic.range.end.character),
        mine,
      ),
    );
    // A reviewer is shown the whole statement: the checker points at one
    // argument of a call that spans lines, and the fix is to the call.
    // A match that no longer handles every value is fixed by a new case,
    // anywhere in it, so the whole match is what a reviewer is shown.
    const match =
      tree && (diagnostic.code ?? diagnostic.rule) === "reportMatchNotExhaustive"
        ? enclosing(tree, start, "match_statement")
        : undefined;
    const extent = match
      ? { start: match.startIndex, end: match.endIndex }
      : tree
        ? shownExtent(tree, original, start, end)
        : { start, end };
    // The checker's first two lines: what is wrong, and with what (the
    // value a match no longer handles, the type an argument no longer fits).
    const said = diagnostic.message
      .split("\n")
      .slice(0, 2)
      .map((line) => line.trim())
      .join(" ");
    const reason = `this no longer type-checks against the upgraded SDK: ${said}`;
    if (
      sites.some(
        (site) =>
          site.offset === extent.start &&
          site.end === extent.end &&
          site.reason === reason,
      )
    ) {
      continue;
    }
    sites.push(manualAt(file, original, extent.start, extent.end, UPGRADE, reason));
  }
  return sites;
}
