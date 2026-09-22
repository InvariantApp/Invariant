/**
 * Running a migration against a consumer repository.
 *
 * Nothing in here executes consumer code. The repository is loaded for its
 * types, edited as text, and type-checked; installing it or running its tests
 * would mean executing whatever its dependencies feel like running, which is
 * not a thing to do on someone else's behalf.
 */
import { readdirSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Node, Project, type SourceFile, ts } from "ts-morph";
import { applyEdits, type Edit, groupByFile } from "./edits.ts";
import {
  type EditScope,
  type EngineResult,
  editable,
  type ManualSite,
  runEngine,
} from "./engine.ts";
import { bumpPins } from "./pins.ts";
import { buildPlan, type MigrationPlan, type SymbolMap } from "./plan.ts";
import { flagRetired } from "./retired.ts";

export * from "./edits.ts";
export type { EditScope, ManualSite } from "./engine.ts";
export * from "./plan.ts";
export * from "./raw.ts";

export interface MigrateOptions {
  /** Root of the consumer repository. */
  repoDir: string;
  /** Root of the SDK sources, so the engine never edits the SDK itself. */
  /**
   * Where the contract's type declarations live: a generated SDK outside the
   * repository, or generated files inside it. Read, never written.
   */
  generated: readonly string[];
  /**
   * Generated files to replace once the edits are in, before the result is
   * checked.
   *
   * The order matters and is the whole reason this exists. References are
   * resolved against the declarations the consumer compiles against *today*,
   * because those are what its source actually names; regenerating first
   * deletes the very property the engine anchors on and the migration silently
   * finds nothing. The new declarations go in afterwards, so the diagnostics
   * are measured against what the consumer will actually compile against.
   */
  regenerate?: readonly { path: string; source: string }[];
  /**
   * The consumer's own project, or, where its configuration cannot be loaded
   * (it extends a package nobody installed), the files to read and whatever
   * they import. The files are read with defaults any TypeScript or
   * JavaScript accepts.
   */
  tsConfigFilePath?: string;
  sources?: readonly string[];
  /**
   * With `sources`: how the consumer's own imports resolve without an install,
   * as a monorepo's root tsconfig maps `@acme/config` to its source.
   */
  resolution?: { baseUrl: string; paths: Record<string, string[]> };
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
  const { generated } = scope;
  for (const rename of plan.accessorRenames) {
    const [fromHead] = rename.from;
    const [toHead] = rename.to;
    if (!fromHead || !toHead || fromHead === toHead) continue;

    for (const source of project.getSourceFiles()) {
      if (!generated.some((entry) => source.getFilePath().startsWith(entry))) continue;
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
  const { generated } = scope;
  for (const [schema, typeName] of Object.entries(plan.symbols.types)) {
    // What the upgraded package calls it; by default the schema's own name,
    // as a generator that names types after schemas does.
    const renamed = plan.symbols.upgradeTo.types?.[schema] ?? schema;
    if (renamed === typeName) continue;
    for (const source of project.getSourceFiles()) {
      if (!generated.some((entry) => source.getFilePath().startsWith(entry))) continue;
      const declaration = declarationsIn(source, typeName);
      if (!declaration) continue;
      for (const node of declaration.findReferencesAsNodes()) {
        if (!editable(node, scope)) continue;
        result.edits.push({
          file: node.getSourceFile().getFilePath(),
          start: node.getStart(),
          end: node.getEnd(),
          replacement: renamed,
          changeId: "sdk-upgrade",
          author: "codemod",
          reason: `${typeName} is now ${renamed}`,
        });
      }
    }
  }
}

/** Points every import at the package built for the current contract. */
function swapPackage(project: Project, plan: MigrationPlan, scope: EditScope): Edit[] {
  const { package: from, upgradeTo } = plan.symbols;
  const edits: Edit[] = [];
  // The same package at a new version: the manifest moves, and no import does.
  if (upgradeTo.package === from) return edits;
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
  const from = helpers.from ?? plan.symbols.package;
  const edits: Edit[] = [];

  for (const file of files) {
    const source = project.getSourceFile(file);
    if (!source) continue;

    const body = source.getFullText();
    const declaration = source
      .getImportDeclarations()
      .find((imported) => imported.getModuleSpecifier().getLiteralValue() === from);

    const named = declaration?.getNamedImports() ?? [];
    const existing = new Set(named.map((entry) => entry.getName()));
    const missing = names
      .filter((name) => !existing.has(name))
      .filter((name) => new RegExp(`\\b${name}\\(`).test(body))
      .sort();
    if (missing.length === 0) continue;

    // No import to extend means the helpers come from a module this repository
    // did not use before, which is the ordinary case for a consumer holding
    // only generated types. The statement goes above the first existing import
    // so the file still starts with whatever documents it.
    if (!declaration) {
      const first = source.getImportDeclarations()[0];
      const at = first?.getStart() ?? 0;
      edits.push({
        file,
        start: at,
        end: at,
        replacement: `import { ${missing.join(", ")} } from "${from}";\n`,
        changeId: "sdk-upgrade",
        author: "codemod",
        reason: "imported the exact conversion helpers",
      });
      continue;
    }

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

function projectFor(options: MigrateOptions): Project {
  if (options.tsConfigFilePath) {
    return new Project({ tsConfigFilePath: options.tsConfigFilePath });
  }
  const project = new Project({
    compilerOptions: {
      allowJs: true,
      checkJs: false,
      esModuleInterop: true,
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      ...(options.resolution
        ? { baseUrl: options.resolution.baseUrl, paths: options.resolution.paths }
        : {}),
    },
  });
  // One at a time, not as globs: a glob skips any directory whose name starts
  // with a dot, and a checkout under one would silently read nothing.
  for (const path of options.sources ?? []) project.addSourceFileAtPath(path);
  // What the files import, which is where a constant they pass may be declared.
  project.resolveSourceFileDependencies();
  // The contract's declarations, which a checkout usually reaches through
  // node_modules, where a project never lists a file it resolves.
  for (const entry of options.generated) {
    for (const path of declarationFiles(entry)) project.addSourceFileAtPath(path);
  }
  return project;
}

/** Every declaration file at `entry`, a file or a directory, outside nested dependencies. */
function declarationFiles(entry: string): string[] {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(entry);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return /\.d\.[cm]?ts$/.test(entry) ? [entry] : [];
  return readdirSync(entry, { withFileTypes: true }).flatMap((child) =>
    child.name === "node_modules" ? [] : declarationFiles(join(entry, child.name)),
  );
}

function diagnosticsOf(project: Project): string[] {
  return project.getPreEmitDiagnostics().map((diagnostic) => {
    const file = diagnostic.getSourceFile()?.getFilePath() ?? "(unknown)";
    return `${file}:${diagnostic.getLineNumber() ?? 0} TS${diagnostic.getCode()}`;
  });
}

/**
 * Moves each reported site to where the edits left it.
 *
 * Only edits that start strictly before the site can move it, and each one
 * moves it by the difference between what it replaced and what it inserted.
 */
function relocateManualSites(manual: ManualSite[], edits: readonly Edit[]): void {
  for (const site of manual) {
    let shift = 0;
    let inserted = "";

    for (const edit of edits) {
      if (edit.file !== site.file || edit.start >= site.offset) continue;
      const replacement =
        typeof edit.replacement === "string" ? edit.replacement : edit.replacement(""); // A transform of an empty span adds no lines.
      shift += replacement.length - (edit.end - edit.start);
      inserted += replacement;
    }

    if (shift === 0) continue;
    site.line += inserted.split("\n").length - 1;
  }
}

export async function migrate(options: MigrateOptions): Promise<MigrationResult> {
  const project = projectFor(options);
  const diagnosticsBefore = diagnosticsOf(project);

  // First pass: everything that follows from the Changes themselves.
  const scope: EditScope = {
    repoDir: options.repoDir,
    generated: options.generated,
  };
  const result = runEngine(project, options.plan, scope);
  renameAccessors(project, options.plan, scope, result);
  renameTypes(project, options.plan, scope, result);
  bumpPins(project, options.plan.symbols, scope, result);
  flagRetired(project, options.plan, scope, result);

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

  // A consumer with no SDK has nowhere for the exact conversion helpers to
  // come from, so the migration brings them. The file is real source in this
  // repository, type-checked and property-tested against an integer oracle,
  // rather than a string assembled here and hoped over.
  const emit = options.plan.symbols.helpers?.emit;
  if (emit) {
    const path = resolve(options.repoDir, emit.path);
    const source = await readFile(
      new URL("./templates/units.ts", import.meta.url),
      "utf8",
    );
    files.set(path, source);
    project.createSourceFile(path, source, { overwrite: true });
  }

  for (const entry of options.regenerate ?? []) {
    const path = resolve(options.repoDir, entry.path);
    files.set(path, entry.source);
    project.createSourceFile(path, entry.source, { overwrite: true });
  }

  // Manual sites were located in the source as it was read. Every edit above
  // one of them moves it, so the line a reviewer is sent to is recomputed
  // against the text they will actually open.
  relocateManualSites(result.manual, result.edits);

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
