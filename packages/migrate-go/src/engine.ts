/**
 * Running a migration against a consumer's Go module.
 *
 * Three passes, each through the Go helper. The first reads the consumer
 * against the release it compiles with today and finds every reference to
 * the SDK by the object it resolves to. The edits that follow from the plan
 * are then made as exact byte ranges: the import path moved to the new major
 * version, and each identifier the plan renames. The last pass type-checks
 * the edited files against the new release, with go.mod moved to it in a
 * copy, and everything that still does not compile is shown to a person,
 * together with everything the error reaches: where the value a call no
 * longer takes was made, and the consumer's own wrappers that pass it on.
 *
 * Nothing the consumer wrote is executed, and the consumer's go.mod is not
 * touched unless the result is written.
 */
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyEdits,
  type Edit,
  groupByFile,
  type ManualSite,
  Offsets,
} from "@invariant-app/migrate-core";
import { askHelper, type GoOptions, goCommand } from "./helper.ts";
import type { GoMigrationPlan, GoRole } from "./plan.ts";
import { type GoSymbol, symbolId } from "./surface.ts";

/** One reference to the SDK, as the helper reports it (byte offsets). */
export interface GoReference extends GoSymbol {
  file: string;
  start: number;
  end: number;
  line: number;
  kind: string;
  role: GoRole;
  spanStart: number;
  spanEnd: number;
  json?: string;
}

export interface GoImport {
  file: string;
  start: number;
  end: number;
  line: number;
  path: string;
}

export interface GoSpan {
  file: string;
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  why: "error" | "argument" | "signature" | "interface" | "caller";
}

export interface GoDiagnostic {
  file: string;
  offset: number;
  line: number;
  column: number;
  message: string;
  spans?: GoSpan[];
}

interface RefsResponse {
  files: string[];
  imports: GoImport[];
  references: GoReference[];
  diagnostics: GoDiagnostic[];
  errors?: string[];
}

interface DiagnoseResponse {
  diagnostics: GoDiagnostic[];
  errors?: string[];
}

export interface GoMigrateOptions {
  /** The repository: nothing outside it is edited or reported. */
  repoDir: string;
  /** The consumer's module, where its go.mod is. */
  moduleDir: string;
  /** Packages to read, as the go command takes them from `moduleDir`. */
  packages: readonly string[];
  plan: GoMigrationPlan;
  /** Read test files too. On by default: tests call the SDK as much as anything. */
  tests?: boolean;
  /** Type-check the result against the new release. On by default. */
  verify?: boolean;
  /** Write the edited files, go.mod and go.sum. Off by default. */
  write?: boolean;
  go?: GoOptions;
}

export interface GoMigrationResult {
  edits: Edit[];
  manual: ManualSite[];
  /** New contents per file, whether or not they were written. */
  files: Map<string, string>;
  /** What did not compile before, against the release the consumer had. */
  diagnosticsBefore: GoDiagnostic[];
  /** What does not compile after the edits, against the new release. */
  diagnosticsAfter: GoDiagnostic[];
  /** go.mod and go.sum moved to the new release, when it was checked. */
  goMod?: { mod: string; sum: string };
  /** Problems loading met that are not type errors. */
  errors: string[];
  /**
   * Why the result could not be checked against the new release, when it
   * could not: kyma-project/test-infra requires a module only its company's
   * own server has, so the new release's module graph cannot be resolved
   * through the proxy. The edits and the Changes' flags still stand; what
   * only the check would have found is not there.
   */
  unverified?: string;
}

const firstLine = (text: string) => text.split("\n")[0] ?? text;

/** Line starts of a text, as string indices. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

/** A diagnostic's identity across the two checks, which name the module differently. */
function diagnosticKey(diagnostic: GoDiagnostic, plan: GoMigrationPlan): string {
  const message = diagnostic.message
    .split(plan.symbols.upgradeTo.path)
    .join(plan.symbols.module.path);
  return `${diagnostic.file}:${diagnostic.line}:${message}`;
}

export async function migrate(options: GoMigrateOptions): Promise<GoMigrationResult> {
  const { plan } = options;
  const tests = options.tests ?? true;
  const from = plan.symbols.module.path;
  const to = plan.symbols.upgradeTo.path;
  const refs = await askHelper<RefsResponse>(
    {
      command: "refs",
      dir: options.moduleDir,
      packages: options.packages,
      targets: [from],
      within: options.repoDir,
      tests,
    },
    options.go,
  );

  const texts = new Map<string, string>();
  const offsets = new Map<string, Offsets>();
  const textOf = async (file: string) => {
    let text = texts.get(file);
    if (text === undefined) {
      text = await readFile(file, "utf8");
      texts.set(file, text);
      offsets.set(file, new Offsets(text));
    }
    return text;
  };
  const indexOf = (file: string, byte: number) =>
    (offsets.get(file) as Offsets).toIndex(byte);

  const edits: Edit[] = [];
  if (to !== from) {
    for (const imported of refs.imports) {
      await textOf(imported.file);
      edits.push({
        file: imported.file,
        start: indexOf(imported.file, imported.start),
        end: indexOf(imported.file, imported.end),
        replacement: JSON.stringify(`${to}${imported.path.slice(from.length)}`),
        changeId: "sdk-upgrade",
        author: "codemod",
        reason: `moved to ${to} ${plan.symbols.upgradeTo.version}`,
      });
    }
  }

  const renames = new Map(plan.renames.map((rename) => [symbolId(rename.from), rename]));
  const manual: ManualSite[] = [];
  const site = (
    file: string,
    start: number,
    end: number,
    changeId: string,
    reason: string,
  ): ManualSite => {
    const text = texts.get(file) as string;
    const before = text.slice(0, start);
    const line = before.split("\n").length;
    return {
      file,
      line,
      column: start - before.lastIndexOf("\n"),
      changeId,
      reason,
      snippet: text.slice(start, Math.min(end, start + 120)),
      offset: start,
      end,
    };
  };
  for (const reference of refs.references) {
    const rename = renames.get(symbolId(reference));
    if (rename) {
      await textOf(reference.file);
      edits.push({
        file: reference.file,
        start: indexOf(reference.file, reference.start),
        end: indexOf(reference.file, reference.end),
        replacement: rename.to,
        changeId: rename.changeId,
        author: "codemod",
        reason: rename.reason,
      });
    }
    for (const flag of plan.flags) {
      if (symbolId(flag.symbol) !== symbolId(reference)) continue;
      if (flag.roles && !flag.roles.includes(reference.role)) continue;
      await textOf(reference.file);
      manual.push(
        site(
          reference.file,
          indexOf(reference.file, reference.spanStart),
          indexOf(reference.file, reference.spanEnd),
          flag.changeId,
          flag.reason,
        ),
      );
    }
  }

  const files = new Map<string, string>();
  for (const [file, fileEdits] of groupByFile(edits)) {
    files.set(file, applyEdits(file, await textOf(file), fileEdits));
  }
  await formatEdited(files, texts, options.go);

  const result: GoMigrationResult = {
    edits,
    manual,
    files,
    diagnosticsBefore: refs.diagnostics,
    diagnosticsAfter: [],
    errors: refs.errors ?? [],
  };
  if (options.verify !== false) {
    await verify(options, result, textOf).catch((error: unknown) => {
      result.unverified = firstLine(
        error instanceof Error ? error.message : String(error),
      );
    });
  }
  result.manual = unique(result.manual);

  if (options.write) {
    await Promise.all([...files].map(([file, text]) => writeFile(file, text, "utf8")));
    if (result.goMod) {
      await writeFile(join(options.moduleDir, "go.mod"), result.goMod.mod, "utf8");
      await writeFile(join(options.moduleDir, "go.sum"), result.goMod.sum, "utf8");
    }
  }
  return result;
}

/**
 * gofmt over each edited file whose original gofmt left as it was. Renaming a
 * key in a composite literal realigns the values beside it; a file that was
 * never formatted is left as its authors keep it.
 */
async function formatEdited(
  files: Map<string, string>,
  originals: Map<string, string>,
  options: GoOptions | undefined,
): Promise<void> {
  if (files.size === 0) return;
  const paths = [...files.keys()];
  const formatted = await askHelper<{ path: string; text: string; error?: string }[]>(
    {
      command: "format",
      files: paths.flatMap((path) => [
        { path, text: originals.get(path) ?? "" },
        { path, text: files.get(path) ?? "" },
      ]),
    },
    options,
  );
  paths.forEach((path, index) => {
    const original = formatted[2 * index];
    const edited = formatted[2 * index + 1];
    if (!original || !edited || original.error || edited.error) return;
    if (original.text !== originals.get(path)) return;
    files.set(path, edited.text);
  });
}

/**
 * Type-checks the edited files against the new release, with go.mod moved
 * to it in a copy, and reports what does not compile that did before.
 */
async function verify(
  options: GoMigrateOptions,
  result: GoMigrationResult,
  textOf: (file: string) => Promise<string>,
): Promise<void> {
  const { plan } = options;
  const scratch = await mkdtemp(join(tmpdir(), "invariant-go-"));
  try {
    const modfile = join(scratch, "go.mod");
    await copyFile(join(options.moduleDir, "go.mod"), modfile);
    await copyFile(join(options.moduleDir, "go.sum"), join(scratch, "go.sum")).catch(() =>
      writeFile(join(scratch, "go.sum"), ""),
    );
    const upgrade = plan.symbols.upgradeTo;
    await goCommand(
      ["get", `-modfile=${modfile}`, `${upgrade.path}@${upgrade.version}`],
      options.moduleDir,
      options.go,
    );
    result.goMod = {
      mod: await readFile(modfile, "utf8"),
      sum: await readFile(join(scratch, "go.sum"), "utf8"),
    };
    const checked = await askHelper<DiagnoseResponse>(
      {
        command: "diagnose",
        dir: options.moduleDir,
        packages: options.packages,
        targets: [upgrade.path],
        within: options.repoDir,
        tests: options.tests ?? true,
        overlay: Object.fromEntries(result.files),
        buildFlags: [`-modfile=${modfile}`],
        replaced: Object.fromEntries(
          (plan.surface?.replacements ?? []).map((replacement) => [
            `${replacement.from.package}:${replacement.from.key}`,
            replacement.params,
          ]),
        ),
      },
      options.go,
    );
    result.diagnosticsAfter = checked.diagnostics;
    result.errors.push(...(checked.errors ?? []));
    const known = new Set(
      result.diagnosticsBefore.map((diagnostic) => diagnosticKey(diagnostic, plan)),
    );
    for (const diagnostic of checked.diagnostics) {
      if (known.has(diagnosticKey(diagnostic, plan))) continue;
      for (const span of diagnostic.spans ?? []) {
        const manual = await spanSite(span, diagnostic, result, plan, textOf);
        if (manual) result.manual.push(manual);
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const WHY: Record<GoSpan["why"], string> = {
  error: "does not compile against",
  argument: "makes a value a call no longer takes from",
  signature: "passes on a value a call no longer takes from",
  interface: "declares a method whose implementation has to change for",
  caller: "calls a function whose parameters have to change for",
};

/**
 * A span of the edited text as a site in the text as it was. The edits
 * change no line breaks (an import path and an identifier are each one
 * line), so a line of one is the same line of the other.
 */
async function spanSite(
  span: GoSpan,
  diagnostic: GoDiagnostic,
  result: GoMigrationResult,
  plan: GoMigrationPlan,
  textOf: (file: string) => Promise<string>,
): Promise<ManualSite | undefined> {
  const original = await textOf(span.file);
  const edited = result.files.get(span.file) ?? original;
  const starts = lineStarts(original);
  if (lineStarts(edited).length !== starts.length) return undefined;
  const editedOffsets = new Offsets(edited);
  const startIndex = editedOffsets.toIndex(span.start);
  const endIndex = editedOffsets.toIndex(span.end);
  const editedStarts = lineStarts(edited);
  const lineStart = starts[span.startLine - 1] ?? 0;
  const column = startIndex - (editedStarts[span.startLine - 1] ?? 0);
  const offset = Math.min(lineStart + column, original.length);
  const endLineStart = starts[span.endLine - 1] ?? 0;
  const endColumn = endIndex - (editedStarts[span.endLine - 1] ?? 0);
  const end = Math.min(endLineStart + endColumn, original.length);
  const upgrade = `${plan.symbols.upgradeTo.path} ${plan.symbols.upgradeTo.version}`;
  // What replaced a method the error says is gone, where the SDK says.
  const replaced = (plan.surface?.replacements ?? []).find((replacement) =>
    firstLine(diagnostic.message).includes(
      `.${replacement.from.key.split(".").at(-1)} undefined`,
    ),
  );
  const reason =
    (span.why === "error"
      ? `${WHY.error} ${upgrade}: ${firstLine(diagnostic.message)}`
      : `${WHY[span.why]} ${upgrade} (${firstLine(diagnostic.message)})`) +
    (replaced ? `; ${replaced.reason}` : "");
  return {
    file: span.file,
    line: span.startLine,
    column: column + 1,
    changeId: "sdk-upgrade",
    reason,
    snippet: original.slice(offset, Math.min(end, offset + 120)),
    offset,
    end,
  };
}

function unique(sites: readonly ManualSite[]): ManualSite[] {
  const seen = new Set<string>();
  return sites.filter((site) => {
    const key = `${site.file}:${site.offset}:${site.end ?? site.offset}:${site.changeId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
