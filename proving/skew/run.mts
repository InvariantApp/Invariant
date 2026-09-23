/**
 * L17, the arm that needs a release: the runtime already on npm, which is
 * what a provider's service has installed, given programs from this commit's
 * compiler, which is what their CI produces the day they upgrade the CLI and
 * not the service.
 *
 * Every conformance vector and the fixture provider's compiled program are
 * loaded by both the published runtime and this commit's. Each must either
 * give the same answer from both, or be refused by the published one at load
 * with one of its typed errors. A different answer, or any other failure, is
 * what the gate exists to catch.
 *
 *   node --import tsx proving/skew/run.mts [--version <published version>]
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BRAND, minRuntimeFor } from "@invariant-app/ir";
import * as current from "@invariant-app/runtime";

const ROOT = join(import.meta.dirname, "../..");
const at = process.argv.indexOf("--version");
const wanted = at === -1 ? "latest" : process.argv[at + 1];

/** The refusals a runtime may give; anything else thrown is a failure of the gate. */
const TYPED = new Set([
  "ProgramError",
  "ProgramTooNewError",
  "TransformError",
  "MatchLimitError",
  "BodyTooLargeError",
]);

type Runtime = typeof current;

interface Case {
  name: string;
  program: unknown;
  contract: string;
  method: string;
  path: string;
  status: number;
  body: string;
}

export interface SkewResult {
  published: string;
  compiledBy: string;
  cases: number;
  same: number;
  refusedAtLoad: number;
  different: { name: string; published: string; current: string }[];
  untyped: { name: string; error: string }[];
}

function outcome(runtime: Runtime, entry: Case): { loaded: boolean; answer: string } {
  let instance: ReturnType<Runtime["createRuntime"]>;
  try {
    instance = runtime.createRuntime({
      program: entry.program,
      identity: [{ kind: "default", label: entry.contract }],
    });
  } catch (error) {
    return { loaded: false, answer: nameOf(error) };
  }
  const site = instance.siteFor(entry.contract, entry.method, entry.path);
  if (!site) return { loaded: true, answer: "no site" };
  try {
    return {
      loaded: true,
      answer: instance.transformResponse(site, entry.status, entry.body, {
        contract: entry.contract,
        operation: `${entry.method.toLowerCase()} ${entry.path}`,
      }),
    };
  } catch (error) {
    return { loaded: true, answer: nameOf(error) };
  }
}

function nameOf(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  return TYPED.has(name) ? `refused: ${name}` : `threw: ${String(error)}`;
}

/** The same shape the fuzzers use: one site running a vector's instructions. */
function vectorCases(compiledBy: string): Case[] {
  const { vectors } = JSON.parse(
    readFileSync(join(ROOT, "conformance/vectors.json"), "utf8"),
  ) as {
    vectors: {
      name: string;
      instrs: unknown[];
      blocks?: Record<string, unknown[]>;
      programBlocks?: Record<string, unknown[]>;
      input: unknown;
    }[];
  };
  return vectors.map((vector) => {
    const program = {
      irVersion: current.PROGRAM_VERSION,
      api: "skew",
      current: "sha256:skew",
      currentLabel: "new",
      ...(vector.programBlocks ? { blocks: vector.programBlocks } : {}),
      contracts: {
        old: {
          label: "old",
          routes: [],
          sites: { "post /skew": { request: [], response: { "2xx": vector.instrs } } },
          ...(vector.blocks ? { blocks: vector.blocks } : {}),
          behaviors: [],
          retired: [],
        },
      },
    };
    return {
      name: `vector: ${vector.name}`,
      // Stamped as the compiler stamps a program that runs these
      // instructions: one that needs a feature the published runtime predates
      // says so, and is refused at load rather than run.
      program: {
        ...program,
        compiledBy,
        minRuntime: minRuntimeFor(program as Parameters<typeof minRuntimeFor>[0]),
      },
      contract: "old",
      method: "POST",
      path: "/skew",
      status: 200,
      body: JSON.stringify(vector.input),
    };
  });
}

/** Every response site of the fixture's compiled program, fed a body it adapts. */
function fixtureCases(program: {
  contracts: Record<string, { sites: Record<string, unknown> }>;
}): Case[] {
  const body = JSON.stringify({
    id: "pay_1",
    amount_cents: 1234,
    currency: "usd",
    status: "succeeded",
    customer: { name: "Ada Lovelace" },
    data: [{ id: "pay_1", amount_cents: 1234, currency: "usd", status: "succeeded" }],
  });
  return Object.entries(program.contracts).flatMap(([label, contract]) =>
    Object.keys(contract.sites).map((key) => {
      const [method, path] = key.split(" ") as [string, string];
      const concrete = path.replace(/\{[^}]+\}/g, "pay_1");
      return {
        name: `fixture ${label}: ${key}`,
        program,
        contract: label,
        method: method.toUpperCase(),
        path: concrete,
        status: 200,
        body,
      };
    }),
  );
}

const work = mkdtempSync(join(tmpdir(), "invariant-skew-"));
try {
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      work,
      "--no-audit",
      "--no-fund",
      `${BRAND.scope}/runtime@${wanted}`,
    ],
    { stdio: "ignore", shell: process.platform === "win32" },
  );
  const require = createRequire(join(work, "package.json"));
  const entry = require.resolve(`${BRAND.scope}/runtime`);
  const published = (await import(pathToFileURL(entry).href)) as Runtime;
  const version = (
    JSON.parse(
      readFileSync(
        join(work, "node_modules", BRAND.scope, "runtime", "package.json"),
        "utf8",
      ),
    ) as { version: string }
  ).version;

  const compiled = JSON.parse(
    readFileSync(
      join(ROOT, "fixtures/provider-acme/invariant/compiled/program.json"),
      "utf8",
    ),
  );
  const cases = [...vectorCases(compiled.compiledBy), ...fixtureCases(compiled)];

  const result: SkewResult = {
    published: version,
    compiledBy: compiled.compiledBy,
    cases: cases.length,
    same: 0,
    refusedAtLoad: 0,
    different: [],
    untyped: [],
  };
  for (const entry of cases) {
    const old = outcome(published, entry);
    const now = outcome(current, entry);
    if (old.answer.startsWith("threw: ")) {
      result.untyped.push({ name: entry.name, error: old.answer.slice(7) });
    } else if (!old.loaded) {
      result.refusedAtLoad += 1;
    } else if (old.answer === now.answer) {
      result.same += 1;
    } else {
      result.different.push({
        name: entry.name,
        published: old.answer,
        current: now.answer,
      });
    }
  }
  writeFileSync(
    join(import.meta.dirname, "results.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  process.stdout.write(
    `runtime ${version} with programs from ${result.compiledBy}: ${result.same} same, ` +
      `${result.refusedAtLoad} refused at load, ${result.different.length} different, ` +
      `${result.untyped.length} untyped failures, of ${result.cases}\n`,
  );
  if (result.different.length > 0 || result.untyped.length > 0) process.exit(1);
} finally {
  rmSync(work, { recursive: true, force: true });
}
