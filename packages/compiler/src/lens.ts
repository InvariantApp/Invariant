/**
 * The instructions one op compiles to, at a place in a body, and how they are
 * placed inside the unions on the way there.
 *
 * Shared by the projection onto sites, the blocks that follow a value through
 * schemas that contain themselves, and the verifier's lens, so all three run
 * the same instructions for the same op.
 */
import type { Site } from "@invariant/contract";
import {
  type Change,
  type DataOp,
  type DefaultOp,
  type DropNullOp,
  formatPointer,
  type Instr,
  parsePointer,
} from "@invariant/ir";

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
      }
      break;
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
  }
  return [];
}

/** Canonical-back-to-old-shape primitives: each op's inverse. */
export function backwardInstrs(op: DataOp, prefix: string, changeId: string): Instr[] {
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
                ...Object.fromEntries(op.codec.pairs.map(([from, to]) => [to, from])),
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
      }
      break;
    case "add":
      // The old contract never had this field, so it must not appear.
      return [{ k: "del", path: prefixed(prefix, op.path), c: changeId }];
    case "remove":
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
    const present = (field: string) =>
      formatPointer([own ? (movedTo(change, field) ?? field) : field]);
    let inner: Instr;
    if ("type" in guard) {
      inner = { k: "is", path: "", type: guard.type, block, c: change.id };
    } else if ("key" in guard) {
      const renames = own ? renamesOf(change, guard.key) : new Map<string, string>();
      const values = [
        ...new Set(guard.values.map((value) => renames.get(value) ?? value)),
      ];
      const chosen: Instr[] =
        guard.has !== undefined
          ? [{ k: "has", path: present(guard.has), block, c: change.id }]
          : guard.lacks !== undefined
            ? [
                {
                  k: "has",
                  path: present(guard.lacks),
                  absent: true,
                  block,
                  c: change.id,
                },
              ]
            : block;
      inner = {
        k: "switch",
        path: guard.key,
        cases: Object.fromEntries(values.map((value) => [value, chosen])),
        c: change.id,
      };
    } else if ("lacks" in guard) {
      inner = { k: "has", path: present(guard.lacks), absent: true, block, c: change.id };
    } else {
      inner = { k: "has", path: present(guard.has), block, c: change.id };
    }
    block = [
      { k: "within", path: relative(outer, guard.at), block: [inner], c: change.id },
    ];
  }
  return block;
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
