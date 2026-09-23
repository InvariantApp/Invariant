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
import { readFile, writeFile } from "node:fs/promises";
import {
  applyEdits,
  type Edit,
  groupByFile,
  type ManualSite,
  type MigrationPlan,
} from "@invariant-app/migrate-core";
import { type EngineResult, manualAt, runTargets, Sources } from "./engine.ts";
import { bumpPins } from "./pins.ts";
import { type Diagnostic, Pyright } from "./pyright.ts";
import { PyrightReferences } from "./references.ts";
import { statementAround, type Tree } from "./syntax.ts";

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
      after = await new PyrightReferences(checker, repoDir, now).errors(checked);
      for (const [file, diagnostics] of after) {
        if (diagnostics.length === 0) continue;
        result.manual.push(
          ...broken(
            file,
            texts.get(file) ?? "",
            now.get(file) ?? "",
            diagnostics,
            before.get(file) ?? [],
            result.edits,
            await sources.tree(file),
          ),
        );
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
    const extent = tree ? statementAround(tree, start, end) : { start, end };
    const reason = `this no longer type-checks against the upgraded SDK: ${diagnostic.message.split("\n")[0]}`;
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

/**
 * Where an offset in the edited text was before the edits: shifted back by
 * every edit wholly before it, and to the start of an edit it falls inside.
 */
export function originalOffset(offset: number, edits: readonly Edit[]): number {
  let shift = 0;
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    const replacement =
      typeof edit.replacement === "string" ? edit.replacement : edit.replacement("");
    const newStart = edit.start + shift;
    const newEnd = newStart + replacement.length;
    if (offset < newStart) break;
    if (offset < newEnd) return edit.start;
    shift += replacement.length - (edit.end - edit.start);
  }
  return offset - shift;
}
