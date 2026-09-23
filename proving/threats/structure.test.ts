/**
 * The rows of DESIGN 11.1 that are promises about what the code is, rather
 * than about what it does with a request: no code in the traffic path,
 * nothing to steal from a runtime, and a supply chain someone else cannot
 * change underneath a release.
 *
 * Read from the source and the workflows, so a commit that breaks one fails
 * here rather than in an audit.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { generateSigningKey, sign } from "@invariant-app/bundle";
import { parseDocumentText } from "@invariant-app/contract";
import { describe, expect, it } from "vitest";
import { ROOT } from "./harness.ts";

async function sources(dir: string): Promise<[string, string][]> {
  const out: [string, string][] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".ts") ||
      entry.name.endsWith(".test.ts")
    ) {
      continue;
    }
    const path = join(entry.parentPath, entry.name);
    out.push([path, await readFile(path, "utf8")]);
  }
  return out;
}

/** Comments removed, so prose about `eval` does not count as a use of it. */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** The packages a request passes through: the engine, and what it is allowed to import. */
const TRAFFIC_PATH = ["packages/runtime/src", "packages/decimal/src"];

describe("arbitrary code in the traffic path", () => {
  it("is impossible: nothing on the request path evaluates, imports or requires at run time", async () => {
    for (const dir of TRAFFIC_PATH) {
      for (const [path, text] of await sources(join(ROOT, dir))) {
        expect(code(text), path).not.toMatch(
          /\beval\s*\(|new\s+Function\s*\(|\bimport\s*\(|\brequire\s*\(|\bWebAssembly\b|\bFunction\s*\(\s*["'`]/,
        );
      }
    }
  });

  it("reaches no network, file or process from the engine", async () => {
    for (const dir of TRAFFIC_PATH) {
      for (const [path, text] of await sources(join(ROOT, dir))) {
        expect(code(text), path).not.toMatch(
          /\bfetch\s*\(|XMLHttpRequest|WebSocket\b|\bprocess\.|from\s+["']node:|from\s+["'](fs|net|http|https|child_process|vm|worker_threads)["']/,
        );
      }
    }
  });

  it("depends on nothing but exact decimal arithmetic, which depends on nothing", async () => {
    const runtime = JSON.parse(
      await readFile(join(ROOT, "packages/runtime/package.json"), "utf8"),
    );
    expect(Object.keys(runtime.dependencies ?? {})).toEqual(["@invariant-app/decimal"]);
    const decimal = JSON.parse(
      await readFile(join(ROOT, "packages/decimal/package.json"), "utf8"),
    );
    expect(Object.keys(decimal.dependencies ?? {})).toEqual([]);
  });
});

describe("secrets and what a compromised runtime holds", () => {
  it("the runtime reads no environment, so there is no credential in it to read", async () => {
    for (const dir of TRAFFIC_PATH) {
      for (const [path, text] of await sources(join(ROOT, dir))) {
        expect(code(text), path).not.toMatch(/process\.env|Deno\.env|Bun\.env/);
      }
    }
  });

  it("a signing key that will not load is refused without being repeated", () => {
    // What CI logs when INVARIANT_SIGNING_KEY is wrong must not be the key.
    const { privateKeyPem } = generateSigningKey();
    const damaged = privateKeyPem.replace(/[A-Za-z0-9+/]{16}/, (run) =>
      [...run].reverse().join(""),
    );
    const body = damaged.split("\n").find((line) => line.length > 40) as string;
    let message = "";
    try {
      sign("{}", damaged);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/signing key could not be read|signed with ed25519/);
    expect(message).not.toContain(body);
    expect(message).not.toContain("PRIVATE KEY");
  });

  it("the proxy takes the control plane's token only from the environment, by name", async () => {
    const config = await readFile(join(ROOT, "packages/sidecar/src/config.ts"), "utf8");
    // `tokenEnv` is the only way in; a `token` key is an unknown setting,
    // which proxy.test.ts shows the proxy refusing at start.
    expect(config).toMatch(/tokenEnv: string;/);
    expect(config).not.toMatch(/^\s*token\??: string;/m);
  });
});

interface Workflow {
  jobs: Record<
    string,
    {
      permissions?: Record<string, string>;
      steps?: { uses?: string; run?: string; env?: Record<string, string> }[];
    }
  >;
}

async function workflows(): Promise<[string, Workflow][]> {
  const dir = join(ROOT, ".github/workflows");
  const out: [string, Workflow][] = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".yml")) continue;
    out.push([
      name,
      parseDocumentText(
        name,
        await readFile(join(dir, name), "utf8"),
      ) as unknown as Workflow,
    ]);
  }
  return out;
}

describe("the supply chain", () => {
  it("pins every third-party action to a commit, not a tag its owner can move", async () => {
    const uses: string[] = [];
    for (const [name, workflow] of await workflows()) {
      for (const job of Object.values(workflow.jobs)) {
        for (const step of job.steps ?? [])
          if (step.uses) uses.push(`${name}: ${step.uses}`);
      }
    }
    const action = parseDocumentText(
      "action.yml",
      await readFile(join(ROOT, "action.yml"), "utf8"),
    ) as {
      runs?: { steps?: { uses?: string }[] };
    };
    for (const step of action.runs?.steps ?? []) {
      if (step.uses) uses.push(`action.yml: ${step.uses}`);
    }
    expect(uses.length).toBeGreaterThan(0);
    const floating = uses.filter(
      (entry) => !/: \.\/?$/.test(entry) && !/@[0-9a-f]{40}$/.test(entry),
    );
    expect(floating).toEqual([]);
  });

  it("installs only what the lockfile says, everywhere", async () => {
    const installs: string[] = [];
    for (const [name, workflow] of await workflows()) {
      for (const job of Object.values(workflow.jobs)) {
        for (const step of job.steps ?? []) {
          for (const line of (step.run ?? "").split("\n")) {
            if (/\b(pnpm|npm) (install|i|ci)\b/.test(line))
              installs.push(`${name}: ${line.trim()}`);
          }
        }
      }
    }
    expect(installs.length).toBeGreaterThan(0);
    expect(installs.filter((line) => !/--frozen-lockfile|\bnpm ci\b/.test(line))).toEqual(
      [],
    );
  });

  it("publishes to npm with provenance, from a token the workflow is issued, not a stored one", async () => {
    const release = (await workflows()).find(([name]) => name === "release.yml")?.[1];
    const job = release?.jobs["release"];
    expect(job?.permissions?.["id-token"]).toBe("write");
    const publish = job?.steps?.find((step) =>
      step.uses?.startsWith("changesets/action@"),
    );
    expect(publish?.env?.["NPM_CONFIG_PROVENANCE"]).toBe("true");
    expect(JSON.stringify(release)).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
  });

  it("scans every commit in the history for secrets on every push", async () => {
    const ci = (await workflows()).find(([name]) => name === "ci.yml")?.[1];
    const secrets = JSON.stringify(ci?.jobs["secrets"]);
    expect(secrets).toContain('"fetch-depth":0');
    expect(secrets).toContain('--log-opts=\\"--all\\"');
  });
});
