/**
 * Chain equivalence: one pass has to mean the same thing as several.
 *
 * A consumer four contracts behind is served by a program compiled once at
 * build time, rather than by four transforms looked up and run in sequence per
 * request. That is the whole reason the chaining is cheap, and it is only safe
 * if the two are the same function.
 *
 * The program that ships links each contract's work to the next contract's
 * through shared blocks, so it stays linear in its history. Linking and
 * concatenating are correct by an argument about order, which is a good
 * argument and not a proof. This runs the program that ships against each step
 * run alone, on values generated from the historical contract the consumer
 * actually speaks, so the argument has something behind it. It is also the gate
 * the design promised for any future optimising flattener: whatever that
 * produces has to pass this unchanged.
 */
import { type ContractStep, chainProgram, projectStep } from "@invariant/compiler";
import { type OpenApiDocument, operationsOf } from "@invariant/contract";
import {
  type ContractProgram,
  type Instr,
  isJsonObject,
  type JsonValue,
  siteKey,
} from "@invariant/ir";
import fc from "fast-check";
import { schemaArbitrary } from "./arbitrary.ts";
import { type Evidence, inputsDigest } from "./evidence.ts";
import { lensFor } from "./run.ts";

export interface EquivalenceFailure {
  contract: string;
  site: string;
  direction: "request" | "response";
  counterexample: JsonValue;
  detail: string;
}

export interface EquivalenceReport {
  evidence: Evidence[];
  failures: EquivalenceFailure[];
}

function requestSchemaRef(
  document: OpenApiDocument,
  method: string,
  path: string,
): string | undefined {
  const paths = document["paths"];
  if (!isJsonObject(paths)) return undefined;
  const item = paths[path];
  if (!isJsonObject(item)) return undefined;
  const operation = item[method];
  if (!isJsonObject(operation)) return undefined;
  const body = operation["requestBody"];
  if (!isJsonObject(body)) return undefined;
  const content = body["content"];
  if (!isJsonObject(content)) return undefined;
  const json = content["application/json"];
  if (!isJsonObject(json)) return undefined;
  const schema = json["schema"];
  if (!isJsonObject(schema)) return undefined;
  const ref = schema["$ref"];
  return typeof ref === "string" ? ref : undefined;
}

/** Runs one site's instructions as a single pass, with the blocks they call. */
function onePass(
  instrs: readonly Instr[],
  blocks: Readonly<Record<string, Instr[]>>,
): (value: JsonValue) => unknown {
  const lens = lensFor(instrs, [], blocks);
  return (value) => lens.forward(value);
}

/**
 * Compares the chained program against applying each step in turn.
 *
 * Only request bodies are compared. A response would need the canonical value
 * the provider produces, and generating one means generating against the
 * current contract and then knowing which site it came from; the differential
 * check covers responses with real values instead, which is stronger than
 * anything this could generate.
 */
export function checkChainEquivalence(
  steps: readonly ContractStep[],
  options: { runs?: number; seed?: number } = {},
): EquivalenceReport {
  const runs = options.runs ?? 200;
  const failures: EquivalenceFailure[] = [];
  const evidence: Evidence[] = [];
  const current = steps.at(-1)?.label ?? "";
  const linked = chainProgram("verify", current, "sha256:0", steps).program;
  const everyStep = steps.map(
    (step) => projectStep(step.label, step.from, step.changes, step.to).program,
  );

  steps.forEach((_step, index) => {
    const tail = steps.slice(index);
    const first = tail[0];
    if (!first) return;

    const label = first.parent;
    // A step from the current contract to itself serves nobody, so the program
    // has no contract for it and there is nothing to compare.
    const chained: ContractProgram | undefined = linked.contracts[label];
    if (!chained) return;
    const chainedBlocks = { ...linked.blocks, ...chained.blocks };
    const perStep = everyStep.slice(index);

    const found: EquivalenceFailure[] = [];

    for (const operation of operationsOf(first.from)) {
      const ref = requestSchemaRef(first.from, operation.method, operation.path);
      if (!ref) continue;

      // Where this endpoint ends up after every later route change, which is
      // the key the chained program filed it under.
      const finalKey = endpointAfter(perStep, operation.method, operation.path);
      const chainedSite = chained.sites[finalKey];
      const chainedRequest = chainedSite?.request ?? [];

      // The same work done the slow way: each step's own program, applied in
      // order, following the endpoint as the route changes move it.
      //
      // The route change is applied before the lookup, not after. A step files
      // its work under the endpoint the request has *arrived at*, because path
      // rewriting happens before routing and body rewriting after it. Looking
      // up the endpoint the request came from finds nothing and quietly drops
      // that step's work, which is a way of making this check pass by doing
      // less rather than by agreeing.
      const stages: Instr[][] = [];
      // Widened deliberately: a route rule's target method is whatever the
      // compiled program says, not necessarily one of the methods the old
      // contract happened to use.
      let cursor: { method: string; path: string } = {
        method: operation.method,
        path: operation.path,
      };
      for (const program of perStep) {
        cursor = moveEndpoint(program, cursor.method, cursor.path);
        stages.push(program.sites[siteKey(cursor.method, cursor.path)]?.request ?? []);
      }

      if (chainedRequest.length === 0 && stages.every((stage) => stage.length === 0)) {
        continue;
      }

      const single = onePass(chainedRequest, chainedBlocks);
      const staged = stages.map((stage, at) => onePass(stage, perStep[at]?.blocks ?? {}));

      const result = fc.check(
        fc.property(schemaArbitrary(first.from, ref), (value) => {
          const a = single(value);
          let b: JsonValue = value;
          for (const stage of staged) b = stage(b) as JsonValue;
          return JSON.stringify(a) === JSON.stringify(b);
        }),
        { numRuns: runs, ...(options.seed === undefined ? {} : { seed: options.seed }) },
      );

      if (result.failed) {
        const value = (result.counterexample?.[0] ?? null) as JsonValue;
        let staged_: JsonValue = value;
        for (const stage of staged) staged_ = stage(staged_) as JsonValue;
        found.push({
          contract: label,
          site: finalKey,
          direction: "request",
          counterexample: value,
          detail:
            `one pass gave ${JSON.stringify(single(value))} while ` +
            `${stages.length} steps in sequence gave ${JSON.stringify(staged_)}`,
        });
      }
    }

    failures.push(...found);
    evidence.push({
      kind: "E5-chain",
      subject: label,
      result: found.length > 0 ? "fail" : "pass",
      inputsDigest: inputsDigest(
        tail.map((step) => step.changes),
        runs,
      ),
      tool: "fast-check",
      summary:
        found.length > 0
          ? `${found.length} sites where one pass differs from ${tail.length} steps in sequence`
          : `one pass equals ${tail.length === 1 ? "the single step" : `${tail.length} steps in sequence`}, ` +
            `on ${runs} generated requests per endpoint`,
      ...(found.length > 0
        ? { detail: found.map((entry) => `${entry.site}: ${entry.detail}`) }
        : {}),
    });
  });

  return { evidence, failures };
}

function moveEndpoint(
  program: ContractProgram,
  method: string,
  path: string,
): { method: string; path: string } {
  for (const rule of program.routes) {
    if (rule.from.method === method && rule.from.path === path) return rule.to;
  }
  return { method, path };
}

function endpointAfter(
  programs: readonly ContractProgram[],
  method: string,
  path: string,
): string {
  let cursor = { method, path };
  for (const program of programs) {
    cursor = moveEndpoint(program, cursor.method, cursor.path);
  }
  return siteKey(cursor.method, cursor.path);
}
