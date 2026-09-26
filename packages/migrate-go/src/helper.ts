/**
 * The Go helper, built from source and run with the go command fenced in.
 *
 * Reading a consumer's Go code means running the go command over it, and the
 * go command will, if let, download a newer toolchain, rewrite go.mod, clone
 * repositories over any VCS, and link C through cgo. None of that is needed
 * to read types, and all of it is somebody else's code or network doing
 * things on this machine. So every invocation gets the same environment:
 * the toolchain that is installed and no other (`GOTOOLCHAIN=local`), go.mod
 * read and never written (`-mod=readonly`), no cgo, modules only through the
 * proxy (no `direct`, no VCS), no workspace file from the repository, and no
 * user configuration. Nothing in the repository is ever executed: loading
 * compiles dependencies to read their export data, and go has no build
 * scripts. `go generate` and `go test` are never run.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface GoOptions {
  /** The go command; `go` on the PATH by default. */
  go?: string;
  /**
   * Where modules come from. Only the public proxy by default: a module not
   * on it is not fetched from anywhere else.
   */
  proxy?: string;
  /** The module cache, when not the user's own. */
  modCache?: string;
  /** The build cache, when not the user's own. */
  buildCache?: string;
  /** Packages the go command builds at once; each one's compiler takes memory. */
  parallelism?: number;
  /** Where the helper is built; a directory in the system's temporary one by default. */
  cacheDir?: string;
  /** The longest any one go command or helper request may take, in milliseconds. */
  timeout?: number;
}

/** The environment every go command runs in. */
export function goEnvironment(options: GoOptions = {}): NodeJS.ProcessEnv {
  const inherited = [
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "SystemRoot",
    // The way out, where there is only one: a sandboxed fetch reaches the
    // module proxy through the egress proxy, and a network behind a
    // corporate proxy reaches it no other way either.
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "NO_PROXY",
    "no_proxy",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const name of inherited) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    GOTOOLCHAIN: "local",
    GOFLAGS: `-mod=readonly -buildvcs=false -p=${options.parallelism ?? 1}`,
    CGO_ENABLED: "0",
    GOPROXY: options.proxy ?? "https://proxy.golang.org",
    GOSUMDB: "sum.golang.org",
    GONOPROXY: "",
    GONOSUMDB: "",
    GOPRIVATE: "",
    GOINSECURE: "",
    GOVCS: "*:off",
    GOWORK: "off",
    GOENV: "off",
    GOTELEMETRY: "off",
    ...(options.modCache ? { GOMODCACHE: options.modCache } : {}),
    ...(options.buildCache ? { GOCACHE: options.buildCache } : {}),
  };
}

/** Runs the go command with the fenced environment and returns what it printed. */
export async function goCommand(
  args: readonly string[],
  cwd: string,
  options: GoOptions = {},
): Promise<string> {
  try {
    const { stdout } = await run(options.go ?? "go", [...args], {
      cwd,
      env: goEnvironment(options),
      maxBuffer: 256 * 1024 * 1024,
      ...(options.timeout ? { timeout: options.timeout } : {}),
    });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    throw new Error(`go ${args.join(" ")}: ${stderr.trim() || String(error)}`);
  }
}

/**
 * Where the helper's source is: shipped beside the built package, or, in
 * this repository, the module it is developed in.
 */
function helperSource(): string {
  for (const candidate of ["./helper/", "../../../engines/go/migrate/"]) {
    const dir = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(join(dir, "go.mod"))) return dir;
  }
  throw new Error("the Go helper's source is not beside this package");
}

const built = new Map<string, Promise<string>>();

/**
 * The helper, built once per version of its source. `INVARIANT_GO_HELPER`
 * names a binary built elsewhere, as a release that ships one does.
 */
export function helperBinary(options: GoOptions = {}): Promise<string> {
  const prebuilt = process.env["INVARIANT_GO_HELPER"];
  if (prebuilt) return Promise.resolve(prebuilt);
  const source = helperSource();
  const hash = createHash("sha256");
  for (const name of readdirSync(source).sort()) {
    if (!/(\.go|^go\.mod|^go\.sum)$/.test(name) || name.endsWith("_test.go")) continue;
    hash.update(name);
    hash.update(readFileSync(join(source, name)));
  }
  const dir = options.cacheDir ?? join(tmpdir(), "invariant-go");
  const binary = join(
    dir,
    `invariant-go-migrate-${hash.digest("hex").slice(0, 16)}${process.platform === "win32" ? ".exe" : ""}`,
  );
  const pending = built.get(binary);
  if (pending) return pending;
  const building = (async () => {
    if (existsSync(binary)) return binary;
    await mkdir(dir, { recursive: true });
    // Built beside its final name and moved there, so two builds at once
    // never leave half a binary where the other looks for a whole one.
    const partial = `${binary}.${process.pid}.partial`;
    await goCommand(["build", "-trimpath", "-o", partial, "."], source, options);
    await rename(partial, binary).catch(async (error: unknown) => {
      await rm(partial, { force: true });
      if (!existsSync(binary)) throw error;
    });
    return binary;
  })();
  built.set(binary, building);
  building.catch(() => built.delete(binary));
  return building;
}

/** Asks the helper one question. */
export async function askHelper<T>(
  request: Record<string, unknown>,
  options: GoOptions = {},
): Promise<T> {
  const binary = await helperBinary(options);
  return new Promise<T>((resolve, reject) => {
    const child = spawn(binary, [], {
      cwd: typeof request["dir"] === "string" ? request["dir"] : undefined,
      env: goEnvironment(options),
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.timeout ? { timeout: options.timeout } : {}),
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code !== 0) {
        const said = Buffer.concat(err).toString().trim();
        reject(
          new Error(
            `the Go helper failed on ${String(request["command"])}: ${said || (signal ? `stopped by ${signal}, out of memory or out of time` : `exit ${code}`)}`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(out).toString("utf8")) as T);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
