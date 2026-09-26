/**
 * The oci-rootless driver, first as the arguments it hands the runtime, then
 * for real: containers started through docker or podman, probed from the
 * inside for what the phase can and cannot do.
 *
 * The real half needs a running container runtime, and the fetch's egress
 * test the public registries. Where either is missing it is skipped, saying
 * why, except in CI, where INVARIANT_REQUIRE_SANDBOX makes it fail instead.
 */
import { lookup } from "node:dns/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Exec, ExecResult } from "./exec.ts";
import {
  containerArgs,
  detectRuntime,
  type LocalWorkspace,
  NODE_IMAGE,
  ociSandbox,
  ociUser,
} from "./oci.ts";
import { DEFAULT_LIMITS, SandboxError } from "./sandbox.ts";

describe("the arguments a phase's container is started with", () => {
  const args = containerArgs({
    name: "invariant-analyse-x",
    image: "node:24",
    command: ["node", "/work/request/run.mjs"],
    env: { HOME: "/tmp" },
    limits: { ...DEFAULT_LIMITS.analyse, memoryMb: 2048, cpuSeconds: 60 },
    mounts: [
      { source: "/host/repo", target: "/work/repo", readOnly: true },
      { source: "/host/out", target: "/work/out", readOnly: false },
    ],
    network: "none",
    user: { user: "1000:1000" },
  });
  const pairs = (flag: string) =>
    args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : []));

  it("takes away the network, the root filesystem, root and every capability", () => {
    expect(pairs("--network")).toEqual(["none"]);
    expect(args).toContain("--read-only");
    expect(pairs("--cap-drop")).toEqual(["ALL"]);
    expect(pairs("--security-opt")).toEqual(["no-new-privileges"]);
    expect(pairs("--user")).toEqual(["1000:1000"]);
    expect(args).toContain("--init");
  });

  it("limits memory with no swap, CPUs, processes, CPU time and scratch space", () => {
    expect(pairs("--memory")).toEqual(["2048m"]);
    expect(pairs("--memory-swap")).toEqual(["2048m"]);
    expect(pairs("--cpus")).toEqual([String(DEFAULT_LIMITS.analyse.cpus)]);
    expect(pairs("--pids-limit")).toEqual([String(DEFAULT_LIMITS.analyse.pids)]);
    expect(pairs("--ulimit")).toEqual(["cpu=60:65", "core=0"]);
    expect(pairs("--tmpfs")).toEqual([
      `/tmp:rw,nosuid,nodev,size=${DEFAULT_LIMITS.analyse.tmpMb}m`,
    ]);
  });

  it("mounts inputs read-only and the output writable, and runs the command as given", () => {
    expect(pairs("--mount")).toEqual([
      "type=bind,source=/host/repo,target=/work/repo,readonly",
      "type=bind,source=/host/out,target=/work/out",
    ]);
    expect(args.slice(-3)).toEqual(["node:24", "node", "/work/request/run.mjs"]);
  });

  it("refuses a path that would be read as more mount options", () => {
    expect(() =>
      containerArgs({
        name: "x",
        image: "i",
        command: [],
        env: {},
        limits: DEFAULT_LIMITS.fetch,
        mounts: [{ source: "/a,readonly=false", target: "/work/out", readOnly: false }],
        network: "none",
        user: { user: "1:1" },
      }),
    ).toThrow(/comma/);
  });

  it("never runs a phase as root on the host", () => {
    expect(ociUser("docker", { uid: 1000, gid: 1000 }, false)).toEqual({
      user: "1000:1000",
    });
    expect(ociUser("docker", { uid: 0, gid: 0 }, false)).toEqual({
      user: "65534:65534",
      chownTo: 65534,
    });
    expect(ociUser("podman", { uid: 1000, gid: 100 }, false)).toEqual({
      user: "1000:100",
      userns: "keep-id",
    });
    // Rootless docker's container root is the unprivileged user running it.
    expect(ociUser("docker", { uid: 1000, gid: 1000 }, true)).toEqual({ user: "0:0" });
  });
});

describe("the driver without a runtime", () => {
  it("says there is nothing to run a sandbox in", async () => {
    const missing: Exec = async () => {
      throw Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
    };
    expect(await detectRuntime(missing)).toBeUndefined();
    const sandbox = ociSandbox({ image: "node:24", exec: missing });
    const error = await sandbox
      .analyse({ workspace: {}, command: ["true"] })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SandboxError);
    expect((error as SandboxError).kind).toBe("unavailable");
  });

  it("cleans up the proxy and the network when the fetch cannot start", async () => {
    const calls: string[][] = [];
    const fake: Exec = async (_file, args): Promise<ExecResult> => {
      calls.push([...args]);
      const ok = { code: 0, signal: null, stdout: "", stderr: "" };
      if (args[0] === "info") return { ...ok, stdout: "[]" };
      if (args[0] === "network" && args[1] === "connect") {
        return { ...ok, code: 1, stderr: "no such network" };
      }
      return ok;
    };
    const sandbox = ociSandbox({ image: "node:24", runtime: "docker", exec: fake });
    const error = await sandbox
      .fetch({ workspace: {}, command: ["true"] })
      .catch((caught: unknown) => caught);
    expect((error as SandboxError).kind).toBe("driver");
    const removed = calls.filter((call) => call[0] === "rm" || call[1] === "rm");
    expect(removed.map((call) => call.join(" "))).toEqual([
      expect.stringMatching(/^rm --force invariant-egress-/),
      expect.stringMatching(/^network rm invariant-sandbox-/),
    ]);
  });
});

const required = process.env["INVARIANT_REQUIRE_SANDBOX"] === "1";
const runtime = await detectRuntime();
const online = await lookup("registry.npmjs.org").then(
  () => true,
  () => false,
);
if (required && !runtime) {
  throw new Error(
    "INVARIANT_REQUIRE_SANDBOX is set, and neither docker nor podman is running",
  );
}
const why = runtime ? "" : " (skipped: neither docker nor podman is running here)";

/**
 * Reports, as JSON on stdout, what a process in the phase can do: who it
 * runs as, what it may write, what it can reach, and the limits it is under.
 */
const PROBE = String.raw`
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { lookup } from "node:dns/promises";
import { connect } from "node:net";
const report = {};
const status = readFileSync("/proc/self/status", "utf8");
report.uid = process.getuid();
report.capEff = /CapEff:\s+(\w+)/.exec(status)?.[1];
report.noNewPrivs = /NoNewPrivs:\s+(\d)/.exec(status)?.[1];
report.cpuLimit = /Max cpu time\s+(\S+)/.exec(readFileSync("/proc/self/limits", "utf8"))?.[1];
const cgroup = (name) => { try { return readFileSync("/sys/fs/cgroup/" + name, "utf8").trim(); } catch { return undefined; } };
report.memoryMax = cgroup("memory.max");
report.swapMax = cgroup("memory.swap.max");
report.pidsMax = cgroup("pids.max");
const writes = (path) => { try { writeFileSync(path, "x"); return true; } catch { return false; } };
report.writes = Object.fromEntries(["/probe", "/work/repo/probe", "/work/packages/probe", "/work/out/probe", "/tmp/probe", "/work/request/probe"].map((p) => [p, writes(p)]));
report.sees = Object.fromEntries(["/work/repo", "/work/packages", "/work/out"].map((p) => [p, existsSync(p)]));
report.interfaces = Object.keys(networkInterfaces()).sort();
report.dns = await lookup("registry.npmjs.org").then(() => true, () => false);
report.direct = await new Promise((resolve) => {
  const socket = connect({ host: "1.1.1.1", port: 443, timeout: 3000 });
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
  socket.once("timeout", () => { socket.destroy(); resolve(false); });
});
if (process.env.INVARIANT_SANDBOX_PHASE === "fetch") {
  const get = (url) => fetch(url).then((r) => r.status, (e) => "refused: " + (e.cause?.message ?? e.message));
  report.registry = await get("https://registry.npmjs.org/left-pad");
  report.elsewhere = await get("https://example.com/");
}
console.log("PROBE " + JSON.stringify(report));
`;

function probeOf(output: string): Record<string, unknown> {
  const line = output.split("\n").find((entry) => entry.startsWith("PROBE "));
  if (!line) throw new Error(`the probe printed nothing:\n${output}`);
  return JSON.parse(line.slice("PROBE ".length)) as Record<string, unknown>;
}

describe.skipIf(!runtime)(`oci-rootless on a real runtime${why}`, () => {
  let root: string;
  let workspace: LocalWorkspace;
  const sandbox = ociSandbox({ image: NODE_IMAGE, ...(runtime ? { runtime } : {}) });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "invariant-oci-"));
    workspace = {};
    for (const part of ["request", "repo", "packages", "out"] as const) {
      workspace[part] = join(root, part);
      await mkdir(workspace[part] as string);
    }
    await writeFile(join(root, "request", "probe.mjs"), PROBE);
    await writeFile(join(root, "repo", "app.ts"), "export const answer = 42;\n");
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("runs the analysis as a non-root user with no capabilities, no network and read-only inputs", async () => {
    const result = await sandbox.analyse({
      workspace,
      command: ["node", "/work/request/probe.mjs"],
      limits: { memoryMb: 256, cpuSeconds: 30, pids: 64 },
    });
    const probe = probeOf(result.output);
    expect(probe["uid"]).not.toBe(0);
    expect(probe["capEff"]).toBe("0000000000000000");
    expect(probe["noNewPrivs"]).toBe("1");
    expect(probe["writes"]).toEqual({
      "/probe": false,
      "/work/repo/probe": false,
      "/work/packages/probe": false,
      "/work/out/probe": true,
      "/tmp/probe": true,
      "/work/request/probe": false,
    });
    expect(probe["interfaces"]).toEqual(["lo"]);
    expect(probe["dns"]).toBe(false);
    expect(probe["direct"]).toBe(false);
    expect(probe["memoryMax"]).toBe(String(256 * 1024 * 1024));
    expect(probe["pidsMax"]).toBe("64");
    expect(probe["cpuLimit"]).toBe("30");
    expect(await readFile(join(root, "out", "probe"), "utf8")).toBe("x");
  }, 120_000);

  it("kills a phase over its memory, and says so", async () => {
    const error = await sandbox
      .analyse({
        workspace,
        command: [
          "node",
          "-e",
          "const kept = []; for (;;) kept.push(Buffer.alloc(8 * 1024 * 1024, 1));",
        ],
        limits: { memoryMb: 96 },
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SandboxError);
    expect((error as SandboxError).kind).toBe("memory");
  }, 120_000);

  it("stops a phase at its CPU time, and one at its wall clock", async () => {
    const spun = await sandbox
      .analyse({
        workspace,
        command: ["node", "-e", "for (;;) {}"],
        limits: { cpuSeconds: 1, wallSeconds: 60 },
      })
      .catch((caught: unknown) => caught);
    expect((spun as SandboxError).kind).toBe("cpu");

    const started = Date.now();
    const slept = await sandbox
      .analyse({
        workspace,
        command: ["node", "-e", "setTimeout(() => {}, 120000)"],
        limits: { wallSeconds: 2 },
      })
      .catch((caught: unknown) => caught);
    expect((slept as SandboxError).kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(60_000);
  }, 120_000);

  it("reports a phase that exits non-zero with its status and what it printed", async () => {
    const error = await sandbox
      .analyse({
        workspace,
        command: ["node", "-e", "console.error('it went wrong'); process.exit(3)"],
      })
      .catch((caught: unknown) => caught);
    expect((error as SandboxError).kind).toBe("exit");
    expect((error as SandboxError).exitCode).toBe(3);
    expect((error as SandboxError).output).toMatch(/it went wrong/);
  }, 120_000);

  it.skipIf(!online)(
    `lets the fetch reach a registry through the proxy and nothing else${online ? "" : " (skipped: the registries cannot be reached from here)"}`,
    async () => {
      const result = await sandbox.fetch({
        workspace,
        command: ["node", "/work/request/probe.mjs"],
        limits: { memoryMb: 256 },
      });
      const probe = probeOf(result.output);
      expect(probe["uid"]).not.toBe(0);
      expect(probe["capEff"]).toBe("0000000000000000");
      expect(probe["registry"]).toBe(200);
      expect(String(probe["elsewhere"])).toMatch(/^refused/);
      expect(probe["direct"]).toBe(false);
      // Names are the proxy's to resolve: an internal network forwards no
      // lookups, so DNS is not a way out either.
      expect(probe["dns"]).toBe(false);
      // The fetch is never shown the repository.
      expect(probe["sees"]).toEqual({
        "/work/repo": false,
        "/work/packages": true,
        "/work/out": false,
      });
      expect(probe["writes"]).toMatchObject({
        "/probe": false,
        "/work/packages/probe": true,
        "/work/request/probe": false,
      });
      expect(result.egress).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ host: "registry.npmjs.org", allowed: true }),
          expect.objectContaining({ host: "example.com", allowed: false }),
        ]),
      );
    },
    180_000,
  );
});
