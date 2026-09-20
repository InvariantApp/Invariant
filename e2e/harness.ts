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
  close: () => Promise<void>;
}

/** Boots the provider fixture on an ephemeral port. */
export async function startProvider(
  options: CreateAcmeAppOptions = {},
): Promise<RunningProvider> {
  const store = options.store ?? new AcmeStore();
  const { app, build } = createAcmeApp({ ...options, store });

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () =>
      resolve(s),
    );
  });
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    store,
    build,
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

function summarize(output: string): { ran: boolean; failed: number; succeeded: number } {
  const match = SUMMARY.exec(output);
  if (!match) {
    const onlyFailures = /Tests\s+(\d+) failed\b(?!\s*\|)/.exec(output);
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
  const child = spawn(
    "pnpm",
    ["exec", "vitest", "run", "--reporter=dot", CONSUMERS[consumer]],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env, CI: "1" },
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
