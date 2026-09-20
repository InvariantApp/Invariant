/**
 * The compiled program: a projection of Changes against two contracts, and the
 * only thing the runtime ever reads.
 *
 * The runtime has no notion of direction. Backward transforms are produced by
 * inverting ops at compile time, so a program is always just an ordered list of
 * forward primitives. There are six of them, none can loop, call out, or
 * allocate unboundedly, and each carries the id of the Change it came from so a
 * single change can be counted and switched off on its own.
 */
import { type Static, Type } from "@sinclair/typebox";
import { IR_VERSION } from "./change.ts";

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

export const SetInstr = Type.Object(
  {
    k: Type.Literal("set"),
    path: Pointer,
    value: Type.Unknown(),
    /** True for a default that must not overwrite a value the caller supplied. */
    ifAbsent: Type.Boolean(),
    c: ChangeId,
  },
  { additionalProperties: false },
);

export const DelInstr = Type.Object(
  { k: Type.Literal("del"), path: Pointer, c: ChangeId },
  { additionalProperties: false },
);

export const Instr = Type.Union([
  MoveInstr,
  ScaleInstr,
  EnumInstr,
  CastInstr,
  SetInstr,
  DelInstr,
]);

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

export const SiteProgram = Type.Object(
  {
    /** Old shape to canonical, applied to a request body. */
    request: Type.Optional(Type.Array(Instr)),
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
  },
  { additionalProperties: false },
);

export type MoveInstr = Static<typeof MoveInstr>;
export type ScaleInstr = Static<typeof ScaleInstr>;
export type EnumInstr = Static<typeof EnumInstr>;
export type CastInstr = Static<typeof CastInstr>;
export type SetInstr = Static<typeof SetInstr>;
export type DelInstr = Static<typeof DelInstr>;
export type Instr = Static<typeof Instr>;
export type RouteRule = Static<typeof RouteRule>;
export type SiteProgram = Static<typeof SiteProgram>;
export type ContractProgram = Static<typeof ContractProgram>;
export type CompiledProgram = Static<typeof CompiledProgram>;

export function siteKey(method: string, path: string): string {
  return `${method.toLowerCase()} ${path}`;
}
