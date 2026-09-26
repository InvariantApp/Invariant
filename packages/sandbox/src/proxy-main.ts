#!/usr/bin/env node
/**
 * `invariant-egress-proxy --allow <host>[,<host>] [--port <n>] [--host <addr>]`
 *
 * The egress proxy as a process of its own, as every driver runs it: in a
 * container on the fetch phase's network, in a pod behind a Service, or on
 * a machine of its own. The registries are always allowed; `--allow` adds
 * to them. It prints one JSON line when it is listening, and one for every
 * tunnel it opens or refuses, which is the fetch's egress log.
 */
import { allowlist } from "./allowlist.ts";
import { startEgressProxy } from "./proxy.ts";

function values(argv: readonly string[], name: string): string[] {
  return argv
    .flatMap((entry, index) => (entry === `--${name}` ? [argv[index + 1] ?? ""] : []))
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

const argv = process.argv.slice(2);
const port = Number(values(argv, "port")[0] ?? 3128);
const ports = values(argv, "ports").map(Number);
const proxy = await startEgressProxy({
  allow: allowlist(values(argv, "allow")),
  host: values(argv, "host")[0] ?? "0.0.0.0",
  port,
  ...(ports.length > 0 ? { ports } : {}),
  log: (decision) => process.stdout.write(`${JSON.stringify({ egress: decision })}\n`),
});
process.stdout.write(`${JSON.stringify({ ready: { port: proxy.port } })}\n`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void proxy.close().then(() => process.exit(0));
  });
}
