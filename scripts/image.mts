/**
 * Builds the proxy image and proves it in front of a real API.
 *
 * The container is run the way a provider should run it: read-only root
 * filesystem, every capability dropped, configuration and program mounted
 * read-only. The upstream is the fixture provider's current build with no
 * adapter of its own, which is what an API behind this proxy looks like. An old
 * caller's request goes through the container and has to come back in the
 * shape it was written against, and Docker has to report the container
 * healthy through the image's own health check.
 *
 *   node --import tsx scripts/image.mts [--tag invariant-sidecar:test]
 */
import { execFile, spawn } from "node:child_process";
import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = new URL("..", import.meta.url).pathname;
const tagAt = process.argv.indexOf("--tag");
const TAG = tagAt === -1 ? "invariant-sidecar:test" : (process.argv[tagAt + 1] as string);
const UPSTREAM_PORT = 18787;
const PROXY_PORT = 18080;

async function until(
  what: string,
  probe: () => Promise<boolean>,
  seconds = 60,
): Promise<void> {
  for (let tries = 0; tries < seconds * 2; tries += 1) {
    if (await probe().catch(() => false)) return;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

await run(
  "docker",
  ["build", "--pull=false", "-t", TAG, join(ROOT, "packages/sidecar/image")],
  {
    maxBuffer: 16 * 1024 * 1024,
  },
);
process.stdout.write(`built ${TAG}\n`);

const work = await mkdtemp(join(tmpdir(), "invariant-image-"));
const upstream = spawn(
  process.execPath,
  ["--import", "tsx", join(ROOT, "fixtures/provider-acme/src/server.ts")],
  {
    cwd: join(ROOT, "fixtures/provider-acme"),
    env: {
      ...process.env,
      PORT: String(UPSTREAM_PORT),
      HOST: "0.0.0.0",
      ACME_BUILD: "head",
      ACME_ADAPTER: "none",
    },
    stdio: "ignore",
    detached: true,
  },
);
let container = "";

try {
  await copyFile(
    join(ROOT, "fixtures/provider-acme/invariant/compiled/program.json"),
    join(work, "program.json"),
  );
  await writeFile(
    join(work, "sidecar.json"),
    JSON.stringify({
      program: "/etc/invariant/program.json",
      // The host, as seen from inside the container. Published ports and the
      // host gateway behave the same on a Linux runner and on Docker Desktop,
      // where host networking would mean Desktop's own virtual machine.
      upstream: `http://host.docker.internal:${UPSTREAM_PORT}`,
      listen: { port: 8080, host: "0.0.0.0" },
      identity: [
        { kind: "header", name: "acme-version" },
        { kind: "default", label: "2026-01-15" },
      ],
    }),
    "utf8",
  );

  // The image runs as an unprivileged user, so what is mounted has to be
  // readable by it. A provider mounting a 0600 file meets exactly this.
  await chmod(work, 0o755);
  await chmod(join(work, "program.json"), 0o644);
  await chmod(join(work, "sidecar.json"), 0o644);

  await until(
    "the upstream",
    async () => (await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/__health`)).ok,
  );

  container = (
    await run("docker", [
      "run",
      "-d",
      "--add-host",
      "host.docker.internal:host-gateway",
      "--publish",
      `127.0.0.1:${PROXY_PORT}:8080`,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "-v",
      `${work}:/etc/invariant:ro`,
      TAG,
    ])
  ).stdout.trim();

  await until(
    "the proxy",
    async () => (await fetch(`http://127.0.0.1:${PROXY_PORT}/__invariant/health`)).ok,
  );

  // A caller written against the first contract, which has never heard of
  // payments, minor units, or payment methods.
  const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/charges`, {
    method: "POST",
    headers: {
      authorization: "Bearer sk_test_alpha",
      "acme-version": "2026-01-15",
      "content-type": "application/json",
    },
    body: JSON.stringify({ amount: 49.99, currency: "usd", source: "tok_visa" }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (response.status !== 201 || body["amount"] !== 49.99 || "amount_cents" in body) {
    throw new Error(`an old caller got ${response.status} ${JSON.stringify(body)}`);
  }
  process.stdout.write(
    `an old caller was answered in its own contract: ${JSON.stringify(body)}\n`,
  );

  await until(
    "Docker to report the container healthy",
    async () =>
      (
        await run("docker", ["inspect", "-f", "{{.State.Health.Status}}", container])
      ).stdout.trim() === "healthy",
  );
  process.stdout.write("the image's health check reports healthy\n");
} catch (error) {
  // What the proxy itself said is the first thing anyone debugging this needs.
  if (container) {
    const logs = await run("docker", ["logs", container]).catch(() => ({
      stdout: "",
      stderr: "",
    }));
    process.stderr.write(`container output:\n${logs.stdout}${logs.stderr}\n`);
  }
  throw error;
} finally {
  if (container) await run("docker", ["rm", "-f", container]).catch(() => undefined);
  if (upstream.pid) {
    try {
      process.kill(-upstream.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await rm(work, { recursive: true, force: true });
}
