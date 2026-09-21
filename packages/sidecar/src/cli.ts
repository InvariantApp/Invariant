#!/usr/bin/env node
/**
 * `invariant-sidecar <config.json>`
 *
 * Starts the proxy in front of a provider's API. Everything is read and checked
 * before the port opens, so a misconfigured proxy never takes a single request.
 */
import { readFile } from "node:fs/promises";
import { createRuntime } from "@invariant/runtime";
import { ConfigError, loadConfig, skipper } from "./config.ts";
import { createProxy } from "./proxy.ts";
import { serve } from "./server.ts";
import { servicesFor } from "./services.ts";

async function main(): Promise<void> {
  const path = process.argv[2] ?? process.env["INVARIANT_SIDECAR_CONFIG"];
  if (!path) {
    process.stderr.write("usage: invariant-sidecar <config.json>\n");
    process.exit(2);
  }

  const config = await loadConfig(path);
  const text = await readFile(config.program, "utf8");
  const services = servicesFor(config);
  const runtime = createRuntime({
    program: JSON.parse(text),
    identity: config.identity,
    maxBodyBytes: config.maxBodyBytes,
    ...(services.flags ? { flags: services.flags } : {}),
    ...(services.onUsage ? { onUsage: services.onUsage } : {}),
    onOutcome: services.onOutcome,
  });
  services.started({ text, currentLabel: runtime.currentLabel });
  // The kill switch is known before the first request, unless the control
  // plane is slow to say, in which case the last flags kept on disk serve.
  await Promise.race([
    services.ready(),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);

  const listening = await serve(
    createProxy({
      runtime,
      upstream: config.upstream,
      upstreamTimeoutMs: config.upstreamTimeoutMs,
      healthPath: config.healthPath,
      skip: skipper(config.skip),
    }),
    {
      port: config.listen.port,
      host: config.listen.host,
      onError: (error) => process.stderr.write(`invariant-sidecar: ${String(error)}\n`),
    },
  );

  process.stdout.write(
    `invariant-sidecar serving contract ${runtime.currentLabel} ` +
      `(${runtime.currentDigest}) at ${listening.url}, in front of ${config.upstream}\n`,
  );

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
