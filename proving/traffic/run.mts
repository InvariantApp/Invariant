/**
 * Rig C: generated traffic through the adapter, for every corpus pair that
 * closes.
 *
 * Closure proves the drafted Changes account for every breaking delta on
 * paper. This asks whether the program compiled from them actually serves an
 * old caller. Every adapted site gets seeded requests shaped by the old
 * contract, and each is sent three ways:
 *
 *   a. to a mock of the old contract, directly. It must be accepted and
 *      answered validly, or the rig itself is at fault and the site is not
 *      judged.
 *   b. to a mock of the new contract, directly. Something must go wrong: the
 *      request refused, or the answer not what the old contract promised. If
 *      nothing does, the site did not need adapting and proves nothing, and is
 *      reported as vacuous rather than counted as a pass.
 *   c. to the same new mock, through the proxy running the compiled program.
 *      The mock must accept the adapted request and the adapted response must
 *      satisfy the old contract. Anything else is a violation.
 *
 * Every verdict comes from the oracle in oracle.mts, which shares no code with
 * the product. Bodies are judged; parameters and headers are not yet, because
 * no Change that moves them can be served until the request envelope exists.
 *
 * Usage: node --import tsx proving/traffic/run.mts [--samples 100] [--provider p]
 *   [--api name] [--results path]
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chainProgram } from "@invariant/compiler";
import { loadContract, type OpenApiDocument } from "@invariant/contract";
import type { PairResult } from "@invariant/eval";
import type { JsonValue } from "@invariant/ir";
import { propose, RulesJudge } from "@invariant/proposer";
import { createRuntime } from "@invariant/runtime";
import { createProxy } from "@invariant/sidecar";
import { valueArbitrary } from "@invariant/verifier";
import fc from "fast-check";
import {
  type ManifestPair,
  materializePair,
  ROOT,
  readManifest,
} from "../corpus/manifest.mts";
import { type ContractMock, createContractMock } from "./mock.mts";
import { Oracle } from "./oracle.mts";

type JsonObject = Record<string, JsonValue>;
const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const SAMPLES = Number(option("samples") ?? 100);
const partial = option("provider") !== undefined || option("api") !== undefined;
const RESULTS =
  option("results") ??
  join(ROOT, partial ? ".cache/traffic-results.json" : "proving/traffic/results.json");
const REPORT = join(ROOT, "proving/traffic/REPORT.md");

interface Endpoint {
  method: string;
  path: string;
}

export type ViolationKind =
  /** The new API refused the request the adapter sent it. */
  | "rejected"
  /** The adapter answered the old caller with an error of its own. */
  | "refused"
  /** The answer did not satisfy the old contract. */
  | "response"
  /** A retired operation reached the API instead of being answered 410. */
  | "not-retired";

export interface SiteResult {
  /** The operation as the old caller knows it. */
  old: string;
  /** The operation it reaches in the new contract. */
  current: string;
  /**
   * Retired sites are a declared loss: the old caller is told the operation
   * is gone. They are scored against that declaration only, and reported
   * apart from the sites that are actually served.
   */
  retired: boolean;
  samples: number;
  /** Arm a: samples the rig could not judge, because it was itself at fault. */
  rigFaults: number;
  /** Arm b: samples on which the unadapted new API broke the old caller. */
  brokenWithout: number;
  /** Arm c. */
  violations: number;
  /** Samples whose generated response the new contract itself rejected. */
  unjudgeable: number;
  kinds: Partial<Record<ViolationKind, number>>;
  /** The first violation, to start a diagnosis from. */
  example?: { kind: ViolationKind; status: number; detail: string };
  /** The first sample the rig could not judge, and why. */
  fault?: string;
}

export interface TrafficResult {
  api: string;
  provider: string;
  fromVersion: string;
  toVersion: string;
  changes: number;
  /** Set when the pair could not be run, and why. */
  error?: string;
  sites: SiteResult[];
}

/** Follows local references until it reaches something that is not one. */
function follow(
  document: OpenApiDocument,
  value: JsonValue | undefined,
): JsonValue | undefined {
  let current = value;
  for (let hops = 0; hops < 16 && isObject(current); hops += 1) {
    const ref = current["$ref"];
    if (typeof ref !== "string" || !ref.startsWith("#/")) return current;
    let target: JsonValue | undefined = document as JsonValue;
    for (const raw of ref.slice(2).split("/")) {
      target = isObject(target)
        ? target[raw.replaceAll("~1", "/").replaceAll("~0", "~")]
        : undefined;
    }
    current = target;
  }
  return current;
}

function operationOf(
  document: OpenApiDocument,
  endpoint: Endpoint,
): JsonObject | undefined {
  const paths = document["paths"];
  const item = isObject(paths) ? paths[endpoint.path] : undefined;
  const operation = isObject(item) ? item[endpoint.method] : undefined;
  return isObject(operation) ? operation : undefined;
}

/** The JSON request body schema, if the operation takes one. */
function requestSchema(
  document: OpenApiDocument,
  operation: JsonObject,
): JsonValue | undefined {
  const body = follow(document, operation["requestBody"]);
  const content = isObject(body) ? body["content"] : undefined;
  if (!isObject(content)) return undefined;
  const media = Object.keys(content).find((type) => /json/i.test(type));
  const holder = media ? content[media] : undefined;
  return isObject(holder) ? holder["schema"] : undefined;
}

/**
 * A concrete URL for a templated path, each parameter a value its schema
 * allows, so an old caller's request is one the old API would route.
 */
function concretePath(
  document: OpenApiDocument,
  endpoint: Endpoint,
  operation: JsonObject,
  seed: number,
): string {
  const item = (document["paths"] as JsonObject)[endpoint.path] as JsonObject;
  const declared = [
    ...(Array.isArray(item["parameters"]) ? item["parameters"] : []),
    ...(Array.isArray(operation["parameters"]) ? operation["parameters"] : []),
  ].map((parameter) => follow(document, parameter));
  return endpoint.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const parameter = declared.find(
      (entry) => isObject(entry) && entry["in"] === "path" && entry["name"] === name,
    );
    const schema = isObject(parameter) ? parameter["schema"] : undefined;
    let value: JsonValue = `${name}_${seed}`;
    if (schema !== undefined) {
      try {
        [value] = fc.sample(valueArbitrary(document, schema), { numRuns: 1, seed }) as [
          JsonValue,
        ];
      } catch {}
    }
    const text = typeof value === "string" ? value : String(value);
    // An empty segment is not the operation, and `.` and `..` are resolved
    // away by URL normalisation before any server sees them.
    return text === "" || text === "." || text === ".." || text.includes("/")
      ? `${name}_${seed}`
      : encodeURIComponent(text);
  });
}

interface Sample {
  path: string;
  body: JsonValue | undefined;
}

function requestFor(
  endpoint: Endpoint,
  sample: Sample,
  base = "http://api.test",
): Request {
  return new Request(`${base}${sample.path}`, {
    method: endpoint.method.toUpperCase(),
    ...(sample.body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(sample.body),
        }),
  });
}

async function bodyOf(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!/json/i.test(response.headers.get("content-type") ?? "") || text === "") {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const keyOf = (endpoint: Endpoint): string => `${endpoint.method} ${endpoint.path}`;

/** Every site the program changes, with the operation an old caller uses. */
function adaptedSites(
  program: unknown,
  label: string,
): { old: Endpoint; current: Endpoint; retired: boolean }[] {
  const contract = (program as { contracts: Record<string, JsonObject> }).contracts[
    label
  ];
  if (!contract) return [];
  const routes = (contract["routes"] ?? []) as unknown as {
    from: Endpoint;
    to: Endpoint;
  }[];
  const byCurrent = new Map(routes.map((route) => [keyOf(route.to), route.from]));
  const sites = new Map<string, { old: Endpoint; current: Endpoint; retired: boolean }>();
  for (const route of routes) {
    sites.set(keyOf(route.to), { old: route.from, current: route.to, retired: false });
  }
  for (const retired of (contract["retired"] ?? []) as unknown as Endpoint[]) {
    const endpoint = { method: retired.method, path: retired.path };
    sites.set(`retired ${keyOf(endpoint)}`, {
      old: endpoint,
      current: endpoint,
      retired: true,
    });
  }
  for (const [key, site] of Object.entries((contract["sites"] ?? {}) as JsonObject)) {
    if (!isObject(site)) continue;
    const request = Array.isArray(site["request"]) ? site["request"] : [];
    const responses = isObject(site["response"]) ? Object.values(site["response"]) : [];
    const changes =
      request.length > 0 ||
      responses.some((block) => Array.isArray(block) && block.length > 0);
    if (!changes) continue;
    const space = key.indexOf(" ");
    const current = { method: key.slice(0, space), path: key.slice(space + 1) };
    sites.set(key, { old: byCurrent.get(key) ?? current, current, retired: false });
  }
  return [...sites.values()];
}

async function runPair(pair: ManifestPair): Promise<TrafficResult> {
  const result: TrafficResult = {
    api: pair.api,
    provider: pair.provider,
    fromVersion: pair.from.label,
    toVersion: pair.to.label,
    changes: 0,
    sites: [],
  };
  const local = await materializePair(pair);
  const from = await loadContract(local.fromPath, "old");
  const to = await loadContract(local.toPath, "new");
  const drafted = await propose(from.document, to.document, { judge: new RulesJudge() });
  const changes = drafted.proposals.map((proposal) => proposal.change);
  result.changes = changes.length;

  const chained = chainProgram(pair.api, "new", "sha256:rig-c", [
    { label: "new", parent: "old", from: from.document, to: to.document, changes },
  ]);
  if (chained.issues.length > 0) {
    result.error = `the gate would block this release: ${chained.issues[0]?.message ?? ""}`;
    return result;
  }
  const runtime = createRuntime({
    program: chained.program,
    identity: [{ kind: "default", label: "old" }],
  });

  const oldOracle = new Oracle(from.document as never);
  const oldMock = createContractMock(from.document);
  const newMock = createContractMock(to.document);
  const viaMock = (mock: ContractMock) =>
    (async (input: string | URL | Request, init?: RequestInit) =>
      mock.fetch(new Request(input, init))) as typeof fetch;
  const proxy = createProxy({
    runtime,
    upstream: "http://upstream.test",
    fetch: viaMock(newMock),
  });

  for (const { old, current, retired } of adaptedSites(chained.program, "old")) {
    const operation = operationOf(from.document, old);
    const site: SiteResult = {
      old: keyOf(old),
      current: keyOf(current),
      retired,
      samples: 0,
      rigFaults: 0,
      brokenWithout: 0,
      violations: 0,
      unjudgeable: 0,
      kinds: {},
    };
    result.sites.push(site);
    if (!operation) continue;
    if (old.path.includes("#")) {
      // AWS's JSON protocols put the operation in a header and write it into
      // the path as a fragment, which no request can carry. Counted, not run.
      site.samples = SAMPLES;
      site.rigFaults = SAMPLES;
      site.fault =
        "the path names its operation in a fragment, which no HTTP request carries";
      continue;
    }
    const schema = requestSchema(from.document, operation);
    const bodies =
      schema === undefined
        ? undefined
        : fc.sample(valueArbitrary(from.document, schema), { numRuns: SAMPLES, seed: 1 });

    const violation = (kind: ViolationKind, status: number, detail: string) => {
      site.violations += 1;
      site.kinds[kind] = (site.kinds[kind] ?? 0) + 1;
      site.example ??= { kind, status, detail: detail.slice(0, 400) };
    };

    for (let index = 0; index < SAMPLES; index += 1) {
      site.samples += 1;
      const sample: Sample = {
        path: concretePath(from.document, old, operation, index + 1),
        body: bodies?.[index],
      };

      // Arm a: the old world, which has to be consistent before anything
      // measured against it means something.
      oldMock.reset();
      const direct = await oldMock.fetch(requestFor(old, sample));
      const judgedOld = oldMock.log[0];
      if (direct.status >= 400 || judgedOld?.responseValid === false) {
        site.rigFaults += 1;
        const reasons = (
          direct.status >= 400 ? judgedOld?.request : judgedOld?.responseViolations
        )
          ?.slice(0, 3)
          .map((entry) => `${entry.pointer} ${entry.message}`)
          .join("; ");
        site.fault ??= `${direct.status >= 400 ? "request" : "response"}: ${reasons ?? `status ${direct.status}`}`;
        continue;
      }

      // Arm b: the new API, unadapted.
      newMock.reset();
      const unadapted = await newMock.fetch(requestFor(old, sample));
      const answered = await bodyOf(unadapted);
      const unadaptedViolations =
        unadapted.status < 400 && answered !== undefined
          ? oldOracle.response(old, unadapted.status, answered)
          : undefined;
      if (unadapted.status >= 400 || (unadaptedViolations?.length ?? 0) > 0) {
        site.brokenWithout += 1;
      }

      // Arm c: the same, through the adapter.
      newMock.reset();
      const adapted = await proxy(requestFor(old, sample, "http://proxy.test"));
      const judged = newMock.log[0];
      const body = await bodyOf(adapted);
      if (retired) {
        if (judged || adapted.status !== 410) {
          violation("not-retired", adapted.status, JSON.stringify(body ?? null));
        }
        continue;
      }
      if (!judged) {
        violation("refused", adapted.status, JSON.stringify(body ?? null));
        continue;
      }
      if (judged.status === 400 || judged.status === 404) {
        violation(
          "rejected",
          judged.status,
          judged.request
            ?.map((entry) => `${entry.pointer} ${entry.message}`)
            .join("; ") ?? `no ${keyOf(current)} in the new contract`,
        );
        continue;
      }
      if (judged.responseValid === false) {
        site.unjudgeable += 1;
        continue;
      }
      if (adapted.status >= 400) {
        violation("refused", adapted.status, JSON.stringify(body ?? null));
        continue;
      }
      if (body === undefined) continue;
      const problems = oldOracle.response(old, adapted.status, body);
      if (problems && problems.length > 0) {
        violation(
          "response",
          adapted.status,
          problems.map((entry) => `${entry.pointer} ${entry.message}`).join("; "),
        );
      }
    }
  }
  return result;
}

/** The pairs the corpus run recorded as closing with at least one draft. */
async function closingPairs(): Promise<ManifestPair[]> {
  const recorded = JSON.parse(
    await readFile(join(ROOT, "proving/corpus/results.json"), "utf8"),
  ) as PairResult[];
  const closes = new Set(
    recorded
      .filter(
        (entry) =>
          entry.reached === "done" &&
          entry.breakingAligned > 0 &&
          entry.breakingAfter === 0 &&
          entry.drafts > 0 &&
          entry.compileIssues.length === 0,
      )
      .map((entry) => `${entry.api} ${entry.fromVersion} -> ${entry.toVersion}`),
  );
  return (await readManifest()).pairs.filter(
    (pair) =>
      closes.has(`${pair.api} ${pair.from.label} -> ${pair.to.label}`) &&
      (option("provider") === undefined || pair.provider === option("provider")) &&
      (option("api") === undefined || pair.api === option("api")),
  );
}

export function render(results: readonly TrafficResult[]): string {
  const all = results.flatMap((result) => result.sites);
  const sum = (list: readonly SiteResult[], pick: (site: SiteResult) => number) =>
    list.reduce((total, site) => total + pick(site), 0);
  const served = all.filter((site) => !site.retired);
  const retired = all.filter((site) => site.retired);
  const judged = served.filter((site) => site.samples > site.rigFaults);
  const proving = judged.filter((site) => site.brokenWithout > 0);
  const vacuous = judged.filter((site) => site.brokenWithout === 0);
  const violating = all.filter((site) => site.violations > 0);
  const lines = [
    "# Traffic through the adapter",
    "",
    "Rig C. For every corpus pair that closes, seeded requests shaped by the old",
    "contract are sent to a mock of the old API, to a mock of the new API, and",
    "to the new API through the proxy running the compiled program. Every",
    "verdict comes from an independent JSON Schema validator, not from the code",
    "under test. Generated by `pnpm proving:traffic`.",
    "",
    "## Result",
    "",
    `- ${results.length} closing pairs, ${results.filter((result) => result.error).length} could not be run`,
    `- **${violating.length} sites with violations through the adapter** (${sum(all, (site) => site.violations)} of ${sum(all, (site) => site.samples - site.rigFaults)} samples)`,
    "",
    "### Sites the adapter serves",
    "",
    `- ${served.length} sites, ${judged.length} judged`,
    `- ${proving.length} where the unadapted API broke the old caller, and so prove something`,
    `- ${vacuous.length} vacuous: the old caller was not broken without the adapter`,
    `- ${sum(served, (site) => site.rigFaults)} samples the rig could not judge: the old mock refused its own contract's request or response`,
    `- ${sum(served, (site) => site.unjudgeable)} samples whose generated response the new contract itself rejects`,
    "",
    "### Sites retired with guidance",
    "",
    `- ${retired.length} sites, a declared loss: each must answer 410 without reaching the API`,
    `- ${retired.filter((site) => site.violations > 0).length} did not`,
    "",
  ];
  if (violating.length > 0) {
    lines.push(
      "## Violations",
      "",
      "| Pair | Old site | Kinds | Example |",
      "|---|---|---|---|",
    );
    for (const result of results) {
      for (const site of result.sites.filter((entry) => entry.violations > 0)) {
        const kinds = Object.entries(site.kinds)
          .map(([kind, count]) => `${kind} ${count}`)
          .join(", ");
        const example = site.example
          ? `${site.example.status}: ${site.example.detail.replaceAll("|", "\\|").slice(0, 160)}`
          : "";
        lines.push(
          `| ${result.api} ${result.fromVersion} -> ${result.toVersion} | \`${site.old}\` | ${kinds} | ${example} |`,
        );
      }
    }
    lines.push("");
  }
  const faulted = results.flatMap((result) =>
    result.sites
      .filter((site) => site.fault !== undefined)
      .map((site) => ({ result, site })),
  );
  if (faulted.length > 0) {
    lines.push(
      "## Samples the rig could not judge",
      "",
      "The old mock could not produce, or refused, a value its own contract",
      "describes. Either the generator has a gap, or the contract contradicts",
      "itself; the first reason for each site says which.",
      "",
      "| Pair | Old site | Samples | First reason |",
      "|---|---|---|---|",
    );
    for (const { result, site } of faulted) {
      lines.push(
        `| ${result.api} ${result.fromVersion} -> ${result.toVersion} | \`${site.old}\` | ${site.rigFaults} of ${site.samples} | ${(site.fault ?? "").replaceAll("|", "\\|").slice(0, 200)} |`,
      );
    }
    lines.push("");
  }
  const errors = results.filter((result) => result.error);
  if (errors.length > 0) {
    lines.push("## Not run", "");
    for (const result of errors) {
      lines.push(
        `- ${result.api} ${result.fromVersion} -> ${result.toVersion}: ${result.error}`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const pairs = await closingPairs();
  console.log(`${pairs.length} closing pairs, ${SAMPLES} samples per adapted site\n`);
  const results: TrafficResult[] = [];
  for (const pair of pairs) {
    let result: TrafficResult;
    try {
      result = await runPair(pair);
    } catch (error) {
      result = {
        api: pair.api,
        provider: pair.provider,
        fromVersion: pair.from.label,
        toVersion: pair.to.label,
        changes: 0,
        error: error instanceof Error ? error.message : String(error),
        sites: [],
      };
    }
    results.push(result);
    const bad = result.sites.filter((site) => site.violations > 0).length;
    console.log(
      `${result.api} ${result.fromVersion} -> ${result.toVersion}: ${result.error ?? `${result.sites.length} sites, ${bad} violating`}`,
    );
  }
  await writeFile(RESULTS, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  const report = render(results);
  console.log(`\n${report}`);
  if (!partial) await writeFile(REPORT, report, "utf8");
  // A violation is an old caller the adapter failed, and fails the run.
  const violating = results.flatMap((result) =>
    result.sites.filter((site) => site.violations > 0),
  );
  if (violating.length > 0) {
    console.error(`${violating.length} sites with violations through the adapter`);
    process.exit(1);
  }
}
