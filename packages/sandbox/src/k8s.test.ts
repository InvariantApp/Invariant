/**
 * The k8s-job driver, as the objects it asks a cluster for. There is no
 * cluster here, so the manifests are held to what they have to say, then to
 * the Kubernetes schema through kubeconform where it is installed (CI
 * installs it), and the driver's lifecycle is run against a fake API.
 */
import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { Exec } from "./exec.ts";
import {
  type JobStatus,
  type KubernetesApi,
  type KubernetesObject,
  k8sProxyManifests,
  k8sSandbox,
  kubectlApi,
  LABELS,
  type PhaseManifestInput,
  phaseJob,
  phaseNetworkPolicy,
} from "./k8s.ts";
import { DEFAULT_LIMITS, phaseEnvironment, SandboxError } from "./sandbox.ts";

const proxy = {
  url: "http://10.96.0.40:3128",
  podSelector: { "app.kubernetes.io/name": "invariant-egress-proxy" },
  namespace: "invariant-proxy",
  port: 3128,
};

function input(phase: "fetch" | "analyse", more: Partial<PhaseManifestInput> = {}) {
  return {
    phase,
    id: "run1",
    namespace: "migrations",
    image: "ghcr.io/invariantapp/worker@sha256:abc",
    runtimeClassName: "gvisor",
    command: ["invariant", "migrate", "--phase", phase, "/work/request/job.json"],
    env: phaseEnvironment(phase, phase === "fetch" ? { proxy: proxy.url } : {}),
    limits: DEFAULT_LIMITS[phase],
    workspace: { claim: "workspace-run1", prefix: "runs/run1" },
    ...(phase === "fetch" ? { proxy } : {}),
    ...more,
  } satisfies PhaseManifestInput;
}

// biome-ignore lint/suspicious/noExplicitAny: walking a manifest is walking untyped JSON.
type Json = any;
const podOf = (job: KubernetesObject): Json => (job as Json).spec.template.spec;

describe("the Job for a phase", () => {
  const job = phaseJob(input("analyse"));
  const pod = podOf(job);
  const container = pod.containers[0];

  it("runs once, in the sandboxed runtime, with the control plane holding the deadline", () => {
    expect((job as Json).spec.backoffLimit).toBe(0);
    expect((job as Json).spec.activeDeadlineSeconds).toBe(
      DEFAULT_LIMITS.analyse.wallSeconds,
    );
    expect(pod.runtimeClassName).toBe("gvisor");
    expect(pod.restartPolicy).toBe("Never");
    expect(
      podOf(phaseJob(input("analyse", { runtimeClassName: "kata" }))).runtimeClassName,
    ).toBe("kata");
  });

  it("gives the pod no token, no service links, no host namespaces and no root", () => {
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.enableServiceLinks).toBe(false);
    expect([pod.hostNetwork, pod.hostPID, pod.hostIPC]).toEqual([false, false, false]);
    expect(pod.securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 65534,
      runAsGroup: 65534,
      fsGroup: 65534,
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(container.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      privileged: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      capabilities: { drop: ["ALL"] },
    });
  });

  it("asks for exactly what it may use, and caps CPU time inside", () => {
    const resources = { cpu: "2", memory: "4096Mi", "ephemeral-storage": "2048Mi" };
    expect(container.resources).toEqual({ requests: resources, limits: resources });
    expect(container.command.slice(0, 4)).toEqual([
      "/bin/sh",
      "-c",
      'ulimit -t "$0" && exec "$@"',
      String(DEFAULT_LIMITS.analyse.cpuSeconds),
    ]);
    expect(pod.volumes).toContainEqual({
      name: "scratch",
      emptyDir: { sizeLimit: "2048Mi" },
    });
  });

  it("mounts the workspace's parts from the claim, read-only but for the output", () => {
    expect(container.volumeMounts).toEqual([
      {
        name: "workspace",
        mountPath: "/work/request",
        subPath: "runs/run1/request",
        readOnly: true,
      },
      {
        name: "workspace",
        mountPath: "/work/repo",
        subPath: "runs/run1/repo",
        readOnly: true,
      },
      {
        name: "workspace",
        mountPath: "/work/packages",
        subPath: "runs/run1/packages",
        readOnly: true,
      },
      {
        name: "workspace",
        mountPath: "/work/out",
        subPath: "runs/run1/out",
        readOnly: false,
      },
      { name: "scratch", mountPath: "/tmp" },
    ]);
    const fetch = podOf(phaseJob(input("fetch"))).containers[0];
    expect(fetch.volumeMounts.map((mount: Json) => mount.mountPath)).toEqual([
      "/work/request",
      "/work/packages",
      "/tmp",
    ]);
    expect(fetch.env).toContainEqual({ name: "HTTPS_PROXY", value: proxy.url });
  });
});

describe("the NetworkPolicy for a phase", () => {
  it("denies an analysis every connection in and out", () => {
    const policy = phaseNetworkPolicy(input("analyse")) as Json;
    expect(policy.spec).toEqual({
      podSelector: { matchLabels: { [LABELS.run]: "run1", [LABELS.phase]: "analyse" } },
      policyTypes: ["Ingress", "Egress"],
      ingress: [],
      egress: [],
    });
  });

  it("lets a fetch reach the egress proxy's pods on its port, and nothing else", () => {
    const policy = phaseNetworkPolicy(input("fetch")) as Json;
    expect(policy.spec.egress).toEqual([
      {
        to: [
          {
            podSelector: { matchLabels: proxy.podSelector },
            namespaceSelector: {
              matchLabels: { "kubernetes.io/metadata.name": "invariant-proxy" },
            },
          },
        ],
        ports: [{ protocol: "TCP", port: 3128 }],
      },
    ]);
    expect(policy.spec.ingress).toEqual([]);
    const named = phaseNetworkPolicy(input("fetch", { dns: true })) as Json;
    expect(named.spec.egress[1].ports).toEqual([
      { protocol: "UDP", port: 53 },
      { protocol: "TCP", port: 53 },
    ]);
    expect(() =>
      phaseNetworkPolicy(input("fetch", { proxy: undefined as never })),
    ).toThrow(SandboxError);
  });
});

describe("the egress proxy on a cluster", () => {
  const { objects, endpoint } = k8sProxyManifests({
    namespace: "invariant-proxy",
    image: "ghcr.io/invariantapp/worker@sha256:abc",
    allow: ["npm.example.com"],
  });
  const [deployment, , policy] = objects as Json[];

  it("allows the registries and the extras, and lets only fetch pods in", () => {
    const command = deployment.spec.template.spec.containers[0].command;
    expect(command.at(-1)).toBe(
      "registry.npmjs.org,pypi.org,files.pythonhosted.org,proxy.golang.org,sum.golang.org,npm.example.com",
    );
    expect(policy.spec.ingress).toEqual([
      {
        from: [{ podSelector: { matchLabels: { [LABELS.phase]: "fetch" } } }],
        ports: [{ protocol: "TCP", port: 3128 }],
      },
    ]);
    expect(endpoint.podSelector).toEqual(deployment.spec.selector.matchLabels);
  });

  it("goes out only to public addresses on 443, and to the cluster's DNS", () => {
    const [https, dns] = policy.spec.egress;
    expect(https.ports).toEqual([{ protocol: "TCP", port: 443 }]);
    expect(https.to[0].ipBlock.except).toEqual(
      expect.arrayContaining(["10.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12"]),
    );
    expect(dns.ports[0]).toEqual({ protocol: "UDP", port: 53 });
  });
});

/** Every object the driver can ask for, for checking against the schema. */
function everyManifest(): KubernetesObject[] {
  return [
    phaseJob(input("analyse")),
    phaseJob(input("fetch")),
    phaseNetworkPolicy(input("analyse")),
    phaseNetworkPolicy(input("fetch", { dns: true })),
    ...k8sProxyManifests({ namespace: "invariant-proxy", image: "worker:1" }).objects,
  ];
}

describe("every manifest, structurally", () => {
  const name = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
  const label = /^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/;
  it.each(
    everyManifest().map((object) => [`${object.kind} ${object.metadata.name}`, object]),
  )("%s has a valid name, labels and kind", (_title, object) => {
    expect(object.apiVersion).toMatch(
      /^(v1|batch\/v1|apps\/v1|networking\.k8s\.io\/v1)$/,
    );
    expect(object.metadata.name).toMatch(name);
    expect(object.metadata.name.length).toBeLessThanOrEqual(63);
    for (const value of Object.values(object.metadata.labels ?? {})) {
      expect(value).toMatch(label);
      expect(value.length).toBeLessThanOrEqual(63);
    }
  });
});

/** kubeconform, on the PATH or where `go install` puts it. */
function kubeconform(): string | undefined {
  for (const dir of [
    ...(process.env["PATH"] ?? "").split(":"),
    join(homedir(), "go", "bin"),
  ]) {
    const path = join(dir, "kubeconform");
    if (dir && existsSync(path)) return path;
  }
  return undefined;
}

const validator = kubeconform();
const online = await lookup("raw.githubusercontent.com").then(
  () => true,
  () => false,
);
if (process.env["INVARIANT_REQUIRE_SANDBOX"] === "1" && (!validator || !online)) {
  throw new Error(
    "INVARIANT_REQUIRE_SANDBOX is set, and kubeconform or its schemas are missing",
  );
}
const skipped = !validator
  ? " (skipped: kubeconform is not installed)"
  : !online
    ? " (skipped: the schemas cannot be downloaded from here)"
    : "";

describe("every manifest, against the Kubernetes schema", () => {
  it.skipIf(skipped !== "")(
    `passes kubeconform -strict${skipped}`,
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "invariant-k8s-"));
      try {
        for (const [index, object] of everyManifest().entries()) {
          await writeFile(join(dir, `${index}.json`), JSON.stringify(object));
        }
        const { stdout } = await promisify(execFile)(validator as string, [
          "-strict",
          "-summary",
          "-output",
          "json",
          "-kubernetes-version",
          "1.33.0",
          dir,
        ]).catch((error: { stdout?: string }) => ({
          stdout: error.stdout ?? String(error),
        }));
        const report = JSON.parse(stdout) as {
          resources?: { msg?: string; status: string }[];
          summary: { valid: number; invalid: number; errors: number; skipped: number };
        };
        expect(report.resources ?? []).toEqual([]);
        expect(report.summary).toEqual({
          valid: everyManifest().length,
          invalid: 0,
          errors: 0,
          skipped: 0,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

/** A cluster that answers from a script, and remembers what it was asked. */
function fakeCluster(statuses: JobStatus[]): KubernetesApi & { log: string[] } {
  const log: string[] = [];
  let polled = 0;
  return {
    log,
    async create(object) {
      log.push(`create ${object.kind} ${object.metadata.name}`);
    },
    async delete(kind, _namespace, name) {
      log.push(`delete ${kind} ${name}`);
    },
    async jobStatus() {
      const status = statuses[Math.min(polled, statuses.length - 1)] as JobStatus;
      polled += 1;
      return status;
    },
    async logs() {
      return "what the phase printed\n";
    },
  };
}

describe("the k8s-job driver", () => {
  const options = { namespace: "migrations", image: "worker:1", proxy, pollMs: 1 };
  const request = {
    workspace: { claim: "workspace-run1" },
    command: ["invariant", "migrate"],
  };

  it("fences the pod before starting it, waits for the Job, and removes both", async () => {
    const api = fakeCluster([
      { state: "pending" },
      { state: "running" },
      { state: "succeeded", exitCode: 0 },
    ]);
    const result = await k8sSandbox({ ...options, api }).fetch(request);
    expect(result).toMatchObject({ phase: "fetch", driver: "k8s-job" });
    expect(result.output).toBe("what the phase printed\n");
    expect(api.log.map((line) => line.replace(/-[a-z0-9]+-[a-f0-9]+$/, ""))).toEqual([
      "create NetworkPolicy invariant-fetch",
      "create Job invariant-fetch",
      "delete Job invariant-fetch",
      "delete NetworkPolicy invariant-fetch",
    ]);
  });

  it.each([
    [{ state: "failed", exitCode: 137, reason: "OOMKilled" } as JobStatus, "memory"],
    [{ state: "failed", reason: "DeadlineExceeded" } as JobStatus, "timeout"],
    [{ state: "failed", exitCode: 152 } as JobStatus, "cpu"],
    [{ state: "failed", exitCode: 2 } as JobStatus, "exit"],
  ])("reads a Job that failed as %o as %s", async (status, kind) => {
    const api = fakeCluster([status]);
    const error = await k8sSandbox({ ...options, api })
      .analyse(request)
      .catch((caught: unknown) => caught);
    expect((error as SandboxError).kind).toBe(kind);
    expect(api.log.filter((line) => line.startsWith("delete"))).toHaveLength(2);
  });

  it("removes the policy when the Job cannot be created", async () => {
    const api = fakeCluster([]);
    api.create = async (object) => {
      if (object.kind === "Job") throw new Error("forbidden");
      api.log.push(`create ${object.kind}`);
    };
    const error = await k8sSandbox({ ...options, api })
      .analyse(request)
      .catch((caught: unknown) => caught);
    expect((error as SandboxError).kind).toBe("driver");
    expect(api.log.map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual([
      "create NetworkPolicy",
      "delete NetworkPolicy",
    ]);
  });
});

describe("kubectlApi", () => {
  it("creates from standard input and reads a Job's end from its pod", async () => {
    const calls: { args: readonly string[]; input?: string }[] = [];
    const exec: Exec = async (_file, args, options) => {
      calls.push({ args, ...(options?.input ? { input: options.input } : {}) });
      const answer = (stdout: unknown) => ({
        code: 0,
        signal: null,
        stdout: JSON.stringify(stdout),
        stderr: "",
      });
      if (args.includes("job")) {
        return answer({
          status: { failed: 1, conditions: [{ type: "Failed", status: "True" }] },
        });
      }
      if (args.includes("pods")) {
        return answer({
          items: [
            {
              status: {
                containerStatuses: [
                  { state: { terminated: { exitCode: 137, reason: "OOMKilled" } } },
                ],
              },
            },
          ],
        });
      }
      return answer({});
    };
    const api = kubectlApi({ context: "sandbox", exec });
    await api.create({ apiVersion: "v1", kind: "Job", metadata: { name: "j" } });
    expect(calls[0]?.args).toEqual(["--context", "sandbox", "create", "--filename", "-"]);
    expect(JSON.parse(calls[0]?.input ?? "")).toMatchObject({ kind: "Job" });
    expect(await api.jobStatus("migrations", "j")).toEqual({
      state: "failed",
      exitCode: 137,
      reason: "OOMKilled",
    });
  });
});
