/**
 * Which SDK type implements each of a contract's schemas, and which SDK
 * method calls each of its operations.
 *
 * A migration pack rewrites a consumer's code through the SDK it imports, so
 * before it can act on a Change scoped to the schema `checkout.session` it
 * has to know that stripe-node calls it `Stripe.Checkout.Session` and
 * stripe-python `stripe.checkout.Session`. That map is made here from the
 * unpacked release and the contract it speaks, and nothing else: generator
 * metadata where the release records it, then naming conventions, then the
 * fields each type declares, and a judge for what is left tied. Every entry
 * says which of those found it and how sure it is.
 */
export {
  directoryCache,
  isCurrent,
  keyOf,
  memoryCache,
  type SymbolCache,
  type SymbolKey,
} from "./cache.ts";
export {
  cachedSymbols,
  contractParts,
  generateSymbols,
  identify,
  matchRelease,
  type Release,
  readRelease,
  type SymbolInput,
} from "./generate.ts";
export { detectGenerators } from "./generators.ts";
export {
  RulesSymbolJudge,
  type SymbolJudge,
  type TieAnswer,
  type TieCandidate,
  type TieQuestion,
} from "./judge.ts";
export { type GoSymbolRef, goSymbolsOf, symbolMapOf } from "./map.ts";
export { DEFAULT_THRESHOLD, type MatchOptions, matchTypes, overlapOf } from "./match.ts";
export { spellings } from "./names.ts";
export { matchOperations, normalizePath } from "./operations.ts";
export { readGo } from "./read/go.ts";
export { readPython } from "./read/python.ts";
export { readTypeScript } from "./read/typescript.ts";
export { type SchemaShape, schemaShapes } from "./schemas.ts";
export * from "./types.ts";
