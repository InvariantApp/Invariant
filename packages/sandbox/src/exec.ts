/**
 * Running a platform's command-line tool (docker, podman, kubectl), with the
 * runner injectable so what a driver asks the tool to do can be tested
 * without the tool.
 */
import { spawn } from "node:child_process";

export interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /** Told of everything the command prints, as it prints it. */
  onOutput?: (chunk: Buffer) => void;
  /** Written to the command's standard input. */
  input?: string;
  /** The command's environment; this process's by default. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Runs `file` with `args`, never through a shell, and answers with how it
 * ended. A command that exits non-zero is an answer, not an error; only a
 * command that cannot be started at all rejects.
 */
export type Exec = (
  file: string,
  args: readonly string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

/** Output kept per stream: a tool's answer, not a phase's whole log. */
const KEPT = 1024 * 1024;

export const exec: Exec = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.env ? { env: options.env } : {}),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      options.onOutput?.(chunk);
      if (stdout.length < KEPT) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      options.onOutput?.(chunk);
      if (stderr.length < KEPT) stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(options.input ?? "");
  });
