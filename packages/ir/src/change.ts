/**
 * The Change: Invariant's single intermediate representation.
 *
 * A Change states, once, what a provider altered between two contracts. It is
 * bidirectional by construction, so the same declaration drives the request
 * transform (old shape to canonical), the response transform (canonical back to
 * old shape), the predicted new specification used for the closure check, and
 * the source codemods handed to consumers.
 *
 * Ops are written in old-to-new order. Applying them in order is the forward
 * direction; applying their inverses in reverse order is the backward
 * direction. That is the whole execution model.
 */
import { type Static, Type } from "@sinclair/typebox";

export const IR_VERSION = 1;

const Pointer = Type.String({
  pattern: "^(/(([^/~]|~[01])*|\\*))*$",
  description: "JSON Pointer, optionally using * to match every array element",
});

const Slug = Type.String({ pattern: "^[a-z][a-z0-9_]*$", maxLength: 128 });

/**
 * Codecs are the only place a value is allowed to change. Each one declares a
 * total, invertible mapping, or says exactly how it refuses.
 */
export const Scale10Codec = Type.Object(
  {
    kind: Type.Literal("scale10"),
    /** Forward multiplies by 10^exponent, so 2 turns major units into minor. */
    exponent: Type.Integer({ minimum: -9, maximum: 9 }),
    onInexact: Type.Literal("reject", {
      description: "Inexact input is refused rather than rounded.",
    }),
  },
  { additionalProperties: false },
);

export const EnumMapCodec = Type.Object(
  {
    kind: Type.Literal("enumMap"),
    /** [old, new] pairs, one per value the old contract names. Bijective. */
    pairs: Type.Array(Type.Tuple([Type.String(), Type.String()]), { minItems: 1 }),
    /**
     * [new, old] pairs for values the new contract can produce and the old one
     * cannot name. Applied to responses only.
     *
     * This is the commonest breaking change there is. Across 686 real version
     * pairs, a response enum gaining a value is the single largest category,
     * and it is two thirds of everything Stripe does to its callers. It was
     * called inexpressible here for a while, on the reasoning that a new value
     * has nothing to map back to. That is true of the documents and false of
     * the provider, who knows perfectly well which existing value an old caller
     * should be shown instead.
     *
     * Backward only, because the direction is not symmetric: a caller written
     * against the old contract cannot send a value that contract never named,
     * so there is nothing to fold on the way in.
     *
     * Always lossy. The old caller is told `processing` when the truth is
     * `pending_review`, and cannot tell the two apart. The compiler derives
     * `declared-lossy` from its presence and the gate asks for that in writing.
     */
    fold: Type.Optional(
      Type.Array(Type.Tuple([Type.String(), Type.String()]), { minItems: 1 }),
    ),
  },
  { additionalProperties: false },
);

export const ScalarType = Type.Union([
  Type.Literal("string"),
  Type.Literal("integer"),
  Type.Literal("number"),
  Type.Literal("boolean"),
]);

export const CastCodec = Type.Object(
  { kind: Type.Literal("cast"), from: ScalarType, to: ScalarType },
  { additionalProperties: false },
);

export const Codec = Type.Union([Scale10Codec, EnumMapCodec, CastCodec]);

/**
 * Every operation a path item can declare, in OpenAPI's own order.
 *
 * The list here used to stop at five, and so did the contract loader's, so an
 * API that declared HEAD or OPTIONS operations had them compared by the differ
 * and invisible to everything that acted on the comparison.
 */
export const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

export const Endpoint = Type.Object(
  {
    method: Type.Union(HTTP_METHODS.map((method) => Type.Literal(method))),
    path: Type.String({ pattern: "^/" }),
  },
  { additionalProperties: false },
);

export const MoveOp = Type.Object(
  { op: Type.Literal("move"), from: Pointer, to: Pointer },
  {
    additionalProperties: false,
    description: "Relocates a value. Covers rename, nest and unnest.",
  },
);

export const ConvertOp = Type.Object(
  { op: Type.Literal("convert"), path: Pointer, codec: Codec },
  {
    additionalProperties: false,
    description:
      "Re-encodes a value in place, at the path it holds after any earlier move.",
  },
);

export const AddOp = Type.Object(
  { op: Type.Literal("add"), path: Pointer, value: Type.Unknown() },
  {
    additionalProperties: false,
    description:
      "A field that is new in the target contract. Forward inserts `value` when absent; backward drops the field. The field's schema is taken from the new contract, so only the default lives here.",
  },
);

export const RemoveOp = Type.Object(
  { op: Type.Literal("remove"), path: Pointer, restore: Type.Unknown() },
  {
    additionalProperties: false,
    description:
      "A field the target contract dropped. Forward deletes it; backward restores `restore`.",
  },
);

export const DefaultOp = Type.Object(
  {
    op: Type.Literal("default"),
    path: Pointer,
    value: Type.Unknown(),
    when: Type.Union([
      Type.Literal("absent"),
      Type.Literal("null"),
      Type.Literal("absent-or-null"),
    ]),
    toward: Type.Union([Type.Literal("old"), Type.Literal("new")]),
  },
  {
    additionalProperties: false,
    description:
      "A field both contracts have, where one side may leave it out or null and the other may not. Values travelling toward the stricter side get `value` where the field is missing or null, as `when` says; the other direction is untouched. `toward: old` serves a field that became optional or nullable, `toward: new` one that became required or stopped being nullable.",
  },
);

export const DropNullOp = Type.Object(
  {
    op: Type.Literal("dropNull"),
    path: Pointer,
    toward: Type.Union([Type.Literal("old"), Type.Literal("new")]),
  },
  {
    additionalProperties: false,
    description:
      "An optional field one side allows to be null and the other does not. A null travelling toward the stricter side is deleted, so the field arrives left out; any other value is untouched. `toward: old` serves a field that became nullable, `toward: new` one that stopped being nullable. Only valid where the stricter side does not require the field.",
  },
);

/**
 * A union in a response that can now hold a variant old callers were never
 * told about.
 *
 * Nothing can make a new kind of object into an old one, so this is a
 * declared loss, as a fold is: the provider chooses what old callers see in
 * its place. `id` shows the object's id, which is what Stripe itself sends
 * for an expandable field the caller did not expand, and is only possible
 * where the old union already allows a string. `absent` leaves the field
 * out, where old callers could be sent it left out; `null`, where they could
 * be sent null. Requests are untouched: an old caller never sends a variant
 * its contract does not describe.
 */
export const WidenOp = Type.Object(
  {
    op: Type.Literal("widen"),
    path: Pointer,
    /** The new variant, as the new contract names it. */
    variant: Type.String({ pattern: "^#/components/schemas/" }),
    show: Type.Union([Type.Literal("id"), Type.Literal("absent"), Type.Literal("null")]),
  },
  {
    additionalProperties: false,
    description:
      "A response union gained `variant`. Old callers are shown a value of it as its `id`, left out, or as null, as `show` says; a declared loss.",
  },
);

/** The keywords that bound a value, which `relax` may change. */
export const CONSTRAINT_KEYWORDS = [
  "maximum",
  "minimum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "maxLength",
  "minLength",
  "maxItems",
  "minItems",
  "maxProperties",
  "minProperties",
  "pattern",
  "multipleOf",
  "uniqueItems",
] as const;

const Bound = Type.Union([Type.Number(), Type.Null()]);
const Count = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]);

/**
 * A bound on a value that moved, with nothing to translate.
 *
 * A response field whose maximum rose, or whose length limit went, can now
 * carry values an old caller's contract ruled out. Nothing should rewrite
 * them: clamping a number or cutting a string would hand the caller a value
 * the API never produced. So the op says what changed, the value passes
 * through as it is, and the provider acknowledges the loss: a caller that
 * validates strictly may reject what it is sent.
 *
 * It cannot say that a request's bound narrowed. An old caller would then be
 * refused for what its contract allowed, and pretending otherwise would let
 * the gate pass a release that breaks them; the compiler refuses it.
 */
export const RelaxOp = Type.Object(
  {
    op: Type.Literal("relax"),
    path: Pointer,
    /** Each keyword's new value, or null where the new contract has none. */
    set: Type.Object(
      {
        maximum: Type.Optional(Bound),
        minimum: Type.Optional(Bound),
        exclusiveMaximum: Type.Optional(Bound),
        exclusiveMinimum: Type.Optional(Bound),
        maxLength: Type.Optional(Count),
        minLength: Type.Optional(Count),
        maxItems: Type.Optional(Count),
        minItems: Type.Optional(Count),
        maxProperties: Type.Optional(Count),
        minProperties: Type.Optional(Count),
        pattern: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        multipleOf: Type.Optional(
          Type.Union([Type.Number({ exclusiveMinimum: 0 }), Type.Null()]),
        ),
        uniqueItems: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
      },
      { additionalProperties: false, minProperties: 1 },
    ),
  },
  {
    additionalProperties: false,
    description:
      "A bound on a value changed. Values pass through untouched; where a response may now carry values outside the old bound, that is a declared loss.",
  },
);

export const RouteOp = Type.Object(
  {
    op: Type.Literal("route"),
    from: Endpoint,
    to: Endpoint,
    operationId: Type.Optional(
      Type.Object(
        { from: Type.String(), to: Type.String() },
        { additionalProperties: false },
      ),
    ),
  },
  {
    additionalProperties: false,
    description: "Moves an operation to a new method and path.",
  },
);

/**
 * An operation that no longer exists.
 *
 * Added after running real APIs through the gate: whole endpoints disappearing
 * was the single commonest breaking change in the wild, and there was no way
 * to say it. `remove` works on a field inside a body; nothing spoke about the
 * operation itself, so a provider who retired an endpoint on purpose got the
 * same answer as one who broke it by accident.
 *
 * It carries no transform and it never could. There is no handler left to
 * reach, so an old caller cannot be served by any rewriting of their request.
 * What it does is let the provider say they meant it, and let the runtime
 * answer with something better than a bare 404: the contract the endpoint was
 * retired in, and what replaced it if anything.
 */
export const RetireOp = Type.Object(
  {
    op: Type.Literal("retire"),
    endpoint: Endpoint,
    /** What callers should use instead, in a sentence. Shown in the refusal. */
    guidance: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
    /**
     * The provider's server no longer serves this operation, so an old
     * caller is answered 410 without reaching it. Left unset, the call is
     * passed on and only an answer of 405 or 410 is replaced with the
     * guidance: a specification can drop an operation its server still
     * serves, as Qdrant 1.19 did with search, and a drafted retirement nobody
     * checked must not turn working calls into failures.
     */
    refuse: Type.Optional(Type.Boolean()),
  },
  {
    additionalProperties: false,
    description:
      "An operation that is gone. No transform can serve it; the runtime answers a caller with the provider's guidance instead of a bare 404.",
  },
);

export const BehaviorOp = Type.Object(
  {
    op: Type.Literal("behavior"),
    flag: Slug,
    /**
     * The breaking deltas this Change accounts for, each written exactly as the
     * gate prints it.
     *
     * This is the only way anything reaches a release without a transform
     * behind it, so it is deliberately the most tedious field in the IR. It is
     * a list, not a wildcard, and the gate refuses a release whose actual
     * unexplained deltas differ from it in either direction: something new that
     * nobody claimed, or a claim for something that is no longer there. Either
     * means the contract moved underneath an acknowledgement, and the person
     * who signed it has not seen what they are now signing.
     */
    covers: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
  },
  {
    additionalProperties: false,
    description:
      "A change no transform can express. Carries no adapter; the provider branches on the flag in its own code.",
  },
);

export const Op = Type.Union([
  MoveOp,
  ConvertOp,
  AddOp,
  RemoveOp,
  DefaultOp,
  DropNullOp,
  WidenOp,
  RelaxOp,
  RouteOp,
  RetireOp,
  BehaviorOp,
]);

/**
 * Where a Change's data ops apply. A schema scope names the schema in the OLD
 * contract; the compiler locates the matching place in the new contract by
 * position, so a renamed schema still resolves.
 */
export const SchemaScope = Type.Object(
  { schema: Type.String({ pattern: "^#/components/schemas/" }) },
  { additionalProperties: false },
);

export const ParameterScope = Type.Object(
  {
    operation: Type.String(),
    location: Type.Union([
      Type.Literal("query"),
      Type.Literal("path"),
      Type.Literal("header"),
      Type.Literal("cookie"),
      Type.Literal("body"),
    ]),
  },
  {
    additionalProperties: false,
    description:
      "Where a Change's data ops apply to one operation's request. A pointer names a parameter of this location, `/limit`, or with `body` a field of the operation's own request body, for a body declared inline rather than as a named schema. One starting with `@` names another part of the request, `/@header/x-limit` or `/@body/limit`, which is how a parameter moves between them.",
  },
);

export const Scope = Type.Union([SchemaScope, ParameterScope]);

export const Assertions = Type.Object(
  {
    same_concept: Type.Optional(Type.Boolean()),
    side_effects_unchanged: Type.Optional(Type.Boolean()),
    /** Required on any Change the compiler derives as declared-lossy. */
    loss_acknowledged: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const JudgeKind = Type.Union([
  Type.Literal("human"),
  Type.Literal("rules"),
  Type.Literal("jev"),
  Type.Literal("s2"),
]);

export const Provenance = Type.Object(
  {
    proposed_by: Type.Optional(
      Type.Object(
        {
          judge: JudgeKind,
          model: Type.Optional(Type.String()),
          confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
          question_set: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    structural: Type.Optional(Type.Array(Type.String())),
    confirmed_by: Type.Optional(
      Type.Object(
        {
          kind: Type.Literal("provider-merge"),
          commit: Type.String(),
          reviewer: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const Change = Type.Object(
  {
    irVersion: Type.Literal(IR_VERSION),
    id: Slug,
    summary: Type.String({ minLength: 1, maxLength: 400 }),
    scopes: Type.Optional(Type.Array(Scope)),
    ops: Type.Array(Op, { minItems: 1 }),
    assertions: Type.Optional(Assertions),
    provenance: Type.Optional(Provenance),
  },
  { additionalProperties: false },
);

export type Scale10Codec = Static<typeof Scale10Codec>;
export type EnumMapCodec = Static<typeof EnumMapCodec>;
export type CastCodec = Static<typeof CastCodec>;
export type Codec = Static<typeof Codec>;
export type ScalarType = Static<typeof ScalarType>;
export type Endpoint = Static<typeof Endpoint>;
export type MoveOp = Static<typeof MoveOp>;
export type ConvertOp = Static<typeof ConvertOp>;
export type AddOp = Static<typeof AddOp>;
export type RemoveOp = Static<typeof RemoveOp>;
export type DefaultOp = Static<typeof DefaultOp>;
export type DropNullOp = Static<typeof DropNullOp>;
export type WidenOp = Static<typeof WidenOp>;
export type RelaxOp = Static<typeof RelaxOp>;
export type RouteOp = Static<typeof RouteOp>;
export type RetireOp = Static<typeof RetireOp>;
export type BehaviorOp = Static<typeof BehaviorOp>;
export type Op = Static<typeof Op>;
export type SchemaScope = Static<typeof SchemaScope>;
export type ParameterScope = Static<typeof ParameterScope>;
export type Scope = Static<typeof Scope>;
export type Assertions = Static<typeof Assertions>;
export type Provenance = Static<typeof Provenance>;
export type JudgeKind = Static<typeof JudgeKind>;
export type Change = Static<typeof Change>;

export type DataOp =
  | MoveOp
  | ConvertOp
  | AddOp
  | RemoveOp
  | DefaultOp
  | DropNullOp
  | WidenOp
  | RelaxOp;

const DATA_OPS = new Set([
  "move",
  "convert",
  "add",
  "remove",
  "default",
  "dropNull",
  "widen",
  "relax",
]);

export function isDataOp(op: Op): op is DataOp {
  return DATA_OPS.has(op.op);
}

export function isSchemaScope(scope: Scope): scope is SchemaScope {
  return "schema" in scope;
}

/** How safely a Change can be served at runtime, derived by the compiler. */
export type RuntimeClass = "exact" | "declared-lossy" | "none";

/** How safely a Change can be migrated in source, derived by the compiler. */
export type SourceClass = "deterministic" | "assisted" | "manual";
