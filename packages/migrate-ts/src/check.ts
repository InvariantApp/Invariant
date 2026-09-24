/**
 * One check of the consumer's files against one release.
 *
 * It is a function of plain data so that whoever runs a migration can run it
 * where it can be stopped. Type-checking a file is one synchronous call the
 * checker only sometimes offers to cancel, and decipad's files against
 * stripe-node 17 sat in one for hours. The engine starts no process and no
 * thread of its own; a caller that needs a hard limit runs this in one
 * (`MigrateOptions.checker`), and the replay does.
 */
import { join } from "node:path";
import { Project, ts } from "ts-morph";
import type { Release } from "./verify.ts";

export interface CheckRequest {
  repoDir: string;
  files: readonly string[];
  texts: readonly (readonly [string, string])[];
  compilerOptions: ts.CompilerOptions;
  release?: Release;
  /** When to stop, in milliseconds since the epoch, where the checker offers to. */
  deadline?: number;
}

export interface Found {
  code: number;
  /** The checker's first line: what is wrong, and with what. */
  message: string;
  start: number;
  end: number;
}

/**
 * The files' errors with the SDK resolved from `release`, or through the
 * repository's own `node_modules` where none is given.
 */
export function diagnosticsIn(
  request: CheckRequest,
  onRead: (files: number) => void = () => {},
): Map<string, Found[]> {
  const { release } = request;
  const texts = new Map(request.texts);
  const redirect = (name: string) =>
    release !== undefined &&
    (name === release.package || name.startsWith(`${release.package}/`));
  const project = new Project({
    compilerOptions: { ...request.compilerOptions, checkJs: true, noEmit: true },
    skipAddingFilesFromTsConfig: true,
    resolutionHost: (host, options) => {
      // One cache for the whole program, as the compiler keeps its own: a
      // monorepo's thousands of imports are each resolved once.
      const cache = ts.createModuleResolutionCache(
        host.getCurrentDirectory?.() ?? request.repoDir,
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
  for (const file of request.files) {
    project.createSourceFile(file, texts.get(file) ?? "", { overwrite: true });
  }
  const program = project.getProgram().compilerObject;
  onRead(program.getSourceFiles().length);
  const found = new Map<string, Found[]>();
  const token: ts.CancellationToken = {
    isCancellationRequested: () =>
      request.deadline !== undefined && Date.now() > request.deadline,
    throwIfCancellationRequested() {
      if (this.isCancellationRequested()) throw new ts.OperationCanceledException();
    },
  };
  for (const file of request.files) {
    const source = program.getSourceFile(file);
    if (!source || token.isCancellationRequested()) continue;
    let diagnostics: ts.Diagnostic[];
    try {
      diagnostics = [
        ...program.getSyntacticDiagnostics(source, token),
        ...program.getSemanticDiagnostics(source, token),
      ];
    } catch (error) {
      // Past the deadline the file is left out, and so listed as unchecked.
      if (error instanceof ts.OperationCanceledException) continue;
      throw error;
    }
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
