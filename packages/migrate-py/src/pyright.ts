/**
 * pyright, spoken to over the Language Server Protocol.
 *
 * pyright is the type checker a Python migration asks what a name refers to:
 * `sub.current_period_end` is a reference to the field `Subscription` declares
 * only when pyright infers `sub` to be a `Subscription`, and it infers that
 * through the SDK's own annotations, the consumer's annotations and its
 * assignments, the way it would in their editor. It has no library API; its
 * language server, run as a child process over stdio, is the supported way in.
 *
 * The server is given exactly one place to find packages: the directory the
 * SDK's wheel was unpacked into. It is never pointed at an interpreter, so it
 * runs no Python to discover search paths, and what it resolves does not
 * depend on the machine it runs on.
 *
 * Positions are LSP positions: a zero-based line and a character offset in
 * UTF-16 code units, which is also how a JavaScript string counts, so an
 * offset into the text read here converts with `offsets.ts` and nothing else.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

export interface Diagnostic {
  range: Range;
  severity?: number;
  code?: string | number;
  message: string;
  rule?: string;
}

export interface PyrightOptions {
  /** The repository being read: pyright's workspace. */
  root: string;
  /** Directories of unpacked packages, searched for imports in this order. */
  packages: readonly string[];
}

const require = createRequire(import.meta.url);

/** The language server's entry point in the pinned pyright package. */
function serverPath(): string {
  return join(dirname(require.resolve("pyright/package.json")), "langserver.index.js");
}

export const uriOf = (path: string) => pathToFileURL(path).href;

export class Pyright {
  private readonly child: ChildProcess;
  private readonly connection: MessageConnection;
  private readonly opened = new Map<string, number>();
  private stderr = "";

  private constructor(options: PyrightOptions) {
    this.child = spawn(process.execPath, [serverPath(), "--stdio"], {
      cwd: options.root,
      stdio: ["pipe", "pipe", "pipe"],
      // The server inherits no Python: an empty PATH entry for it, so a
      // `python` on the host is never found and run for its search paths.
      env: { ...process.env, PATH: dirname(process.execPath) },
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4_000);
    });
    this.connection = createMessageConnection(
      new StreamMessageReader(this.child.stdout as NodeJS.ReadableStream),
      new StreamMessageWriter(this.child.stdin as NodeJS.WritableStream),
    );
    const settings = {
      python: {
        // A path that is not an interpreter: pyright then uses the packages
        // below and its bundled typeshed, and executes nothing.
        pythonPath: join(options.root, ".invariant-no-python"),
        analysis: {
          extraPaths: [...options.packages],
          // Only what is asked about is analysed; a monorepo is not checked
          // end to end to answer where one name points.
          diagnosticMode: "openFilesOnly",
          typeCheckingMode: "standard",
          autoSearchPaths: false,
          useLibraryCodeForTypes: true,
          indexing: false,
        },
      },
    };
    this.connection.onRequest(
      "workspace/configuration",
      (params: { items: { section?: string }[] }) =>
        params.items.map((item) => {
          if (item.section === "python") return settings.python;
          if (item.section === "python.analysis") return settings.python.analysis;
          return null;
        }),
    );
    this.connection.onRequest("client/registerCapability", () => null);
    this.connection.onRequest("window/workDoneProgress/create", () => null);
    // Diagnostics are asked for (`diagnosticsOf`); anything the server
    // publishes or logs on its own is not read.
    this.connection.onNotification(() => undefined);
    this.connection.listen();
  }

  static async start(options: PyrightOptions): Promise<Pyright> {
    const server = new Pyright(options);
    await server.connection.sendRequest("initialize", {
      processId: process.pid,
      rootUri: uriOf(options.root),
      workspaceFolders: [{ uri: uriOf(options.root), name: "consumer" }],
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true },
        textDocument: {
          hover: { contentFormat: ["plaintext"] },
          definition: { linkSupport: false },
          references: {},
          diagnostic: { dynamicRegistration: false },
        },
        general: { positionEncodings: ["utf-16"] },
      },
    });
    await server.connection.sendNotification("initialized", {});
    await server.connection.sendNotification("workspace/didChangeConfiguration", {
      settings: {},
    });
    return server;
  }

  /** Opens `path` with `text`, or replaces what the server holds for it. */
  async open(path: string, text: string): Promise<void> {
    const uri = uriOf(path);
    const version = (this.opened.get(uri) ?? 0) + 1;
    this.opened.set(uri, version);
    if (version === 1) {
      await this.connection.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId: "python", version, text },
      });
    } else {
      await this.connection.sendNotification("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    }
  }

  async definition(path: string, position: Position): Promise<Location[]> {
    const result = (await this.connection.sendRequest("textDocument/definition", {
      textDocument: { uri: uriOf(path) },
      position,
    })) as Location | Location[] | null;
    if (!result) return [];
    return Array.isArray(result) ? result : [result];
  }

  /** The declared type a hover shows, as text: `(variable) sub: Subscription`. */
  async hover(path: string, position: Position): Promise<string | undefined> {
    const result = (await this.connection.sendRequest("textDocument/hover", {
      textDocument: { uri: uriOf(path) },
      position,
    })) as { contents: { value: string } | string } | null;
    if (!result) return undefined;
    return typeof result.contents === "string" ? result.contents : result.contents.value;
  }

  async references(path: string, position: Position): Promise<Location[]> {
    const result = (await this.connection.sendRequest("textDocument/references", {
      textDocument: { uri: uriOf(path) },
      position,
      context: { includeDeclaration: false },
    })) as Location[] | null;
    return result ?? [];
  }

  /**
   * The diagnostics for an open file, asked for rather than waited on.
   *
   * Waiting for the server to publish them, and then for it to go quiet, was
   * the first way this worked, and it was a race: on a busy runner pyright
   * published a file's empty set on opening it and then said nothing while
   * it checked, the quiet period ended first, and one CI run reported an
   * upgrade's error that the next run on the same commit did not. A pull
   * request (LSP 3.17's `textDocument/diagnostic`) is answered only once the
   * file is checked.
   */
  async diagnosticsOf(path: string): Promise<Diagnostic[]> {
    const result = (await this.connection.sendRequest("textDocument/diagnostic", {
      textDocument: { uri: uriOf(path) },
    })) as { kind: string; items?: Diagnostic[] } | null;
    if (result?.kind !== "full") {
      throw new Error(
        `pyright gave no diagnostics for ${path}: ${this.stderr.slice(-400)}`,
      );
    }
    return result.items ?? [];
  }

  async stop(): Promise<void> {
    try {
      await Promise.race([
        this.connection.sendRequest("shutdown"),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
      await this.connection.sendNotification("exit");
    } catch {
      // A server that already went away needs no shutting down.
    }
    this.connection.dispose();
    this.child.kill();
  }
}
