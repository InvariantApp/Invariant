/**
 * The result checked against the release it moves to.
 *
 * The Changes say what the contract did, and the engine rewrites what they
 * determine. Everything else the upgrade breaks is still the consumer's
 * problem: a field the new release no longer declares because the API version
 * it speaks dropped it, a parameter a method stopped taking, a union that
 * gained a member. The type checker knows every one of them, so the consumer's
 * files are checked twice, as they were against the release they use today
 * and as the migration left them against the release they move to, and each
 * error the second check has that the first did not is shown to a person with
 * the checker's own words. An edit of the engine's that the new release
 * rejects is shown the same way.
 *
 * JavaScript is checked too, as `checkJs` would: it has the same types
 * through the SDK's declarations, and only what is new is reported, so a file
 * that was never clean under the checker costs nothing.
 */
import { join } from "node:path";
import {
  applyEdits,
  type Edit,
  groupByFile,
  type ManualSite,
  originalOffset,
} from "@invariant-app/migrate-core";
import { Project, ts } from "ts-morph";
import { within } from "./paths.ts";

/** Where a release of the SDK resolves from, as a package's dependents find it. */
export interface Release {
  /** The module name the consumer imports, `stripe` or `@slack/web-api`. */
  package: string;
  /**
   * A directory whose `node_modules` holds the release, as an install prefix
   * does: the package, and every package it depends on, resolve from there
   * exactly as they would for the consumer, `exports` conditions and all.
   */
  from: string;
}

export interface UpgradeCheck {
  repoDir: string;
  /** The consumer's files, as they were read, by path. */
  original: ReadonlyMap<string, string>;
  /** The same files after the migration's edits, where it edited them. */
  edited: ReadonlyMap<string, string>;
  /** Every edit, for placing an error in a file the edits moved back where it was read. */
  edits: readonly Edit[];
  compilerOptions: ts.CompilerOptions;
  /** The release read today, where it does not resolve through the repository itself. */
  current?: Release;
  upgraded: Release;
}

const UPGRADE = "sdk-upgrade";

/**
 * Each error the upgraded release brings to the consumer's files, as a site
 * in the file as it was read.
 */
export function upgradeBreaks(check: UpgradeCheck): ManualSite[] {
  const files = [...check.original.keys()];
  const before = diagnosticsOf(check, files, check.original, check.current);
  const now = new Map(
    files.map((file) => [
      file,
      check.edited.get(file) ?? (check.original.get(file) as string),
    ]),
  );
  const after = diagnosticsOf(check, files, now, check.upgraded);
  const byFile = groupByFile(check.edits);
  const sites: ManualSite[] = [];
  const shown = new Set<string>();
  for (const file of files) {
    const original = check.original.get(file) as string;
    const text = now.get(file) as string;
    const fresh = newErrors(
      before.get(file) ?? [],
      after.get(file) ?? [],
      original,
      text,
    );
    if (fresh.length === 0) continue;
    const flat = flatEdits(file, original, byFile.get(file) ?? []);
    const tree = ts.createSourceFile(file, original, ts.ScriptTarget.Latest, true);
    for (const diagnostic of fresh) {
      const start = originalOffset(diagnostic.start, flat);
      const end = Math.max(start, originalOffset(diagnostic.end, flat));
      const extent = statementAround(tree, start, end);
      const reason = `this no longer type-checks against the upgraded SDK: ${diagnostic.message}`;
      const key = `${file}:${extent.start}:${extent.end}:${reason}`;
      if (shown.has(key)) continue;
      shown.add(key);
      const { line, character } = tree.getLineAndCharacterOfPosition(extent.start);
      sites.push({
        file,
        line: line + 1,
        column: character + 1,
        changeId: UPGRADE,
        reason,
        snippet: original.slice(extent.start, extent.end).slice(0, 120),
        offset: extent.start,
        end: extent.end,
      });
    }
  }
  return sites;
}

interface Found {
  code: number;
  /** The checker's first line: what is wrong, and with what. */
  message: string;
  start: number;
  end: number;
}

/**
 * The errors in `after` that were not in `before`. An error is matched by its
 * code, its message and the text of its line, so one that only moved because
 * an edit above it added a line is the same error, and one on a line the
 * migration changed is new.
 */
export function newErrors(
  before: readonly Found[],
  after: readonly Found[],
  original: string,
  now: string,
): Found[] {
  const lineOf = (text: string, offset: number) => {
    const start = text.lastIndexOf("\n", offset - 1) + 1;
    const end = text.indexOf("\n", offset);
    return text.slice(start, end === -1 ? undefined : end).trim();
  };
  const keyOf = (text: string, found: Found) =>
    `${found.code}|${found.message}|${lineOf(text, found.start)}`;
  const seen = new Map<string, number>();
  for (const found of before) {
    const key = keyOf(original, found);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const fresh: Found[] = [];
  for (const found of after) {
    const key = keyOf(now, found);
    const count = seen.get(key) ?? 0;
    if (count > 0) {
      seen.set(key, count - 1);
      continue;
    }
    fresh.push(found);
  }
  return fresh;
}

/**
 * The files' errors with the SDK resolved from `release`, or through the
 * repository's own `node_modules` where none is given.
 */
function diagnosticsOf(
  check: UpgradeCheck,
  files: readonly string[],
  texts: ReadonlyMap<string, string>,
  release: Release | undefined,
): Map<string, Found[]> {
  const redirect = (name: string) =>
    release !== undefined &&
    (name === release.package || name.startsWith(`${release.package}/`));
  const project = new Project({
    compilerOptions: { ...check.compilerOptions, checkJs: true, noEmit: true },
    skipAddingFilesFromTsConfig: true,
    resolutionHost: (host, options) => {
      // One cache for the whole program, as the compiler keeps its own: a
      // monorepo's thousands of imports are each resolved once.
      const cache = ts.createModuleResolutionCache(
        host.getCurrentDirectory?.() ?? check.repoDir,
        (name) => name,
        options(),
      );
      return {
        resolveModuleNames: (names, containingFile) =>
          names.map(
            (name) =>
              ts.resolveModuleName(
                name,
                redirect(name)
                  ? join((release as Release).from, "__invariant__.ts")
                  : containingFile,
                options(),
                host,
                cache,
              ).resolvedModule,
          ),
      };
    },
  });
  // Only the files checked are added; the compiler reads what they import
  // itself, as declarations, without their being checked.
  for (const file of files) {
    project.createSourceFile(file, texts.get(file) ?? "", { overwrite: true });
  }
  const program = project.getProgram().compilerObject;
  const found = new Map<string, Found[]>();
  for (const file of files) {
    const source = program.getSourceFile(file);
    if (!source) continue;
    const diagnostics = [
      ...program.getSyntacticDiagnostics(source),
      ...program.getSemanticDiagnostics(source),
    ];
    found.set(
      file,
      diagnostics
        .filter(
          (diagnostic) =>
            diagnostic.category === ts.DiagnosticCategory.Error &&
            diagnostic.start !== undefined,
        )
        .map((diagnostic) => ({
          code: diagnostic.code,
          message: firstLine(diagnostic.messageText),
          start: diagnostic.start as number,
          end: (diagnostic.start as number) + (diagnostic.length ?? 0),
        })),
    );
  }
  return found;
}

/**
 * The checker's own words, without the chain of reasons below them: what is
 * wrong, and with what. A chain names the types it compared, which differ by
 * release even where the error is the same one.
 */
function firstLine(message: string | ts.DiagnosticMessageChain): string {
  const text = typeof message === "string" ? message : message.messageText;
  return text.split("\n")[0]?.trim() ?? "";
}

/**
 * The edits to one file as the text each wrote: an outer edit composed over
 * inner ones counts once, with what it and they made together, so an offset
 * after it moves back by exactly what changed.
 */
function flatEdits(file: string, original: string, edits: readonly Edit[]): Edit[] {
  const outer = edits.filter(
    (edit) =>
      !edits.some(
        (other) =>
          other !== edit &&
          other.start <= edit.start &&
          edit.end <= other.end &&
          (other.end - other.start > edit.end - edit.start ||
            edits.indexOf(other) < edits.indexOf(edit)),
      ),
  );
  return outer.map((edit) => {
    const inside = edits.filter(
      (other) => edit.start <= other.start && other.end <= edit.end,
    );
    const applied = applyEdits(file, original, inside);
    return {
      ...edit,
      replacement: applied.slice(
        edit.start,
        applied.length - (original.length - edit.end),
      ),
    };
  });
}

/**
 * What a reviewer is shown for an error: the statement it is in, where that
 * is one statement (a declaration, an expression, a return), and the error's
 * own span where the nearest statement holds others, as an `if` or a function
 * does, so a flag never stands for a whole block.
 */
export function statementAround(
  tree: ts.SourceFile,
  start: number,
  end: number,
): { start: number; end: number } {
  let node: ts.Node | undefined = innermost(tree, start);
  while (node && node !== tree) {
    if (
      ts.isExpressionStatement(node) ||
      ts.isVariableStatement(node) ||
      ts.isReturnStatement(node) ||
      ts.isThrowStatement(node) ||
      ts.isImportDeclaration(node) ||
      ts.isExportAssignment(node) ||
      ts.isExportDeclaration(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertySignature(node) ||
      ts.isTypeAliasDeclaration(node)
    ) {
      return {
        start: Math.min(node.getStart(tree), start),
        end: Math.max(node.getEnd(), end),
      };
    }
    if (ts.isBlock(node) || ts.isSourceFile(node) || isContainer(node)) break;
    node = node.parent;
  }
  return { start, end: Math.max(end, start) };
}

function isContainer(node: ts.Node): boolean {
  return (
    ts.isIfStatement(node) ||
    ts.isIterationStatement(node, false) ||
    ts.isSwitchStatement(node) ||
    ts.isTryStatement(node) ||
    // A function is a place of its own, apart from an arrow's single
    // expression, which is part of the statement it is written in.
    (ts.isFunctionLike(node) && !(ts.isArrowFunction(node) && !ts.isBlock(node.body))) ||
    ts.isClassLike(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isCaseClause(node) ||
    ts.isDefaultClause(node)
  );
}

function innermost(node: ts.Node, offset: number): ts.Node {
  for (const child of node.getChildren()) {
    if (child.getStart() <= offset && offset < child.getEnd()) {
      return innermost(child, offset);
    }
  }
  return node;
}

/** Whether a file is the consumer's own: inside the repository, and not a dependency. */
export function consumerFile(repoDir: string, path: string): boolean {
  return within(repoDir, path) && !/(^|\/)node_modules\//.test(path);
}
