/**
 * Running compiled primitives outside a request.
 *
 * The verifier drives the very runtime that ships, through its ordinary entry
 * points: the same program decoder, the same parser, the same interpreter. A
 * property test written against a separate "test interpreter" would only prove
 * things about the test interpreter, which is the mistake this avoids.
 */
import type { Instr } from "@invariant-app/ir";
import {
  createRuntime,
  type DecodedSite,
  type InvariantRuntime,
} from "@invariant-app/runtime";

const METHOD = "post";
const PATH = "/verify";
const STATUS = 200;
const LABEL = "old";

export interface Lens {
  /** Old shape to canonical, as a request would be transformed. */
  forward: (value: unknown) => unknown;
  /** Canonical back to old shape, as a response would be. */
  backward: (value: unknown) => unknown;
}

/**
 * A pair of directions as plain functions over parsed JSON.
 *
 * Building the program goes through the decoder, which is where a pointer
 * naming `__proto__`, an unknown primitive, or an unbounded wildcard is
 * refused. That means the verifier can never test a program the runtime would
 * have rejected at load time.
 *
 * A value that is neither an object nor a list is run from inside a body, as
 * every site that carries one holds it: a named vocabulary such as Qdrant's
 * `UpdateStatus` is always some object's field. Run as a whole body, the
 * runtime has nothing to write it back into, and a fold the provider decided
 * looked as if it never ran.
 */
export function lensFor(
  forward: readonly Instr[],
  backward: readonly Instr[],
  blocks: Readonly<Record<string, Instr[]>> = {},
): Lens {
  const whole = siteFor(forward, backward, blocks);
  const inside = siteFor(
    forward.length > 0 ? [within(forward)] : [],
    backward.length > 0 ? [within(backward)] : [],
    blocks,
  );
  const context = { contract: LABEL, operation: "verify" };
  const held = (value: unknown) => value === null || typeof value !== "object";
  const run = (
    value: unknown,
    transform: (target: Built, body: string) => string,
  ): unknown =>
    held(value)
      ? (
          JSON.parse(transform(inside, JSON.stringify({ [HOLDER]: value }))) as Record<
            string,
            unknown
          >
        )[HOLDER]
      : JSON.parse(transform(whole, JSON.stringify(value)));

  return {
    forward: (value) =>
      run(value, ({ runtime, site }, body) =>
        runtime.transformRequest(site, body, context),
      ),
    backward: (value) =>
      run(value, ({ runtime, site }, body) =>
        runtime.transformResponse(site, STATUS, body, context),
      ),
  };
}

/** The field a value that is not a body is carried in. */
const HOLDER = "value";

const within = (block: readonly Instr[]): Instr => ({
  k: "within",
  path: `/${HOLDER}`,
  block: [...block],
  c: "verify",
});

interface Built {
  runtime: InvariantRuntime;
  site: DecodedSite;
}

function siteFor(
  forward: readonly Instr[],
  backward: readonly Instr[],
  blocks: Readonly<Record<string, Instr[]>>,
): Built {
  const runtime: InvariantRuntime = createRuntime({
    program: {
      irVersion: 2,
      api: "verify",
      current: "sha256:0",
      currentLabel: "current",
      contracts: {
        [LABEL]: {
          label: LABEL,
          routes: [],
          sites: {
            [`${METHOD} ${PATH}`]: {
              ...(forward.length > 0 ? { request: [...forward] } : {}),
              ...(backward.length > 0
                ? { response: { [String(STATUS)]: [...backward] } }
                : {}),
            },
          },
          ...(Object.keys(blocks).length > 0 ? { blocks: { ...blocks } } : {}),
          behaviors: [],
        },
      },
    },
    identity: [{ kind: "default", label: LABEL }],
  });

  const site: DecodedSite | undefined = runtime.siteFor(LABEL, METHOD, PATH);
  if (!site) throw new Error("the verifier built a program with no site in it");
  return { runtime, site };
}
