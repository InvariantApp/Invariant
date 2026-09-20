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
    /** [old, new] pairs. Must be bijective in IR version 1. */
    pairs: Type.Array(Type.Tuple([Type.String(), Type.String()]), { minItems: 1 }),
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

export const Endpoint = Type.Object(
  {
    method: Type.Union([
      Type.Literal("get"),
      Type.Literal("post"),
      Type.Literal("put"),
      Type.Literal("patch"),
      Type.Literal("delete"),
    ]),
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

export const Op = Type.Union([MoveOp, ConvertOp, AddOp, RemoveOp, RouteOp, BehaviorOp]);

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
    ]),
  },
  { additionalProperties: false },
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
export type RouteOp = Static<typeof RouteOp>;
export type BehaviorOp = Static<typeof BehaviorOp>;
export type Op = Static<typeof Op>;
export type SchemaScope = Static<typeof SchemaScope>;
export type ParameterScope = Static<typeof ParameterScope>;
export type Scope = Static<typeof Scope>;
export type Assertions = Static<typeof Assertions>;
export type Provenance = Static<typeof Provenance>;
export type JudgeKind = Static<typeof JudgeKind>;
export type Change = Static<typeof Change>;

export type DataOp = MoveOp | ConvertOp | AddOp | RemoveOp;

export function isDataOp(op: Op): op is DataOp {
  return op.op === "move" || op.op === "convert" || op.op === "add" || op.op === "remove";
}

export function isSchemaScope(scope: Scope): scope is SchemaScope {
  return "schema" in scope;
}

/** How safely a Change can be served at runtime, derived by the compiler. */
export type RuntimeClass = "exact" | "declared-lossy" | "none";

/** How safely a Change can be migrated in source, derived by the compiler. */
export type SourceClass = "deterministic" | "assisted" | "manual";
