/**
 * What a migration needs to know before it touches any source.
 *
 * The engine never reads a changelog and never guesses what the provider meant.
 * It receives the Changes the provider already confirmed, plus a map from the
 * contract's schemas to the symbols the consumer's SDK actually exports, and
 * everything it does follows from those two.
 */
import type { Change, DataOp } from "@invariant/ir";

/** How a generated SDK names the things a contract describes. */
export interface SymbolMap {
  /** The package the consumer depends on today. */
  package: string;
  /** The package built for the current contract. */
  upgradeTo: { package: string; version: string };
  /** Schema name in the consumer's contract to the type the SDK exports for it. */
  types: Record<string, string>;
  /** Resource accessor paths that moved, for example charges.create to payments.create. */
  accessors: { from: string[]; to: string[] }[];
  /** Exact conversion helpers the SDK exports, so no float math is ever inlined. */
  helpers?: { toMinor: string; fromMinor: string };
}

export type Role =
  /** `{ amount: expr }` at a call site. */
  | "write-literal"
  | "write-expression"
  /** `payment.amount` */
  | "read-access"
  /** `const { amount } = payment` */
  | "destructure"
  /** A type position, such as `Charge` in an annotation. */
  | "type-reference"
  /** Something the engine will not rewrite on its own. */
  | "unknown";

export interface TargetSymbol {
  /** Exported type name in the consumer's SDK. */
  typeName: string;
  /** Property name inside that type. */
  property: string;
  /** The op that applies to it. */
  op: DataOp;
  changeId: string;
  /** The schema the Change scoped to, for provenance. */
  schema: string;
}

export interface MigrationPlan {
  symbols: SymbolMap;
  targets: TargetSymbol[];
  /** Type names that were renamed between contracts. */
  typeRenames: { from: string; to: string; changeId: string }[];
  accessorRenames: { from: string[]; to: string[]; changeId: string }[];
  changes: Change[];
}

const SCHEMA_PREFIX = "#/components/schemas/";

function leafOf(pointer: string): string | undefined {
  const segments = pointer.split("/").filter((segment) => segment !== "");
  const leaf = segments[segments.length - 1];
  // Only a top-level property maps cleanly onto one SDK symbol. A deeper path
  // is handled by the op's own edit, not by a symbol lookup.
  return segments.length === 1 ? leaf : undefined;
}

/**
 * Resolves the Changes into the SDK symbols they touch.
 *
 * A Change names a schema in the provider's contract; the symbol map says what
 * the consumer's SDK calls it. Anything the map does not cover is left out
 * rather than guessed at, and surfaces later as a site needing review.
 */
export function buildPlan(changes: readonly Change[], symbols: SymbolMap): MigrationPlan {
  const targets: TargetSymbol[] = [];
  const accessorRenames: { from: string[]; to: string[]; changeId: string }[] = [];
  /** Where a field ends up, back to what the consumer's SDK still calls it. */
  const origins = new Map<string, string>();

  for (const change of changes) {
    for (const op of change.ops) {
      if (op.op === "route") {
        for (const accessor of symbols.accessors) {
          accessorRenames.push({ ...accessor, changeId: change.id });
        }
        continue;
      }
      if (op.op === "behavior") continue;

      for (const scope of change.scopes ?? []) {
        if (!("schema" in scope)) continue;
        const schemaName = scope.schema.slice(SCHEMA_PREFIX.length);
        const typeName = symbols.types[schemaName];
        if (!typeName) continue;

        // Ops within a Change run in order, so a convert that follows a move
        // names the field by where the move put it. The consumer's SDK still
        // calls it by its original name, which is what has to be looked up.
        const pointer = op.op === "move" ? op.from : op.path;
        const current = leafOf(pointer);
        if (current === undefined) continue;
        const property = origins.get(`${schemaName}.${current}`) ?? current;

        if (op.op === "move") {
          const moved = leafOf(op.to);
          if (moved !== undefined) origins.set(`${schemaName}.${moved}`, property);
        }

        targets.push({ typeName, property, op, changeId: change.id, schema: schemaName });
      }
    }
  }

  // Accessor renames repeat once per route op; one entry each is enough.
  const seen = new Set<string>();
  const uniqueAccessors = accessorRenames.filter((rename) => {
    const key = rename.from.join(".");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    symbols,
    targets,
    typeRenames: [],
    accessorRenames: uniqueAccessors,
    changes: [...changes],
  };
}
