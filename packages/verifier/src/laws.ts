/**
 * The lens laws: what a Change has to be true of, on real values.
 *
 * Closure proves the shapes line up. It says nothing about what happens to a
 * value, because it never runs one. That gap is the whole reason this layer
 * exists, and it is worth being exact about which faults live on which side of
 * it.
 *
 * What closure catches and this does not: a scale exponent that contradicts
 * the declared precision, because the predicted `multipleOf` will not match.
 *
 * What this catches and closure cannot, because the thing at fault is not in
 * either specification to be compared:
 *
 *  - a constant. A `remove` declares what to put back and an `add` declares
 *    what to fill in, and both live in the Change rather than in a schema. A
 *    restore value outside the old contract's vocabulary hands an old consumer
 *    a value it has never heard of; a default outside the new contract's is a
 *    request the provider's own handler will refuse.
 *  - a codec that is not total. The contract allows a value, the conversion
 *    refuses it, and every caller who sends one gets an error.
 *  - a value map that leaves part of the vocabulary uncovered, so a resource
 *    in that state cannot be expressed at all.
 *
 * Underneath all three is one property worth naming: the compiler transforms
 * schemas in one place and values in another, and these laws are what keep the
 * two agreeing.
 *
 * What neither catches is a value map whose pairs are swapped, because a
 * swapped bijection round trips perfectly and preserves the set of values. The
 * differential check is the layer that catches it, and the test suite here says
 * so rather than implying otherwise.
 */
import { derive, schemaLens } from "@invariant-app/compiler";
import { type OpenApiDocument, schemaDirections } from "@invariant-app/contract";
import {
  type Change,
  type Instr,
  isSchemaScope,
  type JsonValue,
  parsePointer,
} from "@invariant-app/ir";
import fc from "fast-check";
import { schemaArbitrary } from "./arbitrary.ts";
import { type Evidence, inputsDigest } from "./evidence.ts";
import { checkParameterLaws } from "./parameter-laws.ts";
import { lensFor } from "./run.ts";
import { type Violation, validateAgainst } from "./validate.ts";

export interface LawOptions {
  /** How many values to try per Change per direction. */
  runs?: number;
  /** Fixed so a failure reproduces from the report alone. */
  seed?: number;
}

export const DEFAULT_RUNS = 500;

export interface LawFailure {
  changeId: string;
  scope: string;
  law: string;
  /** The value that broke it, ready to paste into a test. */
  counterexample: JsonValue;
  detail: string;
}

export interface LawReport {
  evidence: Evidence[];
  failures: LawFailure[];
}

/** Removes the pointers a declared loss is allowed to change, on both sides. */
function withoutLossy(value: unknown, pointers: readonly string[]): unknown {
  if (pointers.length === 0) return value;
  const copy = structuredClone(value);
  // `*` is every item of a list and `{}` every value of a map.
  const remove = (cursor: unknown, segments: readonly string[]): void => {
    if (cursor === null || typeof cursor !== "object") return;
    const [segment, ...rest] = segments;
    if (segment === undefined) return;
    const holder = cursor as Record<string, unknown>;
    const keys =
      (segment === "*" && Array.isArray(cursor)) ||
      (segment === "{}" && !Array.isArray(cursor))
        ? Object.keys(cursor)
        : [segment];
    for (const key of keys) {
      if (rest.length === 0) {
        if (!Array.isArray(cursor)) delete holder[key];
      } else {
        remove(holder[key], rest);
      }
    }
  };
  for (const pointer of pointers) remove(copy, parsePointer(pointer));
  return copy;
}

/**
 * Equality that ignores the order of an object's keys.
 *
 * A move deletes a field and writes it back, so a round trip returns the same
 * fields in a different order. That is not a difference an API consumer can
 * observe: JSON object members are unordered, and every parser on the other end
 * treats them that way. Comparing serialized text would report it as a failure
 * on every single Change that renames anything, which would make the law useless
 * long before it ever caught a real fault.
 */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, index) => sameJson(entry, b[index]));
  }

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(
    (key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]),
  );
}

function describe(violations: readonly Violation[]): string {
  return violations
    .slice(0, 5)
    .map((entry) => `${entry.pointer}: ${entry.message}`)
    .join("; ");
}

interface Case {
  scope: string;
  /**
   * Every Change that touches a value of this schema, in the order they were
   * declared: its own, and those of every schema nested inside it.
   */
  changes: Change[];
  forward: Instr[];
  backward: Instr[];
  lossy: { forward: string[]; backward: string[] };
  blocks: Record<string, Instr[]>;
}

/**
 * Groups Changes by the schema they touch, rather than checking each alone.
 *
 * A single Change does not have to produce a valid document on its own, and
 * expecting it to was a mistake worth recording. One Change renames a field;
 * another, in the same release, re-encodes a different one. Run the first by
 * itself and the result satisfies neither contract, because half the release is
 * missing. It is the composition that has to land inside the target contract,
 * and the composition per schema is exactly what the compiler projects onto a
 * site and what the runtime therefore executes.
 *
 * That composition includes the Changes to every schema nested inside it. A
 * required field added to a schema another one refers to is served inside the
 * other one's values too, and checking the outer schema without it once
 * reported a correct release as producing values the new contract refuses.
 */
function casesFor(
  oldContract: OpenApiDocument,
  predicted: OpenApiDocument,
  changes: readonly Change[],
): Case[] {
  const served = changes.filter((change) => derive(change).runtime !== "none");
  const scopes = new Set<string>();
  for (const change of served) {
    for (const scope of change.scopes ?? []) {
      if (isSchemaScope(scope)) scopes.add(scope.schema);
    }
  }
  return [...scopes].map((scope) => ({
    scope,
    ...schemaLens(oldContract, served, scope, predicted),
  }));
}

/**
 * Checks each schema's Changes against generated values of that schema.
 *
 * Three properties per direction, all of which a correct release satisfies and
 * at least one of which a wrong one usually does not:
 *
 *  - the transform completes at all, on every value the contract allows;
 *  - its output is a value the *target* contract allows;
 *  - undoing it returns the original, apart from the loss it declared.
 *
 * The target side is the *predicted* contract, not the real new one.
 *
 * A schema can be renamed between contracts, and a Change names the schema as
 * the old contract called it. The prediction is the old contract with the
 * declared Changes applied, so it keeps those names and can be indexed by the
 * same scope. Nothing is lost by using it: closure has already proved the
 * prediction and the real new contract agree, so a value that satisfies one
 * satisfies the other. Splitting it this way lets each check say exactly what
 * it proved.
 */
export function checkLaws(
  oldContract: OpenApiDocument,
  predicted: OpenApiDocument,
  changes: readonly Change[],
  options: LawOptions = {},
): LawReport {
  const runs = options.runs ?? DEFAULT_RUNS;
  const failures: LawFailure[] = [];
  const evidence: Evidence[] = [];

  for (const entry of casesFor(oldContract, predicted, changes)) {
    const ids = entry.changes.map((change) => change.id);
    const digest = inputsDigest(entry.changes, entry.scope, runs);
    const found: LawFailure[] = [];
    const label = ids.join(", ");
    // A half the runtime never runs proves nothing, and can fail on values no
    // caller can send: a field added to a schema only responses carry is
    // drafted with no value to send, because none is ever needed.
    const travels = schemaDirections(oldContract, entry.scope);

    try {
      // The composition the compiler projects onto a site, so the lens under
      // test is the one that will run.
      const lens = lensFor(entry.forward, entry.backward, entry.blocks);

      // Old shape to canonical and back. The values come from the contract the
      // caller was written against, which is exactly the traffic the adapter
      // will see.
      const outbound = !travels.request
        ? []
        : run(oldContract, entry.scope, runs, options.seed, (value) => {
            const canonical = lens.forward(value);
            const violations = validateAgainst(
              predicted,
              entry.scope,
              canonical as JsonValue,
            );
            if (violations.length > 0) {
              return `forward produced a value the new contract does not allow (${describe(violations)})`;
            }

            const returned = lens.backward(canonical);
            if (
              !sameJson(
                withoutLossy(returned, entry.lossy.forward),
                withoutLossy(value, entry.lossy.forward),
              )
            ) {
              return `undoing it did not return the original: ${JSON.stringify(returned)}`;
            }
            return undefined;
          });
      for (const failure of outbound) {
        found.push({
          ...failure,
          changeId: label,
          scope: entry.scope,
          law: "forward round trip",
        });
      }

      // Canonical to old shape and back. These are the values the provider's
      // own handler produces today, so a failure here is a response an old
      // consumer cannot be served.
      const inbound = !travels.response
        ? []
        : run(predicted, entry.scope, runs, options.seed, (value) => {
            const old = lens.backward(value);
            const violations = validateAgainst(
              oldContract,
              entry.scope,
              old as JsonValue,
            );
            if (violations.length > 0) {
              return `backward produced a value the old contract does not allow (${describe(violations)})`;
            }

            const returned = lens.forward(old);
            if (
              !sameJson(
                withoutLossy(returned, entry.lossy.backward),
                withoutLossy(value, entry.lossy.backward),
              )
            ) {
              return `re-applying it did not return the original: ${JSON.stringify(returned)}`;
            }
            return undefined;
          });
      for (const failure of inbound) {
        found.push({
          ...failure,
          changeId: label,
          scope: entry.scope,
          law: "backward round trip",
        });
      }
    } catch (error) {
      found.push({
        changeId: label,
        scope: entry.scope,
        law: "compiles to a loadable program",
        counterexample: null,
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    failures.push(...found);

    // Totality is a property of its own, even though one pass checks it
    // alongside the rest: every value the contract allows has to make it
    // through the transform at all. Recording it separately is what stops the
    // report claiming the check never ran when it plainly did.
    const refused = found.filter((failure) =>
      failure.detail.includes("refused a value the contract allows"),
    );
    evidence.push({
      kind: "E3-totality",
      subject: entry.scope,
      result: refused.length > 0 ? "fail" : "pass",
      inputsDigest: digest,
      tool: "fast-check",
      summary:
        refused.length > 0
          ? `the transform refused ${refused.length} ${refused.length === 1 ? "value" : "values"} the contract allows`
          : `no generated value of ${entry.scope} was refused, in ${travels.request && travels.response ? "either direction" : "the direction it travels"}`,
      ...(refused.length > 0 ? { detail: refused.map((failure) => failure.detail) } : {}),
    });

    evidence.push({
      kind: "E4-laws",
      subject: entry.scope,
      result: found.length > 0 ? "fail" : "pass",
      inputsDigest: digest,
      tool: "fast-check",
      summary:
        found.length > 0
          ? `${found.length} of the laws failed on ${entry.scope}`
          : `${label} round trip on ${runs} generated values of ${entry.scope}, ${
              travels.request && travels.response
                ? "in both directions"
                : travels.request
                  ? "from the old contract to the new, the only way it travels"
                  : travels.response
                    ? "from the new contract to the old, the only way it travels"
                    : "which no request or response carries"
            }`,
      ...(found.length > 0
        ? { detail: found.map((failure) => `${failure.law}: ${failure.detail}`) }
        : {}),
    });
  }

  // Parameters travel only from caller to provider, so theirs is the forward
  // half alone, checked on whole requests.
  const parameters = checkParameterLaws(oldContract, predicted, changes, {
    runs,
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  });
  evidence.push(...parameters.evidence);
  failures.push(...parameters.failures);

  return { evidence, failures };
}

/**
 * Runs one property and reports the shrunk counterexample.
 *
 * A refusal from the interpreter counts as a failure rather than an expected
 * outcome: the input came from the contract's own schema, so refusing it means
 * the program is not total over the traffic it will actually receive.
 */
function run(
  document: OpenApiDocument,
  ref: string,
  runs: number,
  seed: number | undefined,
  property: (value: JsonValue) => string | undefined,
): Omit<LawFailure, "changeId" | "scope" | "law">[] {
  const why = (value: JsonValue): string | undefined => {
    try {
      return property(value);
    } catch (error) {
      return `the transform refused a value the contract allows: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  };

  const result = fc.check(
    fc.property(schemaArbitrary(document, ref), (value) => why(value) === undefined),
    { numRuns: runs, ...(seed === undefined ? {} : { seed }) },
  );

  if (!result.failed) return [];

  // fast-check shrinks before reporting, so the value in hand is the smallest
  // one that still breaks the law. The reason is recomputed from that value
  // rather than remembered from whichever larger value happened to fail first,
  // so the message and the counterexample in the report describe one run.
  const shrunk = (result.counterexample?.[0] ?? null) as JsonValue;
  return [{ counterexample: shrunk, detail: why(shrunk) ?? "the property did not hold" }];
}
