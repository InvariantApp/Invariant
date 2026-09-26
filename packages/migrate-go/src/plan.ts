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
import type { AddOp, Change, DataOp, DefaultOp } from "@invariant-app/ir";
import type { WireTags } from "@invariant-app/migrate-core";
import {
  diffSurfaces,
  type GoSymbol,
  type SurfaceDiff,
  type SurfaceObject,
  symbolId,
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
  /**
   * How the API's objects name their own schema, as Stripe's `"object":
   * "invoice"`, so a fixture in a string or a map nothing types is read as
   * the schema it says it is.
   */
  tags?: WireTags;
  /**
   * The SDK's exact conversions of an amount between major and minor units,
   * so a field whose unit changed is converted with them rather than with
   * arithmetic written into the consumer's code.
   */
  helpers?: { toMinor: GoSymbol; fromMinor: GoSymbol };
}

/** Roles a reference can have, as the helper reports them. */
export type GoRole =
  | "call"
  | "method-value"
  | "read"
  | "write"
  | "literal-key"
  | "type"
  | "value"
  /** A field named in a string, `FieldByName("Nickname")` on the SDK's struct. */
  | "name";

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

/** A value of one of the SDK's named types that the contract renamed. */
export interface GoValueRename {
  /** The named type, as `CustomerStatus`, whose literals are the field's values. */
  type: GoSymbol;
  /**
   * The fields whose values the Change renamed. An SDK may give a response's
   * field and a request's the same named type, and a Change scoped to one
   * leaves the other's values as they were.
   */
  fields: GoSymbol[];
  from: string;
  to: string;
  changeId: string;
  reason: string;
}

/** A field whose value is now written times 10^exponent. */
export interface GoScale {
  field: GoSymbol;
  exponent: number;
  toMinor: GoSymbol;
  fromMinor: GoSymbol;
  changeId: string;
  reason: string;
}

/**
 * A field that moved into an object its struct now holds: `Customer.Phone`
 * is read as `Customer.Contact.Phone`. Each step is a field of the new
 * release, with its type, so a literal can build the object it moved into.
 */
export interface GoMove {
  from: GoSymbol;
  path: { name: string; type: string }[];
  changeId: string;
  reason: string;
}

/**
 * A field a struct gained that the literals building one must now write:
 * with `value` where a request field became required, or shown where the
 * literal stands in for a response that gained it.
 */
export interface GoSupply {
  /** The struct. */
  type: GoSymbol;
  /** The field's Go name in the new release. */
  field: string;
  json: string;
  /** What to write, or null where there is nothing to write. */
  value: unknown;
  /** The field's type, and the underlying type where it is a named one. */
  fieldType: string;
  underlying?: string;
  changeId: string;
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
  /** Values rewritten wherever a literal is typed as one of the SDK's named types. */
  values?: GoValueRename[];
  /** Fields converted where they are read and written, because their unit changed. */
  scales?: GoScale[];
  /** Fields rewritten through the object they moved into. */
  moves?: GoMove[];
  /** Fields written into, or shown at, the literals that build their struct. */
  supplies?: GoSupply[];
  /**
   * The wire names of fields a Change moved, removed or re-encoded, shown
   * where a key of untyped JSON names one in a file that uses the SDK.
   */
  untyped?: { json: string; changeId: string; reason: string }[];
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
 * The field a struct has by wire name, its own or one an embedded struct
 * promotes. Go promotes the fields of an embedded struct to the struct that
 * embeds it, as go-github's and stripe-go's shared bases are, so `email` on
 * a customer can be declared on the `CustomerBase` it embeds. A name two
 * embedded structs both promote is promoted by neither.
 */
function memberOf(
  surface: readonly SurfaceObject[],
  holder: GoSymbol,
  wire: string,
  depth = 0,
): SurfaceObject | undefined {
  const own = surface.filter(
    (object) =>
      object.kind === "field" &&
      object.package === holder.package &&
      object.key.startsWith(`${holder.key}.`) &&
      !object.key.slice(holder.key.length + 1).includes("."),
  );
  const direct = own.find((object) => !object.embedded && object.json === wire);
  if (direct || depth >= 4) return direct;
  const promoted = own
    .filter((object) => object.embedded)
    .flatMap((object) => {
      const named = /^\*?([A-Z]\w*)$/.exec(object.type)?.[1];
      const found =
        named &&
        memberOf(surface, { package: holder.package, key: named }, wire, depth + 1);
      return found ? [found] : [];
    });
  return promoted.length === 1 ? promoted[0] : undefined;
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
    const field = memberOf(surface, holder, segment);
    if (!field || index === path.length - 1) return field;
    // A field holds `*T`, `[]T`, `[]*T` or `T` of the same package.
    const named = /^(?:\*|\[\])*([A-Z]\w*)$/.exec(field.type)?.[1];
    if (!named) return undefined;
    holder = { package: holder.package, key: named };
  }
  return undefined;
}

const holderOf = (key: string) => key.split(".").slice(0, -1).join(".");
const lastOf = (key: string) => key.split(".").at(-1) as string;

/**
 * An op that means every literal building the struct now has to write the
 * field: a new required one, or an existing one that stopped being optional.
 */
function suppliesField(op: DataOp): op is AddOp | DefaultOp {
  return (
    op.op === "add" || (op.op === "default" && op.toward === "new" && op.when !== "null")
  );
}

/** The SDK's named string type a field holds, whose literals are its values. */
function vocabularyOf(
  surface: readonly SurfaceObject[],
  field: SurfaceObject,
): GoSymbol | undefined {
  const name = field.type.replace(/^\*/, "");
  const named = surface.find(
    (object) =>
      object.kind === "type" &&
      object.package === field.package &&
      object.key === name &&
      object.type === "string",
  );
  return named ? { package: named.package, key: named.key } : undefined;
}

/**
 * The fields of the new release a field that moved into an object is
 * reached through, from the struct that held it: `Contact` then `Phone`.
 * Only where the first step is a field of that same struct, each step
 * before the last holds a struct of the SDK's, and the field keeps its type.
 */
function movedPath(
  after: readonly SurfaceObject[],
  type: GoSymbol,
  field: SurfaceObject,
  to: string,
): GoMove["path"] | undefined {
  const steps = segments(to);
  if (steps.length < 2 || steps.includes("*")) return undefined;
  const encoded = (segment: string) =>
    segment.replaceAll("~", "~0").replaceAll("/", "~1");
  const path: GoMove["path"] = [];
  for (let at = 1; at <= steps.length; at += 1) {
    const step = fieldAt(after, type, `/${steps.slice(0, at).map(encoded).join("/")}`);
    if (!step || step.package !== field.package) return undefined;
    if (at === 1 && holderOf(step.key) !== holderOf(field.key)) return undefined;
    if (at < steps.length && !/^\*?[A-Z]\w*$/.test(step.type)) return undefined;
    path.push({ name: lastOf(step.key), type: step.type });
  }
  return path.at(-1)?.type === field.type ? path : undefined;
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
  const values: GoValueRename[] = [];
  const scales: GoScale[] = [];
  const moves: GoMove[] = [];
  const supplies: GoSupply[] = [];
  const untyped: NonNullable<GoMigrationPlan["untyped"]> = [];
  /** A field whose reads by key are wrong as written, if the key is the field. */
  const byKey = (json: string | undefined, changeId: string, reason: string) => {
    if (json && !untyped.some((each) => each.json === json)) {
      untyped.push({ json, changeId, reason });
    }
  };
  const before = surfaces?.before ?? [];
  const after = surfaces?.after ?? [];
  // The SDK's conversion helpers, where both releases export them.
  const exported = (symbol: GoSymbol) =>
    [before, after].every(
      (surface) =>
        surface.length === 0 ||
        surface.some(
          (object) =>
            object.kind === "func" &&
            object.package === symbol.package &&
            object.key === symbol.key,
        ),
    ) && before.length > 0;
  const helpers =
    symbols.helpers &&
    exported(symbols.helpers.toMinor) &&
    exported(symbols.helpers.fromMinor)
      ? symbols.helpers
      : undefined;

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
        if (suppliesField(op)) {
          // A field of the struct itself, as the new release declares it.
          const added = fieldAt(after, type, op.path);
          if (
            added &&
            added.package === type.package &&
            holderOf(added.key) === type.key
          ) {
            const named = after.find(
              (object) =>
                object.kind === "type" &&
                object.package === added.package &&
                object.key === added.type,
            );
            supplies.push({
              type,
              field: lastOf(added.key),
              json: added.json ?? "",
              value: op.value,
              fieldType: added.type,
              ...(named ? { underlying: named.type } : {}),
              changeId: change.id,
            });
          }
          continue;
        }
        const pointer = op.op === "move" ? op.from : "path" in op ? op.path : undefined;
        if (pointer === undefined) continue;
        const field = fieldAt(before, type, pointer);
        if (!field) continue;
        const symbol = { package: field.package, key: field.key };
        if (op.op === "move" || op.op === "remove") {
          byKey(
            field.json,
            change.id,
            op.op === "remove"
              ? "it is no longer sent"
              : segments(op.to).length === 1
                ? `it is now "${segments(op.to)[0]}"`
                : `it moved to ${op.to}`,
          );
        } else if (op.op === "convert" && op.codec.kind !== "enumMap") {
          byKey(
            field.json,
            change.id,
            `it is encoded differently now (${op.codec.kind})`,
          );
        }
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
          const path = movedPath(after, type, field, op.to);
          if (path) {
            moves.push({
              from: symbol,
              path,
              changeId: change.id,
              reason: `"${field.json}" moved to ${op.to}`,
            });
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
          // A renamed value of a field whose type is one of the SDK's named
          // string types is found by that type, wherever a literal has it.
          const vocabulary =
            op.codec.kind === "enumMap" ? vocabularyOf(before, field) : undefined;
          if (vocabulary && op.codec.kind === "enumMap") {
            for (const [from, to] of op.codec.pairs) {
              if (from === to) continue;
              const same = values.find(
                (value) =>
                  symbolId(value.type) === symbolId(vocabulary) &&
                  value.from === String(from) &&
                  value.to === String(to),
              );
              if (same) {
                if (!same.fields.some((each) => symbolId(each) === symbolId(symbol)))
                  same.fields.push(symbol);
                continue;
              }
              values.push({
                type: vocabulary,
                fields: [symbol],
                from: String(from),
                to: String(to),
                changeId: change.id,
                reason: `"${String(from)}" is now "${String(to)}"`,
              });
            }
            continue;
          }
          if (op.codec.kind === "scale10" && helpers) {
            scales.push({
              field: symbol,
              exponent: op.codec.exponent,
              toMinor: helpers.toMinor,
              fromMinor: helpers.fromMinor,
              changeId: change.id,
              reason: `"${field.json}" on ${type.key} is now written as the value times 10^${op.codec.exponent}`,
            });
            continue;
          }
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
    ...(values.length > 0 ? { values } : {}),
    ...(scales.length > 0 ? { scales } : {}),
    ...(moves.length > 0 ? { moves } : {}),
    ...(supplies.length > 0 ? { supplies } : {}),
    ...(untyped.length > 0 ? { untyped } : {}),
    changes: [...changes],
    ...(surface ? { surface } : {}),
  };
}
