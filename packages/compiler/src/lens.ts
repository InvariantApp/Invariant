/**
 * The instructions one op compiles to, at a place in a body, and how they are
 * placed inside the unions on the way there.
 *
 * Shared by the projection onto sites, the blocks that follow a value through
 * schemas that contain themselves, and the verifier's lens, so all three run
 * the same instructions for the same op.
 */
import type { Guard, Site } from "@invariant-app/contract";
import {
  type Change,
  type Codec,
  type DataOp,
  type DefaultOp,
  type DropNullOp,
  formatPointer,
  type Instr,
  parsePointer,
  type WidenOp,
} from "@invariant-app/ir";

export function prefixed(prefix: string, path: string): string {
  return formatPointer([...parsePointer(prefix), ...parsePointer(path)]);
}

/**
 * A `default` op's one write, in whichever direction it faces. A value the
 * stricter side would accept is never touched: `ifAbsent` alone leaves a null
 * in place, and `ifNull` alone never creates a field that was missing.
 */
function fill(op: DefaultOp, prefix: string, changeId: string): Instr {
  return {
    k: "set",
    path: prefixed(prefix, op.path),
    value: op.value,
    ifAbsent: op.when !== "null",
    ...(op.when === "absent" ? {} : { ifNull: true as const }),
    c: changeId,
  };
}

function dropNull(op: DropNullOp, prefix: string, changeId: string): Instr {
  return { k: "del", path: prefixed(prefix, op.path), ifNull: true, c: changeId };
}

type ValueCodec = Extract<
  Codec,
  { kind: "dateFormat" | "stringCase" | "wrapArray" | "unwrapSingle" }
>;

/**
 * The codecs that are one instruction each way, the same instruction with its
 * ends swapped: an instant or a case read one way and written the other, a
 * value wrapped one way and unwrapped the other.
 */
function valueCodec(
  codec: ValueCodec,
  path: string,
  changeId: string,
  direction: "forward" | "backward",
): Instr {
  const forward = direction === "forward";
  switch (codec.kind) {
    case "dateFormat": {
      const truncate = codec.onInexact === "truncate" ? { truncate: true as const } : {};
      return forward
        ? { k: "time", path, from: codec.from, to: codec.to, ...truncate, c: changeId }
        : { k: "time", path, from: codec.to, to: codec.from, ...truncate, c: changeId };
    }
    case "stringCase":
      return forward
        ? { k: "case", path, from: codec.from, to: codec.to, c: changeId }
        : { k: "case", path, from: codec.to, to: codec.from, c: changeId };
    case "wrapArray":
    case "unwrapSingle": {
      // The list is on the new side for one and the old side for the other.
      const wraps = forward === (codec.kind === "wrapArray");
      if (wraps) return { k: "wrap", path, c: changeId };
      return {
        k: "unwrap",
        path,
        ...(codec.pick === "first" ? { first: true as const } : {}),
        c: changeId,
      };
    }
  }
}

/**
 * Whether an op can apply to a path parameter. A template has the parameters
 * it has, so one can be re-encoded in place or bounded differently, and
 * nothing else: not renamed, added, removed, or turned into a list.
 */
export function servesPathParameter(op: DataOp): boolean {
  if (op.op === "relax" || op.op === "restate") return true;
  return (
    op.op === "convert" &&
    op.codec.kind !== "wrapArray" &&
    op.codec.kind !== "unwrapSingle"
  );
}

export const PATH_PARAMETER_REFUSAL =
  "a path parameter can only be converted in place or given new bounds";

/**
 * An enum map read backwards: each new value shown to an old caller as the
 * old value it came from. Where two old values became one, and that one is
 * also a value the old contract names, it is shown as itself: Plaid stopped
 * accepting a report version old callers may still send, which a decision
 * sends as a version it keeps, and a response carrying the kept version was
 * never the one that went, which the API can no longer produce.
 */
function backwardPairs(
  pairs: readonly (readonly [string, string])[],
): Record<string, string> {
  const back: Record<string, string> = {};
  for (const [from, to] of pairs) {
    if (Object.hasOwn(back, to) && back[to] === to) continue;
    back[to] = from;
  }
  return back;
}

/** Old-shape-to-canonical primitives for one data op, at one pointer prefix. */
export function forwardInstrs(op: DataOp, prefix: string, changeId: string): Instr[] {
  switch (op.op) {
    case "move":
      return [
        {
          k: "move",
          from: prefixed(prefix, op.from),
          to: prefixed(prefix, op.to),
          c: changeId,
        },
      ];
    case "convert":
      switch (op.codec.kind) {
        case "scale10":
          return [
            {
              k: "scale",
              path: prefixed(prefix, op.path),
              exp: op.codec.exponent,
              c: changeId,
            },
          ];
        case "enumMap":
          return [
            {
              k: "enum",
              path: prefixed(prefix, op.path),
              map: Object.fromEntries(op.codec.pairs),
              c: changeId,
            },
          ];
        case "cast":
          return [
            { k: "cast", path: prefixed(prefix, op.path), to: op.codec.to, c: changeId },
          ];
        case "dropValues":
          return [
            {
              k: "drop",
              path: prefixed(prefix, op.path),
              values: op.codec.values,
              c: changeId,
            },
          ];
        default:
          return [valueCodec(op.codec, prefixed(prefix, op.path), changeId, "forward")];
      }
    case "add":
      // The caller was written before this field existed, so supply the default
      // without ever overwriting a value they did send.
      return [
        {
          k: "set",
          path: prefixed(prefix, op.path),
          value: op.value,
          ifAbsent: true,
          c: changeId,
        },
      ];
    case "remove":
      return [{ k: "del", path: prefixed(prefix, op.path), c: changeId }];
    case "default":
      return op.toward === "new" ? [fill(op, prefix, changeId)] : [];
    case "dropNull":
      return op.toward === "new" ? [dropNull(op, prefix, changeId)] : [];
    case "widen":
      // An old caller never sends a variant its contract does not describe.
      return [];
    case "relax":
      // A bound says which values are allowed; no value is changed by it.
      return [];
    case "restate":
      // The same values stated differently, proved when the Change compiled:
      // what an old caller sends is already what the new contract accepts.
      return [];
  }
  return [];
}

/**
 * How a widened union's new variant is told apart from the variants old
 * callers know, which only the documents can say. Undefined where nothing
 * does, and then nothing is compiled and the projection says why.
 */
export type VariantGuards = (op: WidenOp) => Guard | undefined;

const NO_VARIANTS: VariantGuards = () => undefined;

/** The value itself replaced as `show` says, by an instruction standing on it. */
function shown(op: WidenOp, changeId: string): Instr {
  switch (op.show) {
    case "id":
      return { k: "move", from: "/id", to: "", c: changeId };
    case "null":
      return { k: "set", path: "", value: null, ifAbsent: false, c: changeId };
    case "absent":
      return { k: "del", path: "", c: changeId };
  }
}

/** Runs `block` on a value only when the guard says it is the variant. */
function testing(guard: Guard, block: Instr[], changeId: string): Instr {
  if ("type" in guard) return { k: "is", path: "", type: guard.type, block, c: changeId };
  if ("key" in guard) {
    const chosen: Instr[] =
      guard.has !== undefined
        ? [{ k: "has", path: formatPointer([guard.has]), block, c: changeId }]
        : guard.lacks !== undefined
          ? [
              {
                k: "has",
                path: formatPointer([guard.lacks]),
                absent: true,
                block,
                c: changeId,
              },
            ]
          : block;
    return {
      k: "switch",
      path: guard.key,
      cases: Object.fromEntries(guard.values.map((value) => [value, chosen])),
      c: changeId,
    };
  }
  if ("lacks" in guard) {
    return {
      k: "has",
      path: formatPointer([guard.lacks]),
      absent: true,
      block,
      c: changeId,
    };
  }
  return { k: "has", path: formatPointer([guard.has]), block, c: changeId };
}

/** Canonical-back-to-old-shape primitives: each op's inverse. */
export function backwardInstrs(
  op: DataOp,
  prefix: string,
  changeId: string,
  variants: VariantGuards = NO_VARIANTS,
): Instr[] {
  switch (op.op) {
    case "move":
      return [
        {
          k: "move",
          from: prefixed(prefix, op.to),
          to: prefixed(prefix, op.from),
          c: changeId,
        },
      ];
    case "convert":
      switch (op.codec.kind) {
        case "scale10":
          return [
            {
              k: "scale",
              path: prefixed(prefix, op.path),
              exp: -op.codec.exponent,
              c: changeId,
            },
          ];
        case "enumMap":
          return [
            {
              k: "enum",
              path: prefixed(prefix, op.path),
              // The renames inverted, plus every value the new contract can
              // produce that the old one cannot name. Only this direction has
              // a fold: an old caller cannot send a value its own contract
              // never described, so there is nothing to fold on the way in.
              map: {
                ...backwardPairs(op.codec.pairs),
                ...Object.fromEntries(op.codec.fold ?? []),
              },
              ...(op.codec.fold && op.codec.fold.length > 0
                ? { folded: op.codec.fold.map(([value]) => value) }
                : {}),
              c: changeId,
            },
          ];
        case "cast":
          return [
            {
              k: "cast",
              path: prefixed(prefix, op.path),
              to: op.codec.from,
              c: changeId,
            },
          ];
        case "dropValues":
          // A list an old caller is sent loses the values its contract never
          // named, as Discord's webhook event types, listed as none, came to
          // list twelve. The values an old caller's request loses on the way
          // in are ones the API no longer sends, so they are never there.
          return [
            {
              k: "drop",
              path: prefixed(prefix, op.path),
              values: op.codec.values,
              c: changeId,
            },
          ];
        default:
          return [valueCodec(op.codec, prefixed(prefix, op.path), changeId, "backward")];
      }
    case "add":
      // The old contract never had this field, so it must not appear.
      return [{ k: "del", path: prefixed(prefix, op.path), c: changeId }];
    case "remove":
      // Nothing to put back: old callers were never promised it.
      if (op.restore === undefined) return [];
      return [
        {
          k: "set",
          path: prefixed(prefix, op.path),
          value: op.restore,
          ifAbsent: false,
          c: changeId,
        },
      ];
    case "default":
      return op.toward === "old" ? [fill(op, prefix, changeId)] : [];
    case "dropNull":
      return op.toward === "old" ? [dropNull(op, prefix, changeId)] : [];
    case "relax":
      return [];
    case "restate":
      // Proved when the Change compiled: what an old caller is sent is
      // already what their contract allowed.
      return [];
    case "widen": {
      const guard = variants(op);
      if (!guard) return [];
      // Standing on each value at the union's place, one of the new kind is
      // replaced where it is, in a list item or a field alike.
      return [
        {
          k: "within",
          path: prefixed(prefix, op.path),
          block: [testing(guard, [shown(op, changeId)], changeId)],
          c: changeId,
        },
      ];
    }
  }
  return [];
}

/**
 * A site's instructions, placed so they run only for values of the branch the
 * site is in: `within` each union on the way, and a `switch` on the key or a
 * `has` on the field that tells the branch apart. `build` makes the
 * instructions for a prefix relative to the innermost union.
 *
 * On the way back the key already holds the new contract's value, so any
 * value this Change's own enum map renames is matched by what it became.
 */
export function guarded(
  site: Pick<Site, "prefix" | "guards">,
  change: Change,
  direction: "forward" | "backward",
  build: (prefix: string) => Instr[],
): Instr[] {
  const guards = site.guards ?? [];
  if (guards.length === 0) return build(site.prefix);
  const relative = (from: string, to: string) => {
    const outer = parsePointer(from);
    return formatPointer(parsePointer(to).slice(outer.length));
  };
  const innermost = guards[guards.length - 1] as NonNullable<Site["guards"]>[number];
  let block = build(relative(innermost.at, site.prefix));
  if (block.length === 0) return [];
  for (let index = guards.length - 1; index >= 0; index -= 1) {
    const guard = guards[index] as NonNullable<Site["guards"]>[number];
    const outer = index === 0 ? "" : (guards[index - 1] as typeof guard).at;
    // On the way out, the branch itself has not been put back yet, so a key
    // or field this Change renames is still under its new name.
    const own = direction === "backward" && guard.at === site.prefix;
    const inner = testing(renamed(guard, own ? change : undefined), block, change.id);
    block = [
      { k: "within", path: relative(outer, guard.at), block: [inner], c: change.id },
    ];
  }
  return block;
}

/**
 * The guard as the value still reads when this Change has not yet been undone
 * on it: its key's values and its fields under their new names.
 */
function renamed(guard: Guard, change: Change | undefined): Guard {
  if (!change) return guard;
  const field = (name: string) => movedTo(change, name) ?? name;
  if ("type" in guard) return guard;
  if ("key" in guard) {
    const renames = renamesOf(change, guard.key);
    return {
      ...guard,
      values: [...new Set(guard.values.map((value) => renames.get(value) ?? value))],
      ...(guard.has === undefined ? {} : { has: field(guard.has) }),
      ...(guard.lacks === undefined ? {} : { lacks: field(guard.lacks) }),
    };
  }
  if ("lacks" in guard) return { ...guard, lacks: field(guard.lacks) };
  return { ...guard, has: field(guard.has) };
}

/** What a Change's enum map at `path` renames each old value to. */
function renamesOf(change: Change, path: string): Map<string, string> {
  const renames = new Map<string, string>();
  for (const op of change.ops) {
    if (op.op !== "convert" || op.codec.kind !== "enumMap" || op.path !== path) continue;
    for (const [from, to] of op.codec.pairs) renames.set(from, to);
  }
  return renames;
}

/** Where a Change moves a top-level field to, when it moves it to another top-level name. */
function movedTo(change: Change, field: string): string | undefined {
  for (const op of change.ops) {
    if (op.op !== "move") continue;
    const from = parsePointer(op.from);
    const to = parsePointer(op.to);
    if (from.length === 1 && from[0] === field && to.length === 1) return to[0];
  }
  return undefined;
}
