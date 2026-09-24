/**
 * What a migration needs to know before it touches any source.
 *
 * The engine never reads a changelog and never guesses what the provider meant.
 * It receives the Changes the provider already confirmed, plus a map from the
 * contract's schemas to the symbols the consumer's SDK actually exports, and
 * everything it does follows from those two.
 */
import type { Change, DataOp } from "@invariant-app/ir";
import type { WireTags } from "./tagged.ts";

/** How a generated SDK names the things a contract describes. */
export interface SymbolMap {
  /** The package the consumer depends on today. */
  package: string;
  /**
   * The package built for the current contract, and, where they differ from
   * the schemas' own names, what it calls each schema's type. An SDK that
   * keeps its type names across the upgrade, as stripe-node does, lists them
   * unchanged, so none is renamed.
   */
  upgradeTo: { package: string; version: string; types?: Record<string, string> };
  /** Schema name in the consumer's contract to the type the SDK exports for it. */
  types: Record<string, string>;
  /**
   * Where the consumer names the contract it speaks, as stripe-node's
   * `apiVersion`: the options type that declares it, qualified by its
   * namespaces, the property, and the label the upgraded package speaks.
   *
   * In Python the type is a module and the property one of its attributes,
   * as stripe-python's `stripe.api_version`, and the same version can also
   * be passed per client or per request by keyword (`stripe_version=`).
   * `from` is the label the consumer's current release speaks, so a pin
   * that only ever followed the SDK can be told from one chosen on purpose.
   */
  pin?: {
    type: string;
    property: string;
    label: string;
    from?: string;
    keywords?: string[];
  };
  /**
   * The SDK method that calls each operation, keyed `method path` as the
   * contract spells it (`get /v1/invoices/upcoming`), so a retired operation
   * can be found wherever the consumer calls it.
   */
  operations?: Record<string, { type: string; method: string }>;
  /**
   * How the API's objects name their own schema, as Stripe's `"object":
   * "invoice"`, so a fixture nothing types is still read as the schema it
   * says it is (`tagged.ts`).
   */
  tags?: WireTags;
  /** Resource accessor paths that moved, for example charges.create to payments.create. */
  accessors: { from: string[]; to: string[] }[];
  /**
   * Exact conversion helpers, so no float math is ever inlined at a call site.
   *
   * A generated SDK exports them, and `from` is left out. A consumer holding
   * only generated types has no SDK to export anything, so `from` names a
   * module and `emit` asks the migration to write it into the repository. The
   * alternative is inlining `value * 100` at every site, which is a rounding
   * bug waiting for the first price ending in a third of a cent.
   */
  helpers?: {
    toMinor: string;
    fromMinor: string;
    /** Module specifier to import them from. Defaults to `package`. */
    from?: string;
    /** Write the module too, at this path relative to the repository. */
    emit?: { path: string };
  };
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
  /**
   * For a field inside the type rather than on it: the path from the type to
   * the object that holds it, `*` for a list's items, as Stripe's
   * `automatic_tax.liability` is inside a checkout session.
   */
  within?: string[];
}

export interface MigrationPlan {
  symbols: SymbolMap;
  targets: TargetSymbol[];
  /** Type names that were renamed between contracts. */
  typeRenames: { from: string; to: string; changeId: string }[];
  accessorRenames: { from: string[]; to: string[]; changeId: string }[];
  /** Operations the provider retired, each with what callers should use instead when it says. */
  retired: { key: string; changeId: string; guidance?: string }[];
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
  const retired: MigrationPlan["retired"] = [];
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
      // A retired operation has nothing to rewrite into: every call to it is
      // shown to a person, with the provider's guidance where it gave some.
      if (op.op === "retire") {
        retired.push({
          key: `${op.endpoint.method.toLowerCase()} ${op.endpoint.path}`,
          changeId: change.id,
          ...(op.guidance ? { guidance: op.guidance } : {}),
        });
        continue;
      }
      // Nothing in a consumer's source names a status the SDK checks for it.
      if (op.op === "behavior" || op.op === "status") continue;

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
        if (current === undefined) {
          // A field gained or lost inside the type is found by walking to the
          // object that holds it. Anything that moves a value between levels
          // needs more than finding it, and is left to its own edit.
          const segments = pointer.split("/").filter((segment) => segment !== "");
          const leaf = segments.at(-1);
          if (
            (op.op === "add" || op.op === "remove") &&
            leaf !== undefined &&
            leaf !== "*"
          ) {
            targets.push({
              typeName,
              property: leaf,
              op,
              changeId: change.id,
              schema: schemaName,
              within: segments.slice(0, -1),
            });
          }
          continue;
        }
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
    retired,
    changes: [...changes],
  };
}
