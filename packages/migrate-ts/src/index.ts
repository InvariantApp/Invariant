/**
 * Running a migration against a consumer repository.
 *
 * Nothing in here executes consumer code. The repository is loaded for its
 * types, edited as text, and type-checked; installing it or running its tests
 * would mean executing whatever its dependencies feel like running, which is
 * not a thing to do on someone else's behalf.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Node, Project, type SourceFile } from "ts-morph";
import { applyEdits, type Edit, groupByFile } from "./edits.ts";
import {
  type EditScope,
  type EngineResult,
  editable,
  type ManualSite,
  runEngine,
} from "./engine.ts";
import { buildPlan, type MigrationPlan, type SymbolMap } from "./plan.ts";

export * from "./edits.ts";
export type { ManualSite } from "./engine.ts";
export * from "./plan.ts";

export interface MigrateOptions {
  /** Root of the consumer repository. */
  repoDir: string;
  /** Root of the SDK sources, so the engine never edits the SDK itself. */
  sdkDir: string;
  tsConfigFilePath: string;
  plan: MigrationPlan;
  /** Write the result to disk. Off by default, so a dry run stays a dry run. */
  write?: boolean;
}

export interface MigrationResult {
  edits: Edit[];
  manual: ManualSite[];
  /** New contents per file, whether or not they were written. */
  files: Map<string, string>;
  diagnosticsBefore: string[];
  diagnosticsAfter: string[];
}

function declarationsIn(source: SourceFile, name: string) {
  return source.getInterface(name) ?? source.getClass(name) ?? source.getTypeAlias(name);
}

/** `client.charges.create` becomes `client.payments.create`. */
function renameAccessors(
  project: Project,
  plan: MigrationPlan,
  scope: EditScope,
  result: EngineResult,
): void {
  const { sdkDir } = scope;
  for (const rename of plan.accessorRenames) {
    const [fromHead] = rename.from;
    const [toHead] = rename.to;
    if (!fromHead || !toHead || fromHead === toHead) continue;

    for (const source of project.getSourceFiles()) {
      if (!source.getFilePath().startsWith(sdkDir)) continue;
      for (const declaration of source.getClasses()) {
        const property = declaration.getProperty(fromHead);
        if (!property) continue;
        for (const node of property.findReferencesAsNodes()) {
          if (!editable(node, scope)) continue;
          result.edits.push({
            file: node.getSourceFile().getFilePath(),
            start: node.getStart(),
            end: node.getEnd(),
            replacement: toHead,
            changeId: rename.changeId,
            author: "codemod",
            reason: `the ${fromHead} resource is now ${toHead}`,
          });
        }
      }
    }
  }
}

/** `Charge` becomes `Payment` wherever the consumer named the type. */
function renameTypes(
  project: Project,
  plan: MigrationPlan,
  scope: EditScope,
  result: EngineResult,
): void {
  const { sdkDir } = scope;
  for (const [schema, typeName] of Object.entries(plan.symbols.types)) {
    if (schema === typeName) continue;
    for (const source of project.getSourceFiles()) {
      if (!source.getFilePath().startsWith(sdkDir)) continue;
      const declaration = declarationsIn(source, typeName);
      if (!declaration) continue;
      for (const node of declaration.findReferencesAsNodes()) {
        if (!editable(node, scope)) continue;
        result.edits.push({
          file: node.getSourceFile().getFilePath(),
          start: node.getStart(),
          end: node.getEnd(),
          replacement: schema,
          changeId: "sdk-upgrade",
          author: "codemod",
          reason: `${typeName} is now ${schema}`,
        });
      }
    }
  }
}

/** Points every import at the package built for the current contract. */
function swapPackage(project: Project, plan: MigrationPlan, scope: EditScope): Edit[] {
  const { package: from, upgradeTo } = plan.symbols;
  const edits: Edit[] = [];
  for (const source of project.getSourceFiles()) {
    if (!editable(source, scope)) continue;
    for (const declaration of source.getImportDeclarations()) {
      const specifier = declaration.getModuleSpecifier();
      if (specifier.getLiteralValue() !== from) continue;
      edits.push({
        file: source.getFilePath(),
        start: specifier.getStart(),
        end: specifier.getEnd(),
        replacement: JSON.stringify(upgradeTo.package),
        changeId: "sdk-upgrade",
        author: "codemod",
        reason: `moved to ${upgradeTo.package}, which speaks the current contract`,
      });
    }
  }
  return edits;
}

/**
 * Adds the conversion helpers the migrated source actually ended up using.
 *
 * Deciding this before the edits run would mean guessing, and a guess that is
 * too generous leaves an unused import, which is a new type error in a pull
 * request that is supposed to introduce none. So it is read off the result.
 */
function addHelperImports(
  project: Project,
  plan: MigrationPlan,
  files: Iterable<string>,
): Edit[] {
  const helpers = plan.symbols.helpers;
  if (!helpers) return [];
  const names = [helpers.toMinor, helpers.fromMinor];
  const edits: Edit[] = [];

  for (const file of files) {
    const source = project.getSourceFile(file);
    if (!source) continue;
    const declaration = source
      .getImportDeclarations()
      .find(
        (imported) =>
          imported.getModuleSpecifier().getLiteralValue() === plan.symbols.package,
      );
    if (!declaration) continue;

    const named = declaration.getNamedImports();
    const existing = new Set(named.map((entry) => entry.getName()));
    const body = source.getFullText();
    const missing = names
      .filter((name) => !existing.has(name))
      .filter((name) => new RegExp(`\\b${name}\\(`).test(body))
      .sort();
    if (missing.length === 0) continue;

    const last = named[named.length - 1];
    if (!last) continue;
    edits.push({
      file,
      start: last.getEnd(),
      end: last.getEnd(),
      replacement: `,\n  ${missing.join(",\n  ")}`,
      changeId: "sdk-upgrade",
      author: "codemod",
      reason: "imported the SDK's exact conversion helpers",
    });
  }

  return edits;
}

function diagnosticsOf(project: Project): string[] {
  return project.getPreEmitDiagnostics().map((diagnostic) => {
    const file = diagnostic.getSourceFile()?.getFilePath() ?? "(unknown)";
    return `${file}:${diagnostic.getLineNumber() ?? 0} TS${diagnostic.getCode()}`;
  });
}

export async function migrate(options: MigrateOptions): Promise<MigrationResult> {
  const project = new Project({ tsConfigFilePath: options.tsConfigFilePath });
  const diagnosticsBefore = diagnosticsOf(project);

  // First pass: everything that follows from the Changes themselves.
  const scope: EditScope = { repoDir: options.repoDir, sdkDir: options.sdkDir };
  const result = runEngine(project, options.plan, scope);
  renameAccessors(project, options.plan, scope, result);
  renameTypes(project, options.plan, scope, result);

  const files = new Map<string, string>();
  for (const [file, edits] of groupByFile(result.edits)) {
    files.set(
      file,
      applyEdits(file, project.getSourceFileOrThrow(file).getFullText(), edits),
    );
  }
  for (const [file, text] of files) {
    project.getSourceFileOrThrow(file).replaceWithText(text);
  }

  // Second pass, against the migrated source: the imports it now needs, and
  // the package that speaks the current contract.
  const second: Edit[] = [
    ...addHelperImports(project, options.plan, files.keys()),
    ...swapPackage(project, options.plan, scope),
  ];
  result.edits.push(...second);

  for (const [file, edits] of groupByFile(second)) {
    const updated = applyEdits(
      file,
      project.getSourceFileOrThrow(file).getFullText(),
      edits,
    );
    files.set(file, updated);
    project.getSourceFileOrThrow(file).replaceWithText(updated);
  }

  // Re-check against the edited text, so the result is measured rather than
  // assumed. A migration that leaves a new type error is not a migration.
  const diagnosticsAfter = diagnosticsOf(project);

  if (options.write) {
    await Promise.all([...files].map(([file, text]) => writeFile(file, text, "utf8")));
    await upgradeManifest(options.repoDir, options.plan.symbols);
  }

  return {
    edits: result.edits,
    manual: result.manual,
    files,
    diagnosticsBefore,
    diagnosticsAfter,
  };
}

/** Moves the dependency in package.json to the package built for the current contract. */
export async function upgradeManifest(
  repoDir: string,
  symbols: SymbolMap,
): Promise<void> {
  const path = join(repoDir, "package.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

  for (const field of ["dependencies", "devDependencies"]) {
    const deps = manifest[field];
    if (typeof deps !== "object" || deps === null) continue;
    const record = deps as Record<string, string>;
    if (!(symbols.package in record)) continue;
    delete record[symbols.package];
    record[symbols.upgradeTo.package] = symbols.upgradeTo.version;
  }

  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export { buildPlan, Node, runEngine };
