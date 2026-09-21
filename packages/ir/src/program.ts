/**
 * The compiled program: a projection of Changes against two contracts, and the
 * only thing the runtime ever reads.
 *
 * The runtime has no notion of direction. Backward transforms are produced by
 * inverting ops at compile time, so a program is always just an ordered list of
 * forward primitives. None of them can call out or allocate
 * unboundedly, the only repetition follows the value being transformed, and
 * each carries the id of the Change it came from so a single change can be
 * counted and switched off on its own.
 */
import { type Static, Type } from "@sinclair/typebox";
import { IR_VERSION, StringCase, TimeFormat } from "./change.ts";

const Pointer = Type.String();
const ChangeId = Type.String();

export const MoveInstr = Type.Object(
  { k: Type.Literal("move"), from: Pointer, to: Pointer, c: ChangeId },
  { additionalProperties: false },
);

export const ScaleInstr = Type.Object(
  {
    k: Type.Literal("scale"),
    path: Pointer,
    /** Decimal-point shift. Negative undoes a positive one exactly. */
    exp: Type.Integer({ minimum: -9, maximum: 9 }),
    c: ChangeId,
  },
  { additionalProperties: false },
);

export const EnumInstr = Type.Object(
  {
    k: Type.Literal("enum"),
    path: Pointer,
    map: Type.Record(Type.String(), Type.String()),
    /**
     * Leaves an unmapped value alone instead of refusing.
     *
     * Only set for a field that names another field, such as the `param` an
     * error points at. For a value that is part of the contract, an unmappable
     * one means the response cannot be expressed and must fail; for a
     * diagnostic label, passing an unfamiliar name through is harmless and
     * failing the whole response over it would not be.
     */
    lenient: Type.Optional(Type.Boolean()),
    /**
     * Keys of `map` that are folds: values the new contract can produce and the
     * old one cannot name, substituted with one it can.
     *
     * A fold is the one transform that shows a caller something that is not
     * true, and they have no way to notice. Listing which keys are folds lets
     * the runtime mark a response in which one fired, so a caller who cares can
     * find out that the value they read is a stand-in.
     */
    folded: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
    c: ChangeId,
  },
  { additionalProperties: false },
);

export const CastInstr = Type.Object(
  {
    k: Type.Literal("cast"),
    path: Pointer,
    to: Type.Union([
      Type.Literal("string"),
      Type.Literal("integer"),
      Type.Literal("number"),
      Type.Literal("boolean"),
    ]),
    c: ChangeId,
  },
  { additionalProperties: false },
);

/** One instant re-encoded, exactly or refused. See `DateFormatCodec`. */
export const TimeInstr = Type.Object(
  {
    k: Type.Literal("time"),
    path: Pointer,
    from: TimeFormat,
    to: TimeFormat,
    /** Drop precision the target cannot hold instead of refusing the value. */
    truncate: Type.Optional(Type.Literal(true)),
    c: ChangeId,
  },
  { additionalProperties: false },
);

/** One identifier rewritten in another case, exactly or refused. See `StringCaseCodec`. */
export const CaseInstr = Type.Object(
  {
    k: Type.Literal("case"),
    path: Pointer,
    from: StringCase,
    to: StringCase,
    c: ChangeId,
  },
  { additionalProperties: false },
);

/** The value becomes a list holding it. */
export const WrapInstr = Type.Object(
  { k: Type.Literal("wrap"), path: Pointer, c: ChangeId },
  { additionalProperties: false },
);

/**
 * A list of exactly one item becomes the item, and any other length is
 * refused. With `first`, the first item is taken and an empty list is left
 * out.
 */
export const UnwrapInstr = Type.Object(
  {
    k: Type.Literal("unwrap"),
    path: Pointer,
    first: Type.Optional(Type.Literal(true)),
    c: ChangeId,
  },
  { additionalProperties: false },
);

export const SetInstr = Type.Object(
  {
    k: Type.Literal("set"),
    path: Pointer,
    value: Type.Unknown(),
    /** True for a default that must not overwrite a value the caller supplied. */
    ifAbsent: Type.Boolean(),
    /**
     * Write where the value is null. With `ifAbsent`, where it is either; on
     * its own, never where it is missing, so no field is created that was not
     * there.
     */
    ifNull: Type.Optional(Type.Literal(true)),
    c: ChangeId,
  },
  { additionalProperties: false },
);

export const DelInstr = Type.Object(
  {
    k: Type.Literal("del"),
    path: Pointer,
    /** Delete only a null, leaving any other value in place. */
    ifNull: Type.Optional(Type.Literal(true)),
    c: ChangeId,
  },
  { additionalProperties: false },
);

/** The kinds of value JSON has, for telling apart branches that differ only in kind. */
export const JsonType = Type.Union([
  Type.Literal("object"),
  Type.Literal("array"),
  Type.Literal("string"),
  Type.Literal("number"),
  Type.Literal("boolean"),
  Type.Literal("null"),
]);

/** A block shared by every place a schema sits, named in `ContractProgram.blocks`. */
const BlockName = Type.String({ minLength: 1, maxLength: 256 });

/**
 * The six primitives, and five that only choose where and whether they run.
 *
 * `within` runs a block at every place a pointer matches, with pointers in the
 * block read from there, so a Change to one element of a list is written once
 * for all of them. `switch` runs the block for the value a key holds, and
 * nothing for any other; `has` runs its block only where a field is present,
 * and `is` only where a value is of one JSON kind, as Stripe's expandable
 * fields are either an id or the object. Together they place a Change to one
 * variant of a union: at the union's position, for the values that are that
 * variant. The key is read once, as the block is entered, so nothing inside
 * the block can change which one ran.
 *
 * `call` runs a named block of the contract where it stands. A schema that
 * contains itself, or that sits in more places than can be listed, is served
 * by one block per schema that calls the blocks of the schemas inside it, so
 * the program follows the value rather than every path the schemas allow. A
 * block may call itself only from inside a `within` that descends, so every
 * recursion ends where the value does.
 */
export const Instr = Type.Recursive(
  (Self) =>
    Type.Union([
      MoveInstr,
      ScaleInstr,
      EnumInstr,
      CastInstr,
      TimeInstr,
      CaseInstr,
      WrapInstr,
      UnwrapInstr,
      SetInstr,
      DelInstr,
      Type.Object(
        {
          k: Type.Literal("within"),
          path: Pointer,
          block: Type.Array(Self),
          c: ChangeId,
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          k: Type.Literal("switch"),
          path: Pointer,
          cases: Type.Record(Type.String(), Type.Array(Self)),
          c: ChangeId,
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          k: Type.Literal("has"),
          path: Pointer,
          block: Type.Array(Self),
          /** Run where the field is missing instead: a branch told apart by what it never has. */
          absent: Type.Optional(Type.Literal(true)),
          c: ChangeId,
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          k: Type.Literal("is"),
          path: Pointer,
          type: JsonType,
          block: Type.Array(Self),
          c: ChangeId,
        },
        { additionalProperties: false },
      ),
      Type.Object(
        { k: Type.Literal("call"), block: BlockName, c: ChangeId },
        { additionalProperties: false },
      ),
    ]),
  { $id: "Instr" },
);

export const RouteRule = Type.Object(
  {
    from: Type.Object(
      { method: Type.String(), path: Type.String() },
      { additionalProperties: false },
    ),
    to: Type.Object(
      { method: Type.String(), path: Type.String() },
      { additionalProperties: false },
    ),
    c: ChangeId,
  },
  { additionalProperties: false },
);

/**
 * How one parameter is written on the wire, from its OpenAPI declaration.
 *
 * Carried for every parameter an envelope instruction reads or writes, and for
 * nothing else: a parameter no instruction names is passed on byte for byte,
 * however it is written.
 */
export const ParamCodec = Type.Object(
  {
    in: Type.Union([
      Type.Literal("path"),
      Type.Literal("query"),
      Type.Literal("header"),
      Type.Literal("cookie"),
    ]),
    /** As declared; a header's is lowercase. */
    name: Type.String({ minLength: 1 }),
    style: Type.Union([
      Type.Literal("simple"),
      Type.Literal("form"),
      Type.Literal("spaceDelimited"),
      Type.Literal("pipeDelimited"),
      Type.Literal("deepObject"),
    ]),
    explode: Type.Boolean(),
    /** What the value is, so `10` reaches an instruction as a number. */
    type: Type.Union([
      Type.Literal("string"),
      Type.Literal("integer"),
      Type.Literal("number"),
      Type.Literal("boolean"),
      Type.Literal("array"),
      Type.Literal("object"),
    ]),
    /** The element type of an array. */
    items: Type.Optional(
      Type.Union([
        Type.Literal("string"),
        Type.Literal("integer"),
        Type.Literal("number"),
        Type.Literal("boolean"),
      ]),
    ),
  },
  { additionalProperties: false },
);

/**
 * Old shape to canonical over the whole request, for an operation where a
 * Change reaches past the body.
 *
 * Instructions address the envelope, `/@query/limit` or `/@body/amount`, and
 * run as one ordered list. `old` says how each parameter they name is written
 * by an old caller, `new` how the current contract expects it; a name in
 * neither is never touched.
 */
export const EnvelopeProgram = Type.Object(
  {
    instrs: Type.Array(Instr),
    params: Type.Object(
      { old: Type.Array(ParamCodec), new: Type.Array(ParamCodec) },
      { additionalProperties: false },
    ),
    /** True when an instruction reaches into `/@body`, so the body is read. */
    body: Type.Boolean(),
  },
  { additionalProperties: false },
);

/**
 * How an operation's request body is written when it arrives form-encoded,
 * for the fields its program names.
 *
 * `fields` gives each top-level field's style; one not listed is a plain form
 * field, repeated for a list. `types` says what each place an instruction
 * reads holds, by pointer with `*` for list items, since a form carries every
 * value as text and a scale or a cast needs to see a number.
 */
export const FormProgram = Type.Object(
  {
    fields: Type.Record(
      Type.String(),
      Type.Object(
        {
          style: Type.Union([Type.Literal("form"), Type.Literal("deepObject")]),
          explode: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
    types: Type.Record(
      Type.String(),
      Type.Union([
        Type.Literal("string"),
        Type.Literal("integer"),
        Type.Literal("number"),
        Type.Literal("boolean"),
        Type.Literal("array"),
        Type.Literal("object"),
      ]),
    ),
  },
  { additionalProperties: false },
);

export const SiteProgram = Type.Object(
  {
    /**
     * Present when the operation's request body may arrive form-encoded. The
     * same instructions then run over the form, decoded and written back.
     */
    form: Type.Optional(FormProgram),
    /** Old shape to canonical, applied to a request body. */
    request: Type.Optional(Type.Array(Instr)),
    /**
     * Old shape to canonical over the whole request. Present instead of
     * `request` wherever a Change reaches a parameter.
     */
    envelope: Type.Optional(EnvelopeProgram),
    /**
     * Canonical back to old shape, keyed by status code or by the class
     * shorthands `2xx`, `4xx`, `5xx`. An exact code wins over its class.
     */
    response: Type.Optional(Type.Record(Type.String(), Type.Array(Instr))),
  },
  { additionalProperties: false },
);

export const ContractProgram = Type.Object(
  {
    label: Type.String(),
    /** Applied before routing, so an old path reaches the canonical handler. */
    routes: Type.Array(RouteRule),
    /** Keyed by the canonical `method path-template`, for example `post /v1/payments`. */
    sites: Type.Record(Type.String(), SiteProgram),
    /**
     * Canonical back to this contract's shape, for what the provider sends on
     * its own: keyed `method webhook:<name>` for a webhook, and
     * `method callback:<operation>/<callback>` for a callback. Run before the
     * payload is signed, so the signature is over what the subscriber reads.
     */
    outbound: Type.Optional(Type.Record(Type.String(), Type.Array(Instr))),
    /**
     * Instructions shared by every site, run by `call`: one per schema whose
     * values have to be followed rather than listed, because it contains
     * itself or sits in too many places.
     */
    blocks: Type.Optional(Type.Record(BlockName, Type.Array(Instr))),
    /**
     * The path this contract's API was served under, where it is not the
     * current one's: the version was in the server URL, as Google's
     * `/analytics/v2.4` became `/analytics/v3`. An old caller's request under
     * it is routed to the same path under the current one. Empty for an API
     * served at the root.
     */
    basePath: Type.Optional(Type.String({ pattern: "^(/.*[^/])?$" })),
    /** Changes on this step that no transform can express. */
    behaviors: Type.Array(Type.String()),
    /**
     * Endpoints this contract had and the current one does not.
     *
     * Carried so the runtime can refuse them by name. A caller on an old
     * contract hitting a retired endpoint would otherwise get a bare 404,
     * which is indistinguishable from a typo and says nothing about what to
     * do next.
     */
    retired: Type.Array(
      Type.Object(
        {
          method: Type.String(),
          path: Type.String(),
          guidance: Type.Optional(Type.String()),
          c: Type.String(),
          /**
           * Answer 410 without reaching the provider: the Change says the
           * server no longer serves the operation, or passing the call on
           * could reach a different operation of the new contract. Otherwise
           * the call is passed on, and only a 405 or 410 from the provider is
           * replaced with the guidance.
           */
          refuse: Type.Optional(Type.Literal(true)),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const CompiledProgram = Type.Object(
  {
    irVersion: Type.Literal(IR_VERSION),
    api: Type.String(),
    /** Digest of the canonical current contract this program targets. */
    current: Type.String(),
    /** Label of the canonical current contract. */
    currentLabel: Type.String(),
    /** Every historical contract still served, each compiled straight to current. */
    contracts: Type.Record(Type.String(), ContractProgram),
    /**
     * Blocks any contract may `call`: each step's shared blocks, and each
     * contract's work kept once for the older contracts that run it after
     * their own. Named after the step or contract that owns them.
     */
    blocks: Type.Optional(Type.Record(BlockName, Type.Array(Instr))),
    /**
     * The path the API is served under, from the contract's `servers`, such
     * as `/v1` for `https://api.example.com/v1`. The contract's paths are
     * relative to it, so it is taken off a request's path before matching,
     * and put back on any path the program rewrites.
     */
    basePath: Type.Optional(Type.String({ pattern: "^/.+" })),
  },
  { additionalProperties: false },
);

export type MoveInstr = Static<typeof MoveInstr>;
export type ScaleInstr = Static<typeof ScaleInstr>;
export type EnumInstr = Static<typeof EnumInstr>;
export type CastInstr = Static<typeof CastInstr>;
export type TimeInstr = Static<typeof TimeInstr>;
export type CaseInstr = Static<typeof CaseInstr>;
export type WrapInstr = Static<typeof WrapInstr>;
export type UnwrapInstr = Static<typeof UnwrapInstr>;
export type SetInstr = Static<typeof SetInstr>;
export type DelInstr = Static<typeof DelInstr>;
export type Instr = Static<typeof Instr>;
export type JsonType = Static<typeof JsonType>;
export type RouteRule = Static<typeof RouteRule>;
export type ParamCodec = Static<typeof ParamCodec>;
export type EnvelopeProgram = Static<typeof EnvelopeProgram>;
export type FormProgram = Static<typeof FormProgram>;
export type SiteProgram = Static<typeof SiteProgram>;
export type ContractProgram = Static<typeof ContractProgram>;
export type CompiledProgram = Static<typeof CompiledProgram>;

export function siteKey(method: string, path: string): string {
  return `${method.toLowerCase()} ${path}`;
}
