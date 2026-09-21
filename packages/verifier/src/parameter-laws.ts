/**
 * The laws for a parameter-scoped Change.
 *
 * A parameter only travels one way, from caller to provider, so there is no
 * round trip to check. What has to hold is the forward half: for every value
 * an old caller's contract lets them send, the rewrite completes, and every
 * parameter it writes is one the new contract declares and would accept.
 *
 * The values are written the way the old contract says each parameter is
 * written and read back the way the new contract does, through the runtime's
 * own encoder and decoder, so what is checked is the request the provider's
 * handler would actually receive.
 */
import {
  codecOf,
  findParameter,
  mapEndpoint,
  operationById,
  parametersOf,
  projectStep,
  routeMappings,
} from "@invariant/compiler";
import type { OpenApiDocument } from "@invariant/contract";
import {
  type Change,
  isDataOp,
  isJsonObject,
  type JsonValue,
  type ParamCodec,
  siteKey,
} from "@invariant/ir";
import {
  createRuntime,
  type ParameterValues,
  readParameters,
  writeParameters,
} from "@invariant/runtime";
import fc from "fast-check";
import { valueArbitrary } from "./arbitrary.ts";
import { type Evidence, inputsDigest } from "./evidence.ts";
import type { LawFailure, LawOptions } from "./laws.ts";
import { validateSchema } from "./validate.ts";

const LABEL = "old";
const LAW = "parameters land in the new contract";

/** Parameter-scoped Changes, grouped by the operation they name, in declared order. */
function byOperation(changes: readonly Change[]): Map<string, Change[]> {
  const groups = new Map<string, Change[]>();
  for (const change of changes) {
    if (!change.ops.some(isDataOp)) continue;
    for (const scope of change.scopes ?? []) {
      if ("schema" in scope) continue;
      const list = groups.get(scope.operation) ?? [];
      if (!list.includes(change)) list.push(change);
      groups.set(scope.operation, list);
    }
  }
  return groups;
}

export function checkParameterLaws(
  oldContract: OpenApiDocument,
  predicted: OpenApiDocument,
  changes: readonly Change[],
  options: LawOptions & { runs: number },
): { evidence: Evidence[]; failures: LawFailure[] } {
  const evidence: Evidence[] = [];
  const failures: LawFailure[] = [];
  const routes = routeMappings(changes);

  for (const [operationId, group] of byOperation(changes)) {
    const subject = `${operationId} parameters`;
    const label = group.map((change) => change.id).join(", ");
    const digest = inputsDigest(group, subject, options.runs);
    const found: LawFailure[] = [];
    const fail = (detail: string, counterexample: JsonValue) =>
      found.push({ changeId: label, scope: subject, law: LAW, counterexample, detail });

    const operation = operationById(oldContract, operationId);
    if (!operation) continue;
    const target = mapEndpoint(routes, operation.method, operation.path);
    const projected = projectStep(
      LABEL,
      oldContract,
      [...group, ...routeChanges(changes)],
      predicted,
    );
    const key = siteKey(target.method, target.path);
    const site = projected.program.sites[key];
    const envelope = site?.envelope;
    if (projected.issues.length > 0 || !envelope) {
      // The gate already reports why it cannot be compiled.
      continue;
    }

    const runtime = createRuntime({
      program: {
        irVersion: 1,
        api: "verify",
        current: "sha256:0",
        currentLabel: "current",
        contracts: {
          [LABEL]: {
            label: LABEL,
            routes: [],
            sites: { [key]: site },
            behaviors: [],
            retired: [],
          },
        },
      },
      identity: [{ kind: "default", label: LABEL }],
    });
    const decoded = runtime.siteFor(LABEL, target.method, target.path);
    if (!decoded) continue;

    const oldParams = parametersOf(oldContract, operation.method, operation.path);
    const newParams = parametersOf(predicted, target.method, target.path);
    const oldCodecs = envelope.params.old;
    // Read back every parameter the program names, as the new contract
    // declares it, including one only the program writes.
    const readCodecs: ParamCodec[] = [];
    const expected: { codec: ParamCodec; schema: JsonValue; required: boolean }[] = [];
    for (const named of [...envelope.params.old, ...envelope.params.new]) {
      const declared = findParameter(newParams, named.in, named.name);
      if (!declared) continue;
      const codec = codecOf(predicted, declared);
      if ("refused" in codec) continue;
      if (readCodecs.some((entry) => entry.in === codec.in && entry.name === codec.name))
        continue;
      const withName = { ...codec, name: named.name };
      readCodecs.push(withName);
      expected.push({
        codec: withName,
        schema: (declared["schema"] ?? {}) as JsonValue,
        required: declared["required"] === true,
      });
    }

    // What an old caller may send: each parameter the program reads, present
    // or not as its declaration allows.
    const arbitraries: Record<string, fc.Arbitrary<JsonValue | undefined>> = {};
    for (const codec of oldCodecs) {
      const declared = findParameter(oldParams, codec.in, codec.name);
      if (!declared) continue;
      const value = valueArbitrary(oldContract, (declared["schema"] ?? {}) as JsonValue);
      arbitraries[`${codec.in} ${codec.name}`] =
        declared["required"] === true || codec.in === "path"
          ? value
          : fc.option(value, { nil: undefined });
    }

    const why = (sent: Record<string, JsonValue | undefined>): string | undefined => {
      const values: ParameterValues = { path: {}, query: {}, header: {}, cookie: {} };
      for (const [name, value] of Object.entries(sent)) {
        if (value === undefined) continue;
        const [location, ...rest] = name.split(" ");
        values[location as keyof ParameterValues][rest.join(" ")] = value;
      }
      // A path parameter the program does not name keeps a placeholder.
      const request = writeParameters(oldCodecs, target.path, values);
      let out: ReturnType<typeof runtime.transformEnvelope>;
      try {
        out = runtime.transformEnvelope(decoded, request, {
          contract: LABEL,
          operation: "verify",
        });
      } catch (error) {
        return `the transform refused a value the contract allows: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      const landed = readParameters(readCodecs, target.path, out);
      for (const entry of expected) {
        const value = landed[entry.codec.in][entry.codec.name];
        if (value === undefined) {
          if (entry.required) {
            return `the ${entry.codec.in} parameter ${entry.codec.name} is required by the new contract and was not sent`;
          }
          continue;
        }
        const violations = validateSchema(predicted, entry.schema, value as JsonValue);
        if (violations.length > 0) {
          return `the ${entry.codec.in} parameter ${entry.codec.name} was sent as ${JSON.stringify(value)}, which the new contract does not allow (${violations[0]?.message ?? ""})`;
        }
      }
      return undefined;
    };

    const result = fc.check(
      fc.property(fc.record(arbitraries), (sent) => why(sent) === undefined),
      {
        numRuns: options.runs,
        ...(options.seed === undefined ? {} : { seed: options.seed }),
      },
    );
    if (result.failed) {
      const shrunk = (result.counterexample?.[0] ?? {}) as Record<
        string,
        JsonValue | undefined
      >;
      fail(why(shrunk) ?? "the property did not hold", clean(shrunk));
    }

    failures.push(...found);
    evidence.push({
      kind: "E4-laws",
      subject,
      result: found.length > 0 ? "fail" : "pass",
      inputsDigest: digest,
      tool: "fast-check",
      summary:
        found.length > 0
          ? `${label} sent a parameter the new contract does not accept`
          : `${label} rewrote ${options.runs} generated requests of ${operationId} into ones the new contract accepts`,
      ...(found.length > 0 ? { detail: found.map((failure) => failure.detail) } : {}),
    });
  }

  return { evidence, failures };
}

/** The Changes that move operations, which a parameter's site depends on. */
function routeChanges(changes: readonly Change[]): Change[] {
  return changes.filter(
    (change) => change.ops.some((op) => op.op === "route") && !change.ops.some(isDataOp),
  );
}

function clean(sent: Record<string, JsonValue | undefined>): JsonValue {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(sent)) {
    if (value !== undefined && isJsonObject(out)) out[key] = value;
  }
  return out;
}
