/**
 * Changes served by blocks that follow the value, not by listing its places.
 *
 * A Change to a schema is normally placed at every pointer the schema sits at
 * in each body. That list is finite only when no schema on the way to it
 * contains itself. A comment thread whose replies hold comments, or Stripe,
 * where nearly every object reaches nearly every other through expandable
 * fields, have places without end, and listing some of them left the rest
 * untranslated without a word.
 *
 * Such a Change is compiled into one block per schema on the way to it, per
 * direction. A schema's block calls the blocks of the schemas it holds where
 * it holds them, and runs its own Changes; a body starts at the blocks of the
 * schemas at its root. The runtime then goes exactly as deep as the value
 * does, and the program is as large as the schemas, not as the paths.
 *
 * Order within a block keeps each direction the inverse of the other. On the
 * way in, a value is still in the old shape, so the schemas it holds are
 * translated first, where the old contract places them, and then its own
 * fields. On the way out, its own fields are put back first, which returns it
 * to the old shape, and then the schemas inside it are found where the old
 * contract places them.
 */
import {
  type Guard,
  leadingToAny,
  needsSharedBlocks,
  type OpenApiDocument,
  refsWithin,
  resolveRef,
} from "@invariant/contract";
import {
  type Change,
  type Instr,
  isDataOp,
  isSchemaScope,
  type JsonValue,
} from "@invariant/ir";
import { backwardInstrs, forwardInstrs, guarded } from "./lens.ts";
import type { ProjectionIssue } from "./project.ts";

export type Direction = "forward" | "backward";

export interface SharedBlocks {
  /** Schemas whose Changes are served by blocks, as references. */
  targets: ReadonlySet<string>;
  blocks: Record<string, Instr[]>;
  /** Instructions that start a body whose schema is `root` through the blocks. */
  entry(root: JsonValue, direction: Direction): Instr[];
  issues: ProjectionIssue[];
}

const NONE: SharedBlocks = {
  targets: new Set(),
  blocks: {},
  entry: () => [],
  issues: [],
};

/** The name a block is called by, unique across the steps of a chain. */
function blockName(label: string, ref: string, direction: Direction): string {
  const schema = ref.startsWith("#/components/schemas/")
    ? ref.slice("#/components/schemas/".length)
    : ref;
  return `${label}:${schema}:${direction === "forward" ? "in" : "out"}`.slice(0, 256);
}

/** Every schema a data Change is scoped to, as references, in declared order. */
function scopedSchemas(change: Change): string[] {
  if (!change.ops.some(isDataOp)) return [];
  return (change.scopes ?? []).flatMap((scope) =>
    isSchemaScope(scope) ? [scope.schema] : [],
  );
}

/**
 * The schemas among `changes` whose places cannot be listed, and so are
 * served by blocks. Decided per schema: every other Change is placed as
 * before, and its program is unchanged.
 */
export function sharedTargets(
  oldContract: OpenApiDocument,
  changes: readonly Change[],
): Set<string> {
  const decided = new Map<string, boolean>();
  const targets = new Set<string>();
  for (const change of changes) {
    for (const ref of scopedSchemas(change)) {
      let shared = decided.get(ref);
      if (shared === undefined) {
        shared = needsSharedBlocks(oldContract, ref);
        decided.set(ref, shared);
      }
      if (shared) targets.add(ref);
    }
  }
  return targets;
}

export function sharedBlocks(
  label: string,
  oldContract: OpenApiDocument,
  changes: readonly Change[],
): SharedBlocks {
  const targets = sharedTargets(oldContract, changes);
  if (targets.size === 0) return NONE;

  // The Changes each shared schema carries, in declared order.
  const own = new Map<string, Change[]>();
  for (const change of changes) {
    for (const ref of scopedSchemas(change)) {
      if (!targets.has(ref)) continue;
      own.set(ref, [...(own.get(ref) ?? []), change]);
    }
  }
  const nodes = leadingToAny(oldContract, targets);

  // Which shared Changes each schema leads to, for naming a refusal after the
  // Changes it stops, and for the id a placing instruction is counted under.
  const reaching = new Map<string, Change[]>();
  for (const [target, list] of own) {
    for (const ref of leadingToAny(oldContract, [target])) {
      reaching.set(ref, [...(reaching.get(ref) ?? []), ...list]);
    }
  }
  const issues: ProjectionIssue[] = [];
  const refuse = (at: string, notes: readonly string[]) => {
    for (const note of notes) {
      for (const change of reaching.get(at) ?? [...own.values()].flat()) {
        issues.push({ changeId: change.id, message: note });
      }
    }
  };

  /**
   * A stand-in for the Changes a schema carries, for placing a call to its
   * block inside a union: on the way out, a key the schema's own enum map
   * renames still holds the new value when the union is entered.
   */
  const carried = (ref: string): Change => {
    const list = own.get(ref) ?? [];
    const first = list[0] ?? reaching.get(ref)?.[0];
    return {
      irVersion: 1,
      id: first?.id ?? "chg_shared",
      summary: "shared",
      ops: list.flatMap((change) => change.ops),
    };
  };

  /** Calls to the blocks of the schemas `root` holds, where it holds them. */
  const descend = (root: JsonValue, direction: Direction, at: string): Instr[] => {
    const scan = refsWithin(oldContract, root, nodes);
    refuse(at, scan.unsupported);
    return scan.placements.flatMap((place) =>
      guarded(
        { prefix: place.prefix, guards: place.guards as Guard[] },
        carried(place.ref),
        direction,
        (prefix) => {
          const call: Instr = {
            k: "call",
            block: blockName(label, place.ref, direction),
            c: carried(place.ref).id,
          };
          return prefix === ""
            ? [call]
            : [{ k: "within", path: prefix, block: [call], c: call.c }];
        },
      ),
    );
  };

  const blocks: Record<string, Instr[]> = {};
  for (const ref of nodes) {
    const body = resolveRef(oldContract, ref);
    if (body === undefined) continue;
    const mine = own.get(ref) ?? [];
    const forward = mine.flatMap((change) =>
      change.ops.filter(isDataOp).flatMap((op) => forwardInstrs(op, "", change.id)),
    );
    const backward = [...mine]
      .reverse()
      .flatMap((change) =>
        [...change.ops.filter(isDataOp)]
          .reverse()
          .flatMap((op) => backwardInstrs(op, "", change.id)),
      );
    blocks[blockName(label, ref, "forward")] = [
      ...descend(body, "forward", ref),
      ...forward,
    ];
    blocks[blockName(label, ref, "backward")] = [
      ...backward,
      ...descend(body, "backward", ref),
    ];
  }

  return {
    targets,
    blocks,
    entry: (root, direction) => descend(root, direction, ""),
    issues: dedupe(issues),
  };
}

function dedupe(issues: readonly ProjectionIssue[]): ProjectionIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.changeId}\n${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
