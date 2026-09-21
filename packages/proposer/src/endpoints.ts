/**
 * Endpoints and parameters, which the proposer could not see until now.
 *
 * Both gaps were found the same way: by running sixty real API version pairs
 * through the gate and reading what came back unexplained.
 *
 * Whole endpoints disappearing was the commonest breaking change in the wild
 * by a wide margin. Some of those were prefix moves, which `prefix.ts` now
 * recognises. The rest are genuine retirements, and there was no way to say
 * one, because `remove` speaks about a field inside a body and nothing spoke
 * about the operation itself.
 *
 * Parameters were the other gap, and a more embarrassing one. The proposer
 * read `components.schemas` and nothing else, so 483 real deltas about query
 * and path parameters were invisible to it, against a `ParameterScope` the IR
 * had all along. A narrowed enum on a query parameter is exactly the kind of
 * change `enumMap` exists for.
 */
import {
  type HttpMethod,
  type OpenApiDocument,
  operationsOf,
  resolveRef,
  resolveSchema,
} from "@invariant/contract";
import {
  type Change,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "@invariant/ir";

export interface RetiredEndpoint {
  method: HttpMethod;
  path: string;
  operationId: string;
}

/**
 * Endpoints in the old document with no counterpart in the new one.
 *
 * `moved` carries whatever a prefix move already accounted for, so the same
 * endpoint is never reported as both relocated and retired. Without that, a
 * version bump would produce a route change and a retirement for every
 * endpoint it touched, which is worse than saying nothing.
 */
export function retiredEndpoints(
  before: OpenApiDocument,
  after: OpenApiDocument,
  moved: ReadonlySet<string> = new Set(),
): RetiredEndpoint[] {
  const present = new Set(
    operationsOf(after).map((operation) => `${operation.method} ${operation.path}`),
  );

  return operationsOf(before)
    .filter((operation) => {
      const key = `${operation.method} ${operation.path}`;
      return !present.has(key) && !moved.has(key);
    })
    .map((operation) => ({
      method: operation.method,
      path: operation.path,
      operationId: operation.operationId,
    }));
}

/**
 * Operations that stayed where they were and changed their declared
 * `operationId`.
 *
 * Nothing on the wire moves, so the runtime does nothing with these. What
 * moves is every generated client's method name, and a `route` carrying the
 * rename is what lets a consumer's migration rename their calls. An id that
 * was removed rather than renamed has nothing to rename to, and is left alone.
 */
export function operationIdChanges(
  before: OpenApiDocument,
  after: OpenApiDocument,
): Change[] {
  const declared = (operation: { operation: JsonObject }) =>
    typeof operation.operation["operationId"] === "string"
      ? (operation.operation["operationId"] as string)
      : undefined;
  const next = new Map(
    operationsOf(after).map((operation) => [
      `${operation.method} ${operation.path}`,
      declared(operation),
    ]),
  );
  return operationsOf(before).flatMap((operation) => {
    const from = declared(operation);
    const to = next.get(`${operation.method} ${operation.path}`);
    if (operation.webhook || from === undefined || to === undefined || from === to)
      return [];
    const endpoint = { method: operation.method, path: operation.path };
    return [
      {
        irVersion: 1 as const,
        id: `chg_operation_${`${from}_to_${to}`
          .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "")
          .slice(0, 110)}`,
        summary: `The operation ${from} is now called ${to}.`,
        ops: [
          {
            op: "route" as const,
            from: endpoint,
            to: endpoint,
            operationId: { from, to },
          },
        ],
        provenance: { proposed_by: { judge: "rules" as const, confidence: 1 } },
      },
    ];
  });
}

/** One Change per retired endpoint, because each is a separate decision. */
export function retireChange(endpoint: RetiredEndpoint): Change {
  const slug = `${endpoint.method}_${endpoint.path}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return {
    irVersion: 1,
    id: `chg_retired_${slug}`.slice(0, 120),
    summary: `${endpoint.method.toUpperCase()} ${endpoint.path} is gone.`,
    ops: [
      {
        op: "retire",
        endpoint: { method: endpoint.method, path: endpoint.path },
      },
    ],
    provenance: { proposed_by: { judge: "rules", confidence: 1 } },
  };
}

export type ParameterLocation = "query" | "path" | "header" | "cookie";

export interface ParameterShape {
  name: string;
  location: ParameterLocation;
  required: boolean;
  type: string | undefined;
  format: string | undefined;
  enumValues: string[] | undefined;
  nullable: boolean;
  /** The declared `default`, when there is one. */
  default?: JsonValue;
}

const LOCATIONS = new Set(["query", "path", "header", "cookie"]);

function parameterShape(
  document: OpenApiDocument,
  raw: unknown,
): ParameterShape | undefined {
  const parameter =
    isJsonObject(raw) && typeof raw["$ref"] === "string"
      ? resolveRef(document, raw["$ref"])
      : raw;
  if (!isJsonObject(parameter)) return undefined;

  const name = parameter["name"];
  const location = parameter["in"];
  if (typeof name !== "string" || typeof location !== "string") return undefined;
  if (!LOCATIONS.has(location)) return undefined;

  const resolved = resolveSchema(document, parameter["schema"] ?? {});
  const schema = isJsonObject(resolved) ? resolved : {};
  const values = schema["enum"];
  const declared = schema["type"];
  const types = (Array.isArray(declared) ? declared : [declared]).filter(
    (type): type is string => typeof type === "string",
  );

  return {
    // Header names are case-insensitive, so they are compared lowercased.
    name: location === "header" ? name.toLowerCase() : name,
    location: location as ParameterLocation,
    required: parameter["required"] === true,
    type: types.find((type) => type !== "null"),
    format: typeof schema["format"] === "string" ? schema["format"] : undefined,
    enumValues: Array.isArray(values)
      ? values.filter((value): value is string => typeof value === "string")
      : undefined,
    nullable: types.includes("null") || schema["nullable"] === true,
    ...(schema["default"] === undefined ? {} : { default: schema["default"] }),
  };
}

function parametersOf(
  document: OpenApiDocument,
  operation: JsonObject,
  pathItem: JsonObject,
): ParameterShape[] {
  // Path-level parameters apply to every operation under that path, and an
  // operation-level one of the same name and location replaces it.
  const raw = [
    ...(Array.isArray(pathItem["parameters"]) ? pathItem["parameters"] : []),
    ...(Array.isArray(operation["parameters"]) ? operation["parameters"] : []),
  ];

  const byKey = new Map<string, ParameterShape>();
  for (const entry of raw) {
    const shape = parameterShape(document, entry);
    if (shape) byKey.set(`${shape.location} ${shape.name}`, shape);
  }
  return [...byKey.values()];
}

export interface ParameterDelta {
  operation: string;
  method: HttpMethod;
  path: string;
  location: ParameterLocation;
  removed: ParameterShape[];
  added: ParameterShape[];
  /** Parameters that kept their name and changed shape. */
  altered: { before: ParameterShape; after: ParameterShape }[];
}

/**
 * What changed about the parameters of operations present in both documents.
 *
 * Operations that moved or disappeared are somebody else's problem: a route
 * change or a retirement already speaks about those, and comparing parameters
 * across an endpoint that no longer exists would double-count it.
 */
export function parameterDeltas(
  before: OpenApiDocument,
  after: OpenApiDocument,
): ParameterDelta[] {
  const newOps = new Map(
    operationsOf(after).map((operation) => [
      `${operation.method} ${operation.path}`,
      operation,
    ]),
  );
  const newPaths = isJsonObject(after["paths"]) ? after["paths"] : {};
  const oldPaths = isJsonObject(before["paths"]) ? before["paths"] : {};

  const out: ParameterDelta[] = [];
  for (const operation of operationsOf(before)) {
    const counterpart = newOps.get(`${operation.method} ${operation.path}`);
    if (!counterpart) continue;

    const oldItem = oldPaths[operation.path];
    const newItem = newPaths[operation.path];
    const oldParams = parametersOf(
      before,
      operation.operation,
      isJsonObject(oldItem) ? oldItem : {},
    );
    const newParams = parametersOf(
      after,
      counterpart.operation,
      isJsonObject(newItem) ? newItem : {},
    );

    const byLocation = new Set([
      ...oldParams.map((parameter) => parameter.location),
      ...newParams.map((parameter) => parameter.location),
    ]);

    for (const location of [...byLocation].sort()) {
      const mine = oldParams.filter((parameter) => parameter.location === location);
      const theirs = newParams.filter((parameter) => parameter.location === location);
      const theirNames = new Map(theirs.map((parameter) => [parameter.name, parameter]));

      const removed = mine.filter((parameter) => !theirNames.has(parameter.name));
      const added = theirs.filter(
        (parameter) => !mine.some((entry) => entry.name === parameter.name),
      );
      const altered: ParameterDelta["altered"] = [];
      for (const parameter of mine) {
        const match = theirNames.get(parameter.name);
        if (!match) continue;
        if (JSON.stringify(parameter) !== JSON.stringify(match)) {
          altered.push({ before: parameter, after: match });
        }
      }

      if (removed.length === 0 && added.length === 0 && altered.length === 0) continue;
      out.push({
        operation: operation.operationId,
        method: operation.method,
        path: operation.path,
        location,
        removed,
        added,
        altered,
      });
    }
  }

  return out;
}

/** A parameter Change drafted from the two documents, with what a reviewer should know. */
export interface ParameterDraft {
  change: Change;
  attention: "normal" | "explicit";
  notes: string[];
}

/** A parameter change the documents do not settle, reported rather than guessed. */
export interface ParameterQuestion {
  schema: string;
  field: string;
  reason: string;
  side: "removed" | "added";
}

const SCALAR_TYPES = new Set(["string", "integer", "number", "boolean"]);

const sameShape = (a: ParameterShape, b: ParameterShape): boolean =>
  a.type === b.type &&
  a.format === b.format &&
  a.enumValues?.join("|") === b.enumValues?.join("|");

function slugOf(...parts: string[]): string {
  return parts
    .join("_")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Drafts what the two documents settle between them about parameters.
 *
 * Nothing here invents a value. A parameter that went is dropped from old
 * callers' requests; one that moved to another location under the same name,
 * or is the only one that went and the only one that arrived with the same
 * shape, is moved; a value appears only where the specification declares a
 * default; a type changes by a cast; a null that is no longer allowed is sent
 * as the parameter left out. Anything else is a question for a person, and
 * is returned as one.
 */
export function parameterDrafts(deltas: readonly ParameterDelta[]): {
  drafts: ParameterDraft[];
  questions: ParameterQuestion[];
} {
  const drafts: ParameterDraft[] = [];
  const questions: ParameterQuestion[] = [];
  const draft = (
    delta: ParameterDelta,
    name: string,
    summary: string,
    ops: Change["ops"],
    notes: string[],
    attention: "normal" | "explicit" = "normal",
  ) =>
    drafts.push({
      change: {
        irVersion: 1,
        id: `chg_param_${slugOf(delta.operation, name)}`.slice(0, 120),
        summary,
        scopes: [{ operation: delta.operation, location: delta.location }],
        ops,
        provenance: { proposed_by: { judge: "rules", confidence: 1 } },
      },
      attention,
      notes,
    });
  const ask = (
    delta: ParameterDelta,
    name: string,
    reason: string,
    side: "removed" | "added",
  ) =>
    questions.push({
      schema: `${delta.operation} ${delta.location} parameters`,
      field: name,
      reason,
      side,
    });

  // A parameter that left one location and arrived in another under the same
  // name moved, which is the one cross-location pairing the names settle.
  const consumed = new Set<ParameterShape>();
  for (const from of deltas) {
    for (const to of deltas) {
      if (from.operation !== to.operation || from.location === to.location) continue;
      if (from.location === "path" || to.location === "path") continue;
      for (const gone of from.removed) {
        const arrived = to.added.find(
          (candidate) =>
            !consumed.has(candidate) &&
            candidate.name.toLowerCase() === gone.name.toLowerCase() &&
            sameShape(gone, candidate),
        );
        if (!arrived || consumed.has(gone)) continue;
        consumed.add(gone);
        consumed.add(arrived);
        draft(
          from,
          gone.name,
          `The \`${gone.name}\` parameter of ${from.operation} moved from the ${from.location} to the ${to.location}.`,
          [{ op: "move", from: `/${gone.name}`, to: `/@${to.location}/${arrived.name}` }],
          [
            `it left the ${from.location} and arrived in the ${to.location} under the same name and shape`,
          ],
        );
      }
    }
  }

  for (const delta of deltas) {
    // A path's parameters are its template, and a different template is a
    // different path: a route change speaks for one that came or went. Only
    // a change to a value, which converts in place, is drafted here.
    const inPath = delta.location === "path";
    const removed = inPath
      ? []
      : delta.removed.filter((parameter) => !consumed.has(parameter));
    const added = inPath
      ? []
      : delta.added.filter((parameter) => !consumed.has(parameter));

    const only = removed.length === 1 && added.length === 1 ? [removed[0], added[0]] : [];
    const [gone, arrived] = only as [ParameterShape?, ParameterShape?];
    if (gone && arrived && sameShape(gone, arrived)) {
      draft(
        delta,
        gone.name,
        `The \`${gone.name}\` ${delta.location} parameter of ${delta.operation} is called \`${arrived.name}\`.`,
        [{ op: "move", from: `/${gone.name}`, to: `/${arrived.name}` }],
        [
          `the only ${delta.location} parameter that went and the only one that arrived have the same shape; ` +
            "confirm it is the same parameter renamed and not one dropped and another added",
        ],
        "explicit",
      );
      continue;
    }

    for (const parameter of removed) {
      draft(
        delta,
        parameter.name,
        `The \`${parameter.name}\` ${delta.location} parameter of ${delta.operation} was removed.`,
        [{ op: "remove", path: `/${parameter.name}`, restore: null }],
        ["the provider no longer reads it, so old callers' requests drop it"],
      );
    }
    for (const parameter of added.filter((entry) => entry.required)) {
      if (parameter.default === undefined) {
        ask(
          delta,
          parameter.name,
          "newly required, and the value a caller who predates it should send is not in the specification",
          "added",
        );
        continue;
      }
      draft(
        delta,
        parameter.name,
        `The \`${parameter.name}\` ${delta.location} parameter of ${delta.operation} is new and required.`,
        [{ op: "add", path: `/${parameter.name}`, value: parameter.default }],
        ["the specification gives it a default, which old callers' requests are given"],
      );
    }

    for (const { before, after } of delta.altered) {
      const ops: Change["ops"] = [];
      const notes: string[] = [];
      const path = `/${before.name}`;

      const from = before.enumValues;
      const to = after.enumValues;
      if (from && to) {
        const kept = from.filter((value) => to.includes(value));
        const dropped = from.filter((value) => !to.includes(value));
        const gained = to.filter((value) => !from.includes(value));
        if (dropped.length > 0) {
          // The same rule the body-field drafting uses: one value moving is a
          // pairing the documents state, more than one is a guess.
          const pairs: [string, string][] = kept.map((value) => [value, value]);
          if (dropped.length === 1 && gained.length === 1) {
            pairs.push([dropped[0] as string, gained[0] as string]);
          }
          if (pairs.length !== from.length) {
            ask(
              delta,
              before.name,
              `the allowed values changed (${dropped.join(", ")} went), and which old value maps to which new one is a decision`,
              "removed",
            );
            continue;
          }
          ops.push({ op: "convert", path, codec: { kind: "enumMap", pairs } });
          notes.push("the two documents state this mapping between them");
        }
      }

      if (
        before.type !== after.type &&
        before.type !== undefined &&
        after.type !== undefined
      ) {
        if (!SCALAR_TYPES.has(before.type) || !SCALAR_TYPES.has(after.type)) {
          ask(
            delta,
            before.name,
            `its type changed from ${before.type} to ${after.type}, which no cast expresses`,
            "removed",
          );
          continue;
        }
        ops.push({
          op: "convert",
          path,
          codec: {
            kind: "cast",
            from: before.type as "string" | "integer" | "number" | "boolean",
            to: after.type as "string" | "integer" | "number" | "boolean",
          },
        });
        notes.push(
          `the type changed from ${before.type} to ${after.type}; check every value old callers send survives the conversion`,
        );
      }

      // A path parameter is always there, so only its value can change.
      const nowRequired = !inPath && !before.required && after.required;
      const nullGone = !inPath && before.nullable && !after.nullable;
      if (nowRequired || (nullGone && after.required)) {
        if (after.default === undefined) {
          ask(
            delta,
            before.name,
            "old callers could leave it out, it is now required, and the value they should send is not in the specification",
            "added",
          );
          continue;
        }
        ops.push({
          op: "default",
          path,
          value: after.default,
          when:
            nowRequired && nullGone ? "absent-or-null" : nowRequired ? "absent" : "null",
          toward: "new",
        });
        notes.push(
          `old callers who leave it out are given the specification's default ${JSON.stringify(after.default)}`,
        );
      } else if (nullGone) {
        ops.push({ op: "dropNull", path, toward: "new" });
        notes.push(
          "it can no longer be null, so a null from an old caller is sent as the parameter left out",
        );
      }

      if (ops.length === 0) continue;
      draft(
        delta,
        before.name,
        `The \`${before.name}\` ${delta.location} parameter of ${delta.operation} changed.`,
        ops,
        notes,
      );
    }
  }

  return { drafts, questions };
}
