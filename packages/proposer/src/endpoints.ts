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
} from "@invariant/contract";
import { type Change, isJsonObject, type JsonObject } from "@invariant/ir";

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

export type ParameterLocation = "query" | "path" | "header";

export interface ParameterShape {
  name: string;
  location: ParameterLocation;
  required: boolean;
  type: string | undefined;
  enumValues: string[] | undefined;
}

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
  if (typeof name !== "string") return undefined;
  if (location !== "query" && location !== "path" && location !== "header")
    return undefined;

  const schema = isJsonObject(parameter["schema"]) ? parameter["schema"] : {};
  const values = schema["enum"];

  return {
    name,
    location,
    required: parameter["required"] === true,
    type: typeof schema["type"] === "string" ? schema["type"] : undefined,
    enumValues: Array.isArray(values)
      ? values.filter((value): value is string => typeof value === "string")
      : undefined,
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

    for (const location of byLocation) {
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

/**
 * Drafts what the shapes alone settle about a parameter.
 *
 * Only the vocabulary case, deliberately. A narrowed enum on a query parameter
 * is a mapping the two documents state between them, and it is the commonest
 * parameter change in the real corpus by a wide margin. Anything else is a
 * judgement about meaning and belongs with the judge or a person.
 */
export function parameterChanges(deltas: readonly ParameterDelta[]): Change[] {
  const changes: Change[] = [];

  for (const delta of deltas) {
    for (const { before, after } of delta.altered) {
      const from = before.enumValues;
      const to = after.enumValues;
      if (!from || !to) continue;

      const kept = from.filter((value) => to.includes(value));
      const dropped = from.filter((value) => !to.includes(value));
      const gained = to.filter((value) => !from.includes(value));
      if (dropped.length === 0) continue;

      // The same rule the body-field drafting uses: one value moving is a
      // pairing the documents state, more than one is a guess.
      const pairs: [string, string][] = kept.map((value) => [value, value]);
      if (dropped.length === 1 && gained.length === 1) {
        pairs.push([dropped[0] as string, gained[0] as string]);
      }
      if (pairs.length !== from.length) continue;

      const slug = `${delta.operation}_${before.name}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");

      changes.push({
        irVersion: 1,
        id: `chg_param_${slug}`.slice(0, 120),
        summary:
          `The \`${before.name}\` ${delta.location} parameter of ${delta.operation} ` +
          "accepts a different set of values.",
        scopes: [{ operation: delta.operation, location: delta.location }],
        ops: [
          {
            op: "convert",
            path: `/${before.name}`,
            codec: { kind: "enumMap", pairs },
          },
        ],
        provenance: { proposed_by: { judge: "rules", confidence: 1 } },
      });
    }
  }

  return changes;
}
