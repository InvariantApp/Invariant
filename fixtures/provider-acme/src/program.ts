import program from "../invariant/compiled/program.json" with { type: "json" };

/**
 * The compiled program, imported from the build rather than fetched.
 *
 * This is the point of shipping it inside the provider's own artifact: serving
 * an old contract needs no network call, no cache, and no dependency on
 * Invariant being reachable.
 */
export const ACME_PROGRAM: unknown = program;
