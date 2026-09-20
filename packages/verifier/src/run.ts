/**
 * Running compiled primitives outside a request.
 *
 * The verifier drives the very runtime that ships, through its ordinary entry
 * points: the same program decoder, the same parser, the same interpreter. A
 * property test written against a separate "test interpreter" would only prove
 * things about the test interpreter, which is the mistake this avoids.
 */
import type { Instr } from "@invariant/ir";
import {
  createRuntime,
  type DecodedSite,
  type InvariantRuntime,
} from "@invariant/runtime";

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
 */
export function lensFor(forward: readonly Instr[], backward: readonly Instr[]): Lens {
  const runtime: InvariantRuntime = createRuntime({
    program: {
      irVersion: 1,
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
          behaviors: [],
        },
      },
    },
    identity: [{ kind: "default", label: LABEL }],
  });

  const site: DecodedSite | undefined = runtime.siteFor(LABEL, METHOD, PATH);
  if (!site) throw new Error("the verifier built a program with no site in it");
  const context = { contract: LABEL, operation: "verify" };

  return {
    forward: (value) =>
      JSON.parse(
        runtime.transformRequest(site, JSON.stringify(value), context),
      ) as unknown,
    backward: (value) =>
      JSON.parse(
        runtime.transformResponse(site, STATUS, JSON.stringify(value), context),
      ) as unknown,
  };
}
