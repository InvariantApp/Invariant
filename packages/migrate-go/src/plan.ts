/**
 * What a Go migration needs to know before it touches any source.
 *
 * As for TypeScript, the engine never reads a changelog and never guesses
 * what the provider meant. It receives the Changes the provider confirmed,
 * a map from the contract's schemas and operations to what the consumer's
 * SDK declares for them, and the two releases' surfaces, and everything it
 * does follows from those.
 *
 * Go's struct tags are what make the map exact: a Change that moves `amount`
 * to `amount_cents` on a schema finds the field whose `json` tag is
 * `amount` on the type the SDK declares for that schema, whatever the SDK
 * called the field in Go, and the field tagged `amount_cents` in the new
 * release is the one it becomes.
 */
import type { Change } from "@invariant-app/ir";
import {
  diffSurfaces,
  type GoSymbol,
  type SurfaceDiff,
  type SurfaceObject,
} from "./surface.ts";

/** How a Go SDK names the things a contract describes. */
export interface GoSymbolMap {
  /** The module the consumer requires today, and at which version. */
  module: { path: string; version: string };
  /** The module built for the current contract. */
  upgradeTo: { path: string; version: string };
  /** Schema name to the type the SDK declares for it. */
  types: Record<string, GoSymbol>;
  /**
   * The SDK methods that call each operation, keyed `method path` as the
   * contract spells it (`delete /repos/{owner}/{repo}`).
   */
  operations?: Record<string, GoSymbol[]>;
}

/** Roles a reference can have, as the helper reports them. */
export type GoRole =
  | "call"
  | "method-value"
  | "read"
  | "write"
  | "literal-key"
  | "type"
  | "value";

export interface GoRename {
  from: GoSymbol;
  /** What the identifier becomes. */
  to: string;
  changeId: string;
  reason: string;
}

export interface GoFlag {
  symbol: GoSymbol;
  /** Only references in these roles; every reference when absent. */
  roles?: GoRole[];
  changeId: string;
  reason: string;
}

/** A function the new release marks `//go:fix inline`, whose calls become what it does. */
export interface GoInline {
  symbol: GoSymbol;
  inline: NonNullable<SurfaceObject["inline"]>;
  reason: string;
}

export interface GoMigrationPlan {
  symbols: GoSymbolMap;
  /** Identifiers rewritten wherever the consumer names the object. */
  renames: GoRename[];
  /** Calls rewritten into what the function they call does. */
  inlines?: GoInline[];
  /** Objects every reference to which is shown to a person. */
  flags: GoFlag[];
  changes: Change[];
  /** What changed in the SDK itself between the two releases. */
  surface?: SurfaceDiff;
}

const SCHEMA_PREFIX = "#/components/schemas/";

function segments(pointer: string): string[] {
  return pointer
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/**
 * The field a pointer names inside a type, by wire name, walking through the
 * named struct types its fields hold: `/automatic_tax/liability` on a
 * checkout session is the `liability` field of whatever type the
 * `automatic_tax` field holds.
 */
export function fieldAt(
  surface: readonly SurfaceObject[],
  type: GoSymbol,
  pointer: string,
): SurfaceObject | undefined {
  let holder = type;
  // A list's items are `*` in a pointer; a Go field holding `[]T` holds Ts.
  const path = segments(pointer).filter((segment) => segment !== "*");
  for (const [index, segment] of path.entries()) {
    const field = surface.find(
      (object) =>
        object.kind === "field" &&
        object.package === holder.package &&
        object.key.startsWith(`${holder.key}.`) &&
        !object.key.slice(holder.key.length + 1).includes(".") &&
        object.json === segment,
    );
    if (!field || index === path.length - 1) return field;
    // A field holds `*T`, `[]T`, `[]*T` or `T` of the same package.
    const named = /^(?:\*|\[\])*([A-Z]\w*)$/.exec(field.type)?.[1];
    if (!named) return undefined;
    holder = { package: holder.package, key: named };
  }
  return undefined;
}

/**
 * Resolves the Changes, and the SDK's own renames between the two releases,
 * into the objects they touch. What the map does not cover is left out
 * rather than guessed at; if it breaks the build, the check after the edits
 * finds it.
 */
export function buildGoPlan(
  changes: readonly Change[],
  symbols: GoSymbolMap,
  surfaces?: { before: readonly SurfaceObject[]; after: readonly SurfaceObject[] },
): GoMigrationPlan {
  const renames: GoRename[] = [];
  const flags: GoFlag[] = [];
  const before = surfaces?.before ?? [];
  const after = surfaces?.after ?? [];

  for (const change of changes) {
    for (const op of change.ops) {
      if (op.op === "retire" || op.op === "route" || op.op === "status") {
        const endpoint = op.op === "route" ? op.from : op.endpoint;
        const key = `${endpoint.method} ${endpoint.path}`;
        for (const method of symbols.operations?.[key] ?? []) {
          const said =
            op.op === "retire"
              ? `which the provider retired${op.guidance ? `; ${op.guidance}` : ""}`
              : op.op === "status"
                ? `which now answers ${op.to} where it answered ${op.from}; code that checks the status has to expect ${op.to}`
                : `which moved to ${op.to.method.toUpperCase()} ${op.to.path}`;
          flags.push({
            symbol: method,
            roles: ["call", "method-value"],
            changeId: change.id,
            reason: `\`${method.key}\` calls ${endpoint.method.toUpperCase()} ${endpoint.path}, ${said}`,
          });
        }
        continue;
      }
      if (op.op === "behavior") continue;
      for (const scope of change.scopes ?? []) {
        if (!("schema" in scope) || !scope.schema.startsWith(SCHEMA_PREFIX)) continue;
        const type = symbols.types[scope.schema.slice(SCHEMA_PREFIX.length)];
        if (!type) continue;
        const pointer = op.op === "move" ? op.from : "path" in op ? op.path : undefined;
        if (pointer === undefined) continue;
        const field = fieldAt(before, type, pointer);
        if (!field) continue;
        const symbol = { package: field.package, key: field.key };
        if (op.op === "move") {
          const target = fieldAt(after, type, op.to);
          const sameHolder =
            target &&
            target.key.split(".").slice(0, -1).join(".") ===
              field.key.split(".").slice(0, -1).join(".");
          if (target && sameHolder && target.type === field.type) {
            const to = target.key.split(".").at(-1) as string;
            if (to !== field.key.split(".").at(-1)) {
              renames.push({
                from: symbol,
                to,
                changeId: change.id,
                reason: `"${field.json}" is now "${target.json}"`,
              });
            }
            continue;
          }
          flags.push({
            symbol,
            changeId: change.id,
            reason: `"${field.json}" moved to ${op.to}, which ${type.key} does not hold the same way`,
          });
          continue;
        }
        if (op.op === "remove") {
          flags.push({
            symbol,
            changeId: change.id,
            reason: `the provider no longer sends or accepts "${field.json}" on ${type.key}`,
          });
          continue;
        }
        if (op.op === "convert") {
          flags.push({
            symbol,
            changeId: change.id,
            reason: `"${field.json}" on ${type.key} is encoded differently now (${op.codec.kind})`,
          });
        }
      }
    }
  }

  const surface = surfaces ? diffSurfaces(surfaces.before, surfaces.after) : undefined;
  for (const rename of surface?.renames ?? []) {
    renames.push({
      from: rename.from,
      to: rename.to,
      changeId: "sdk-upgrade",
      reason: rename.reason,
    });
  }
  // The SDK's own word that a function is only a name for something else:
  // go-github 84 marks `String(v)` as `Ptr(v)`, and 92 marks `Ptr(v)` as
  // `new(v)`. A function the consumer calls today, marked so in the release
  // it moves to, and deprecated by this upgrade rather than an earlier one:
  // an old call to something deprecated long ago still compiles, and most
  // people moving between later releases leave it as it is, so rewriting it
  // on their behalf is an edit nobody asked for.
  const existing = new Set(
    before
      .filter((object) => object.kind === "func" && !object.deprecated)
      .map((object) => `${object.package}\u0000${object.key}`),
  );
  const inlines: GoInline[] = after.flatMap((object) =>
    object.kind === "func" &&
    object.inline &&
    existing.has(`${object.package}\u0000${object.key}`)
      ? [
          {
            symbol: { package: object.package, key: object.key },
            inline: object.inline,
            reason: `${object.key} is marked //go:fix inline in ${symbols.upgradeTo.version}: the call becomes ${object.inline.builtin ? "the builtin new" : object.inline.to}`,
          },
        ]
      : [],
  );
  return {
    symbols,
    renames,
    ...(inlines.length > 0 ? { inlines } : {}),
    flags,
    changes: [...changes],
    ...(surface ? { surface } : {}),
  };
}
