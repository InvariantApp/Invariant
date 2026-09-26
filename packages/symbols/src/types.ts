/**
 * The shapes a symbol map is made of.
 *
 * A reader turns an unpacked SDK release into declarations, a matcher pairs
 * them with the contract's schemas and operations, and every pairing says how
 * it was found and how sure it is, so a person reading the map can check the
 * one entry they doubt without rerunning anything.
 */

export type Language = "typescript" | "python" | "go";

/**
 * The code generators whose output is recognised. `stripe` is Stripe's own
 * generator, which writes stripe-node, stripe-python and stripe-go.
 */
export type GeneratorId =
  | "stainless"
  | "stripe"
  | "openapi-typescript"
  | "openapi-generator"
  | "speakeasy"
  | "fern";

/**
 * How an entry was found, strongest first:
 * - `metadata`: the SDK records the schema itself, as openapi-typescript's
 *   `components["schemas"]["pet"]` or Stripe's `object: 'checkout.session'`.
 * - `name`: a naming convention spells the schema's name as the type's.
 * - `structure`: the type's fields are the schema's properties.
 * - `judge`: several candidates were equally good and a judge chose.
 */
export type Via = "metadata" | "name" | "structure" | "judge";

/** One type, class, interface or struct an SDK declares. */
export interface Declaration {
  /**
   * The name a consumer's code reaches it by: `Stripe.Checkout.Session`,
   * `anthropic.types.beta.BetaMessage`, `components["schemas"]["pet"]`, or
   * for Go the type's own name in its package (`CheckoutSession`).
   */
  qualified: string;
  /** Its own name, the last segment of `qualified`. */
  name: string;
  /**
   * `object` for anything with fields, `alias` for a name given to some other
   * type (a union, a primitive), which only a schema that is not an object
   * with properties can be, unless it is a union of `variants`.
   */
  kind: "object" | "alias";
  /**
   * For an alias that is a union of object types, those types by their
   * qualified names. Such a union can implement an object schema, as
   * stripe-node from 22 declares `type Event = AccountUpdatedEvent | ...`
   * for the schema `event`, and its fields and pinned values are those
   * every variant shares.
   */
  variants?: string[];
  /**
   * The wire names of its fields, where the SDK records them: its own
   * property names, or the alias a generator gave a renamed field.
   * Absent when the reader cannot tell, as for an alias.
   */
  fields?: string[];
  /**
   * Fields pinned to one literal value, as Stripe's `object: 'invoice'` or
   * Stainless's `type: Literal["message"]`. A schema whose property is
   * pinned to another value is never this type.
   */
  constants?: Record<string, string>;
  /** The declaration this one is nested in, by its qualified name. */
  parent?: string;
  /** The declarations it extends, by their qualified names, where the reader resolved them. */
  extends?: string[];
  /**
   * A type only a request is built from: a `TypedDict`, as Stainless's and
   * Speakeasy's Python request types are. Names ending in `Param`, `Params`
   * or `TypedDict` are taken as such too.
   */
  input?: boolean;
  /**
   * Re-exported by a package, as against reached only through the module that
   * defines it (Python), where the reader can tell.
   */
  exported?: boolean;
  /** For Go, the package's path inside the module, `""` for its root. */
  package?: string;
  /** The schema its generator says it was generated from, where it says. */
  schema?: string;
  /** Where it is declared, relative to the SDK's root. */
  file: string;
}

/** An SDK method, and the HTTP call its body makes. */
export interface CallSite {
  /** The class, interface or Go receiver type the method is declared on. */
  type: string;
  method: string;
  /** Lower case, as `post`. */
  verb: string;
  /** The path as the SDK writes it, each interpolation as `{}`. */
  path: string;
  /** The operation's id, where the SDK records it beside the call (Speakeasy does). */
  operationId?: string;
  /** The helper that makes the call, where the method delegates it. */
  through?: string;
  /** For Go, the package's path inside the module. */
  package?: string;
  file: string;
  /**
   * Whether the SDK declares the call as data rather than code, as
   * stripe-node's `stripeMethod({ method, fullPath })` or a generated
   * README's table of endpoints.
   */
  declared?: boolean;
}

export interface SymbolEntry {
  /** The declaration's qualified name. */
  symbol: string;
  via: Via;
  /** 0 to 1. */
  confidence: number;
  /** Why, in words a reviewer can check against the SDK. */
  evidence: string;
  /**
   * Share of the schema's properties and the type's fields in common
   * (shared over both together), where both are known.
   */
  overlap?: number;
  /** For Go, the package's path inside the module. */
  package?: string;
  file: string;
}

export interface OperationEntry {
  type: string;
  method: string;
  via: Via;
  confidence: number;
  evidence: string;
  package?: string;
  file: string;
}

/** Bumped whenever a change here could change what a map says. */
export const SYMBOLS_ENGINE = "symbols/1";

/** A generated symbol map with the reasons for every entry. */
export interface GeneratedSymbols {
  /** The format of this object. */
  formatVersion: 1;
  package: string;
  version: string;
  language: Language;
  /** The digest of the contract the release speaks. */
  contract: string;
  /** The generators the release's own files say produced it. */
  generators: GeneratorId[];
  /** What produced this map, so a cached one from older code is not reused. */
  engine: string;
  /** The judge's fingerprint, for the same reason. */
  judge: string;
  /** Schema name to the SDK type that implements it. */
  types: Record<string, SymbolEntry>;
  /** `method path` as the contract spells it, to the SDK method that calls it. */
  operations: Record<string, OperationEntry>;
  /** Schemas no strategy could place, each with why. */
  unmatched: Record<string, string>;
}
