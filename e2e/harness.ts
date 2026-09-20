import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import {
  type AcmeBuild,
  AcmeStore,
  type CreateAcmeAppOptions,
  createAcmeApp,
} from "@fixtures/provider-acme";
import { serve } from "@hono/node-server";

export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

export interface RunningProvider {
  baseUrl: string;
  store: AcmeStore;
  build: AcmeBuild;
  runtime: ReturnType<typeof createAcmeApp>["runtime"];
  close: () => Promise<void>;
}

/** Boots the provider fixture on an ephemeral port. */
export async function startProvider(
  options: CreateAcmeAppOptions = {},
): Promise<RunningProvider> {
  const store = options.store ?? new AcmeStore();
  const { fetch: handler, build, runtime } = createAcmeApp({ ...options, store });

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: handler, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    store,
    build,
    runtime,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

export const CONSUMERS = {
  a: "fixtures/consumer-a-sdk-v1",
  b: "fixtures/consumer-b-types-v2",
  c: "fixtures/consumer-c-rawfetch-v2",
} as const;

/**
 * Runs a migrated copy of a consumer.
 *
 * Through its own config, because the ordinary suite excludes `.migrated` and
 * an exclusion that quietly matches would look exactly like a passing run.
 */
export function runMigratedSuite(
  path: string,
  env: Record<string, string>,
): Promise<SuiteResult> {
  return runIn(path, env, "a", ["--config", "e2e/migrated.vitest.config.ts"]);
}

export type ConsumerId = keyof typeof CONSUMERS;

export interface SuiteResult {
  consumer: ConsumerId;
  passed: boolean;
  exitCode: number | null;
  output: string;
  /** True only if the runner actually executed tests, rather than failing to start. */
  ran: boolean;
  failed: number;
  succeeded: number;
}

const SUMMARY = /Tests\s+(?:(\d+) failed\s*\|\s*)?(\d+) passed/;

// Strip ANSI escapes before reading the summary, so the parse does not depend
// on whether the runner decided to colourize its output.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes requires ESC
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g;

function summarize(output: string): { ran: boolean; failed: number; succeeded: number } {
  const plain = output.replace(ANSI, "");
  const match = SUMMARY.exec(plain);
  if (!match) {
    const onlyFailures = /Tests\s+(\d+) failed\b(?!\s*\|)/.exec(plain);
    if (onlyFailures) {
      return { ran: true, failed: Number(onlyFailures[1]), succeeded: 0 };
    }
    return { ran: false, failed: 0, succeeded: 0 };
  }
  return {
    ran: true,
    failed: match[1] === undefined ? 0 : Number(match[1]),
    succeeded: Number(match[2]),
  };
}

/**
 * Runs one consumer's own test suite as a subprocess, pointed at a live Acme
 * deployment. The consumer is never modified, and never learns that anything
 * sits between it and the provider.
 */
export function runConsumerSuite(
  consumer: ConsumerId,
  env: Record<string, string>,
): Promise<SuiteResult> {
  return runIn(CONSUMERS[consumer], env, consumer, []);
}

function runIn(
  path: string,
  env: Record<string, string>,
  consumer: ConsumerId,
  extraArgs: string[],
): Promise<SuiteResult> {
  const child = spawn(
    "pnpm",
    ["exec", "vitest", "run", "--reporter=dot", ...extraArgs, path],
    {
      cwd: REPO_ROOT,
      // Colour is forced off so the summary this function parses is plain
      // text. A CI runner that turns colour on would otherwise hide the
      // summary behind escape codes, and a suite that really ran would be
      // mistaken for one that never started.
      env: { ...process.env, ...env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  return new Promise<SuiteResult>((resolve) => {
    child.on("close", (exitCode) => {
      resolve({
        consumer,
        passed: exitCode === 0,
        exitCode,
        output,
        ...summarize(output),
      });
    });
  });
}
