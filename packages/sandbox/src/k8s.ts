/**
 * The `k8s-job` driver: each phase as a Kubernetes Job, in a sandboxed
 * runtime, fenced by a NetworkPolicy of its own.
 *
 * The pod runs under a RuntimeClass (gVisor's `gvisor` by default, or Kata),
 * so a kernel exploit in the phase meets a user-space kernel or a VM rather
 * than the node's. It runs as `nobody` with a read-only root filesystem,
 * every capability dropped, no privilege escalation, the runtime's default
 * seccomp profile, no service account token and no service environment
 * variables, with requests equal to limits and a deadline the control plane
 * enforces. The workspace is a PersistentVolumeClaim, each part a directory
 * mounted read-only or not as `mountsFor` says.
 *
 * The NetworkPolicy for an analyse pod denies all egress and all ingress.
 * The one for a fetch pod allows egress only to the egress proxy's pods on
 * the proxy's port; `k8sProxyManifests` runs that proxy, and its own policy
 * lets it reach public addresses on 443 and nothing private. A policy is
 * only as good as the cluster's network plugin: one that does not enforce
 * NetworkPolicy (the default kubenet, for one) ignores every word of it.
 *
 * Nothing here talks to a cluster directly. The driver asks a
 * `KubernetesApi`, so the service can use its own client, and `kubectlApi`
 * is one over kubectl.
 */
import { allowlist } from "./allowlist.ts";
import { type Exec, exec as run } from "./exec.ts";
import {
  describeFailure,
  type Limits,
  limitsFor,
  mountsFor,
  outcomeOf,
  type Phase,
  type PhaseRequest,
  type PhaseResult,
  phaseEnvironment,
  runId,
  type Sandbox,
  SandboxError,
  SCRATCH,
  withCpuLimit,
} from "./sandbox.ts";

/** A Kubernetes object, as JSON. */
export interface KubernetesObject {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  [field: string]: unknown;
}

/** How a Job ended, or that it has not. */
export interface JobStatus {
  state: "pending" | "running" | "succeeded" | "failed";
  /** The phase container's exit code, once it has one. */
  exitCode?: number;
  /** Why it ended: `OOMKilled` from the container, `DeadlineExceeded` from the Job. */
  reason?: string;
}

export interface KubernetesApi {
  create(object: KubernetesObject): Promise<void>;
  /** Removes an object, and a Job's pods with it; one already gone is not an error. */
  delete(kind: string, namespace: string, name: string): Promise<void>;
  jobStatus(namespace: string, name: string): Promise<JobStatus>;
  logs(namespace: string, job: string): Promise<string>;
}

/** The workspace: a claim holding one directory per part, under `prefix`. */
export interface KubernetesWorkspace {
  claim: string;
  /** The run's directory in the claim, so one claim can hold many runs. */
  prefix?: string;
}

export interface ProxyEndpoint {
  /** What the fetch phase is told to use, as `HTTPS_PROXY`. */
  url: string;
  /** The labels of the proxy's pods, which fetch pods may reach and nothing else. */
  podSelector: Record<string, string>;
  /** The proxy's namespace, when it is not the phase's. */
  namespace?: string;
  port: number;
}

export interface K8sOptions {
  namespace: string;
  image: string;
  /** `gvisor` by default; `kata`, or whatever the cluster names its sandboxed runtime. */
  runtimeClassName?: string;
  proxy: ProxyEndpoint;
  /**
   * Let fetch pods ask the cluster's DNS, for a proxy `url` that is a name.
   * Off by default: a resolver that recurses is a channel out, so the proxy
   * is best given by its Service's cluster IP.
   */
  dns?: boolean;
  api: KubernetesApi;
  /** How often a Job's status is read. */
  pollMs?: number;
  /** Told what a phase printed once it ends. */
  onOutput?: (text: string) => void;
}

export const LABELS = {
  run: "invariant.dev/sandbox-run",
  phase: "invariant.dev/sandbox-phase",
} as const;

/** `nobody`, whose uid is the same in every image. */
const NOBODY = 65534;

export interface PhaseManifestInput {
  phase: Phase;
  id: string;
  namespace: string;
  image: string;
  runtimeClassName: string;
  command: readonly string[];
  env: Readonly<Record<string, string>>;
  limits: Limits;
  workspace: KubernetesWorkspace;
  proxy?: ProxyEndpoint;
  dns?: boolean;
}

function selectorOf(phase: Phase, id: string): Record<string, string> {
  return { [LABELS.run]: id, [LABELS.phase]: phase };
}

/** The NetworkPolicy fencing one phase's pod. */
export function phaseNetworkPolicy(input: PhaseManifestInput): KubernetesObject {
  const egress: unknown[] = [];
  if (input.phase === "fetch") {
    if (!input.proxy) {
      throw new SandboxError("driver", "the fetch phase needs the egress proxy", {
        phase: "fetch",
      });
    }
    egress.push({
      to: [
        {
          podSelector: { matchLabels: input.proxy.podSelector },
          ...(input.proxy.namespace
            ? {
                namespaceSelector: {
                  matchLabels: { "kubernetes.io/metadata.name": input.proxy.namespace },
                },
              }
            : {}),
        },
      ],
      ports: [{ protocol: "TCP", port: input.proxy.port }],
    });
    if (input.dns) egress.push(DNS_RULE);
  }
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: `invariant-${input.phase}-${input.id}`,
      namespace: input.namespace,
      labels: selectorOf(input.phase, input.id),
    },
    spec: {
      podSelector: { matchLabels: selectorOf(input.phase, input.id) },
      policyTypes: ["Ingress", "Egress"],
      // Nothing may connect in, and, for an analysis, nothing out.
      ingress: [],
      egress,
    },
  };
}

const DNS_RULE = {
  to: [
    {
      namespaceSelector: {
        matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
      },
      podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
    },
  ],
  ports: [
    { protocol: "UDP", port: 53 },
    { protocol: "TCP", port: 53 },
  ],
};

const RESTRICTED_CONTAINER = {
  allowPrivilegeEscalation: false,
  privileged: false,
  readOnlyRootFilesystem: true,
  runAsNonRoot: true,
  capabilities: { drop: ["ALL"] },
};

/** The Job that runs one phase. */
export function phaseJob(input: PhaseManifestInput): KubernetesObject {
  const { limits } = input;
  const labels = selectorOf(input.phase, input.id);
  const prefix = input.workspace.prefix
    ? `${input.workspace.prefix.replace(/\/+$/, "")}/`
    : "";
  const resources = {
    cpu: String(limits.cpus),
    memory: `${limits.memoryMb}Mi`,
  };
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: `invariant-${input.phase}-${input.id}`,
      namespace: input.namespace,
      labels,
    },
    spec: {
      // One attempt: a phase that failed is reported, never run again on
      // the same input in the hope it behaves.
      backoffLimit: 0,
      activeDeadlineSeconds: Math.ceil(limits.wallSeconds),
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels },
        spec: {
          runtimeClassName: input.runtimeClassName,
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          hostNetwork: false,
          hostPID: false,
          hostIPC: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: NOBODY,
            runAsGroup: NOBODY,
            fsGroup: NOBODY,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: input.phase,
              image: input.image,
              command: withCpuLimit(input.command, limits.cpuSeconds),
              workingDir: SCRATCH,
              env: Object.entries(input.env).map(([name, value]) => ({ name, value })),
              resources: {
                // Requests equal to limits: the pod is scheduled only where
                // what it may use is actually free.
                requests: { ...resources, "ephemeral-storage": `${limits.tmpMb}Mi` },
                limits: { ...resources, "ephemeral-storage": `${limits.tmpMb}Mi` },
              },
              securityContext: RESTRICTED_CONTAINER,
              volumeMounts: [
                ...mountsFor(input.phase).map((mount) => ({
                  name: "workspace",
                  mountPath: mount.target,
                  subPath: `${prefix}${mount.part}`,
                  readOnly: mount.readOnly,
                })),
                { name: "scratch", mountPath: SCRATCH },
              ],
            },
          ],
          volumes: [
            {
              name: "workspace",
              persistentVolumeClaim: { claimName: input.workspace.claim },
            },
            { name: "scratch", emptyDir: { sizeLimit: `${limits.tmpMb}Mi` } },
          ],
        },
      },
    },
  };
}

export interface ProxyManifestInput {
  namespace: string;
  image: string;
  /** How the image starts the proxy; `invariant-egress-proxy` on its PATH by default. */
  command?: readonly string[];
  /** Hosts beyond the registries. */
  allow?: readonly string[];
  name?: string;
  port?: number;
  replicas?: number;
}

/**
 * The egress proxy as a Deployment and a Service, with a NetworkPolicy that
 * lets only fetch pods in, and lets the proxy out only to public addresses
 * on 443 and to the cluster's DNS.
 */
export function k8sProxyManifests(input: ProxyManifestInput): {
  objects: KubernetesObject[];
  endpoint: Omit<ProxyEndpoint, "url"> & { service: string };
} {
  const name = input.name ?? "invariant-egress-proxy";
  const port = input.port ?? 3128;
  const labels = { "app.kubernetes.io/name": name };
  const hosts = [...allowlist(input.allow ?? [])];
  const deployment: KubernetesObject = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace: input.namespace, labels },
    spec: {
      replicas: input.replicas ?? 2,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: NOBODY,
            runAsGroup: NOBODY,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "proxy",
              image: input.image,
              command: [
                ...(input.command ?? ["invariant-egress-proxy"]),
                "--port",
                String(port),
                "--allow",
                hosts.join(","),
              ],
              ports: [{ name: "proxy", containerPort: port, protocol: "TCP" }],
              readinessProbe: { tcpSocket: { port }, periodSeconds: 5 },
              resources: {
                requests: { cpu: "250m", memory: "128Mi" },
                limits: { cpu: "500m", memory: "256Mi" },
              },
              securityContext: RESTRICTED_CONTAINER,
            },
          ],
        },
      },
    },
  };
  const service: KubernetesObject = {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name, namespace: input.namespace, labels },
    spec: {
      type: "ClusterIP",
      selector: labels,
      ports: [{ name: "proxy", port, targetPort: port, protocol: "TCP" }],
    },
  };
  const policy: KubernetesObject = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name, namespace: input.namespace, labels },
    spec: {
      podSelector: { matchLabels: labels },
      policyTypes: ["Ingress", "Egress"],
      ingress: [
        {
          from: [{ podSelector: { matchLabels: { [LABELS.phase]: "fetch" } } }],
          ports: [{ protocol: "TCP", port }],
        },
      ],
      egress: [
        {
          // The proxy refuses private addresses itself; this says so again
          // where the network can hold it to it.
          to: [
            {
              ipBlock: {
                cidr: "0.0.0.0/0",
                except: [
                  "10.0.0.0/8",
                  "100.64.0.0/10",
                  "127.0.0.0/8",
                  "169.254.0.0/16",
                  "172.16.0.0/12",
                  "192.168.0.0/16",
                ],
              },
            },
            { ipBlock: { cidr: "::/0", except: ["fc00::/7", "fe80::/10", "::1/128"] } },
          ],
          ports: [{ protocol: "TCP", port: 443 }],
        },
        DNS_RULE,
      ],
    },
  };
  return {
    objects: [deployment, service, policy],
    endpoint: { podSelector: labels, namespace: input.namespace, port, service: name },
  };
}

export function k8sSandbox(options: K8sOptions): Sandbox<KubernetesWorkspace> {
  const pollMs = options.pollMs ?? 2000;
  const runtimeClassName = options.runtimeClassName ?? "gvisor";

  async function runPhase(
    phase: Phase,
    request: PhaseRequest<KubernetesWorkspace>,
    env: Record<string, string>,
  ): Promise<PhaseResult> {
    const limits = limitsFor(phase, request.limits);
    const input: PhaseManifestInput = {
      phase,
      id: runId(),
      namespace: options.namespace,
      image: options.image,
      runtimeClassName,
      command: request.command,
      env,
      limits,
      workspace: request.workspace,
      ...(phase === "fetch" ? { proxy: options.proxy } : {}),
      ...(options.dns ? { dns: true } : {}),
    };
    const policy = phaseNetworkPolicy(input);
    const job = phaseJob(input);
    const { api } = options;
    const started = Date.now();
    const created: KubernetesObject[] = [];
    try {
      // The policy first: a pod that started before its fence would have a
      // moment with the network open.
      for (const object of [policy, job]) {
        await api.create(object).catch((error: unknown) => {
          throw new SandboxError(
            "driver",
            `could not create the ${phase} ${object.kind}`,
            {
              phase,
              cause: error,
            },
          );
        });
        created.push(object);
      }
      // The Job's own deadline stops the pod; this one, a little later, is
      // for a cluster that never gets round to saying so.
      const until = started + (limits.wallSeconds + 60) * 1000;
      let status: JobStatus = { state: "pending" };
      while (status.state === "pending" || status.state === "running") {
        if (Date.now() > until) {
          throw new SandboxError(
            "timeout",
            describeFailure("timeout", phase, limits, null),
            {
              phase,
            },
          );
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        status = await api.jobStatus(options.namespace, job.metadata.name);
      }
      const output = await api.logs(options.namespace, job.metadata.name).catch(() => "");
      options.onOutput?.(output);
      const exitCode = status.exitCode ?? (status.state === "succeeded" ? 0 : null);
      const outcome = outcomeOf({
        exitCode,
        timedOut: status.reason === "DeadlineExceeded",
        oomKilled: status.reason === "OOMKilled",
        output,
      });
      if (outcome !== "ok") {
        throw new SandboxError(
          outcome,
          describeFailure(
            outcome as Exclude<typeof outcome, "unavailable" | "driver">,
            phase,
            limits,
            exitCode,
          ),
          { phase, ...(exitCode === null ? {} : { exitCode }), output },
        );
      }
      return { phase, driver: "k8s-job", durationMs: Date.now() - started, output };
    } finally {
      for (const object of created.reverse()) {
        await api
          .delete(object.kind, options.namespace, object.metadata.name)
          .catch(() => undefined);
      }
    }
  }

  return {
    driver: "k8s-job",
    fetch: (request) =>
      runPhase(
        "fetch",
        request,
        phaseEnvironment("fetch", {
          proxy: options.proxy.url,
          ...(request.env ? { env: request.env } : {}),
        }),
      ),
    analyse: (request) =>
      runPhase(
        "analyse",
        request,
        phaseEnvironment("analyse", request.env ? { env: request.env } : {}),
      ),
  };
}

/** A `KubernetesApi` over kubectl, in its current context or the one named. */
export function kubectlApi(
  options: { context?: string; exec?: Exec } = {},
): KubernetesApi {
  const exec = options.exec ?? run;
  const base = options.context ? ["--context", options.context] : [];
  const kubectl = async (args: string[], input?: string) => {
    const answer = await exec(
      "kubectl",
      [...base, ...args],
      input === undefined ? {} : { input },
    );
    if (answer.code !== 0) {
      throw new Error(`kubectl ${args[0]}: ${answer.stderr.trim()}`);
    }
    return answer.stdout;
  };
  return {
    async create(object) {
      await kubectl(["create", "--filename", "-"], JSON.stringify(object));
    },
    async delete(kind, namespace, name) {
      await kubectl([
        "delete",
        kind.toLowerCase(),
        name,
        "--namespace",
        namespace,
        "--ignore-not-found",
        "--wait=false",
        "--cascade=background",
      ]);
    },
    async jobStatus(namespace, name) {
      const job = JSON.parse(
        await kubectl(["get", "job", name, "--namespace", namespace, "--output", "json"]),
      ) as {
        status?: {
          succeeded?: number;
          failed?: number;
          conditions?: { type: string; status: string; reason?: string }[];
        };
      };
      const pods = JSON.parse(
        await kubectl([
          "get",
          "pods",
          "--namespace",
          namespace,
          "--selector",
          `job-name=${name}`,
          "--output",
          "json",
        ]),
      ) as {
        items?: {
          status?: {
            containerStatuses?: {
              state?: { terminated?: { exitCode: number; reason?: string } };
            }[];
          };
        }[];
      };
      const terminated =
        pods.items?.[0]?.status?.containerStatuses?.[0]?.state?.terminated;
      const failed = job.status?.conditions?.find(
        (condition) => condition.type === "Failed" && condition.status === "True",
      );
      const state = job.status?.succeeded
        ? "succeeded"
        : failed || job.status?.failed
          ? "failed"
          : terminated || pods.items?.length
            ? "running"
            : "pending";
      const reason = terminated?.reason === "OOMKilled" ? "OOMKilled" : failed?.reason;
      return {
        state,
        ...(terminated ? { exitCode: terminated.exitCode } : {}),
        ...(reason ? { reason } : {}),
      };
    },
    async logs(namespace, job) {
      return kubectl(["logs", `job/${job}`, "--namespace", namespace, "--tail=2000"]);
    },
  };
}
