#!/usr/bin/env node
/**
 * `invariant-sidecar <config.json>`
 *
 * Starts the proxy in front of a provider's API. Everything is read and checked
 * before the port opens, so a misconfigured proxy never takes a single request.
 */
import { watch } from "node:fs";
import { createRuntime } from "@invariant/runtime";
import { ConfigError, loadConfig, skipper } from "./config.ts";
import { createProxy } from "./proxy.ts";
import { reloadable } from "./reload.ts";
import { serve } from "./server.ts";
import { servicesFor } from "./services.ts";

async function main(): Promise<void> {
  const path = process.argv[2] ?? process.env["INVARIANT_SIDECAR_CONFIG"];
  if (!path) {
    process.stderr.write("usage: invariant-sidecar <config.json>\n");
    process.exit(2);
  }

  const config = await loadConfig(path);
  const services = servicesFor(config);
  const log = (message: string) =>
    process.stderr.write(`invariant-sidecar: ${message}\n`);

  const program = await reloadable({
    path: config.program,
    log,
    build: (text) => {
      const runtime = createRuntime({
        program: JSON.parse(text),
        ...(config.identity ? { identity: config.identity } : {}),
        maxBodyBytes: config.maxBodyBytes,
        ...(services.flags ? { flags: services.flags } : {}),
        ...(services.onUsage ? { onUsage: services.onUsage } : {}),
        onOutcome: services.onOutcome,
      });
      services.started({ text, currentLabel: runtime.currentLabel });
      return createProxy({
        runtime,
        upstream: config.upstream,
        upstreamTimeoutMs: config.upstreamTimeoutMs,
        healthPath: config.healthPath,
        skip: skipper(config.skip),
      });
    },
  });
  // The kill switch is known before the first request, unless the control
  // plane is slow to say, in which case the last flags kept on disk serve.
  await Promise.race([
    services.ready(),
    new Promise((resolve) => setTimeout(resolve, 2000).unref()),
  ]);

  const listening = await serve(program.handler, {
    port: config.listen.port,
    host: config.listen.host,
    requestTimeoutMs: config.requestTimeoutMs,
    headersTimeoutMs: config.headersTimeoutMs,
    maxConnections: config.maxConnections,
    onError: (error) => log(String(error)),
  });

  process.stdout.write(
    `invariant-sidecar serving ${config.program} at ${listening.url}, in front of ${config.upstream}\n`,
  );

  // A new program replaces the running one on SIGHUP, or when its file
  // changes; one that does not load is reported and the running one kept.
  process.on("SIGHUP", () => void program.reload("SIGHUP"));
  let settle: NodeJS.Timeout | undefined;
  watch(config.program, () => {
    // Editors and deploy tools write a file in several steps; wait for quiet.
    clearTimeout(settle);
    settle = setTimeout(() => void program.reload("the file changed"), 250);
  }).unref();

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`invariant-sidecar: ${signal}, finishing requests in flight\n`);
    await listening.close();
    // Counters for the requests just finished are sent before exiting.
    await services.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

main().catch((error: unknown) => {
  const message = error instanceof ConfigError ? error.message : String(error);
  process.stderr.write(`invariant-sidecar: ${message}\n`);
  process.exit(1);
});
