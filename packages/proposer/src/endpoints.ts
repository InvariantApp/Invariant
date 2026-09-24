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
  covers,
  type HttpMethod,
  type OpenApiDocument,
  operationsOf,
  requestBodySchema,
  resolveRef,
  resolveSchema,
} from "@invariant-app/contract";
import {
  type Change,
  CONSTRAINT_KEYWORDS,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "@invariant-app/ir";
import { listCodec, timeCodec } from "./codecs.ts";
import type { Decision, ValueDecision } from "./decisions.ts";
import { retiredValueDecision } from "./vocabulary.ts";

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
 * An operation that stayed at its path and changed its method, and the query
 * parameters that became fields of its new request body under the same name.
 *
 * The case this exists for is a search that outgrew its query string: `GET
 * /search?q=` became `POST /search` with `{"q": ...}`. It is claimed only when
 * the path is served under exactly one new method that the old document did
 * not have there, so two unrelated operations sharing a path are never paired.
 */
export interface MethodMove {
  operationId: string;
  from: { method: HttpMethod; path: string };
  to: { method: HttpMethod; path: string; operationId: string };
  /** Query parameters now written as top-level body fields of the same name. */
  intoBody: string[];
}

export function methodMoves(
  before: OpenApiDocument,
  after: OpenApiDocument,
  moved: ReadonlySet<string> = new Set(),
): MethodMove[] {
  const oldOps = operationsOf(before);
  const newOps = operationsOf(after);
  const oldKeys = new Set(
    oldOps.map((operation) => `${operation.method} ${operation.path}`),
  );
  const newKeys = new Set(
    newOps.map((operation) => `${operation.method} ${operation.path}`),
  );
  const out: MethodMove[] = [];
  for (const operation of oldOps) {
    const key = `${operation.method} ${operation.path}`;
    if (operation.webhook || newKeys.has(key) || moved.has(key)) continue;
    const arrivals = newOps.filter(
      (candidate) =>
        candidate.path === operation.path &&
        !candidate.webhook &&
        !oldKeys.has(`${candidate.method} ${candidate.path}`),
    );
    if (arrivals.length !== 1) continue;
    const arrival = arrivals[0] as (typeof arrivals)[number];
    const body = resolveSchema(after, requestBodySchema(after, arrival.operation) ?? {});
    const fields =
      isJsonObject(body) && isJsonObject(body["properties"])
        ? new Set(Object.keys(body["properties"]))
        : new Set<string>();
    const oldItem = isJsonObject(before["paths"])
      ? before["paths"][operation.path]
      : undefined;
    const newItem = isJsonObject(after["paths"])
      ? after["paths"][arrival.path]
      : undefined;
    const stillQuery = new Set(
      parametersOf(after, arrival.operation, isJsonObject(newItem) ? newItem : {})
        .filter((parameter) => parameter.location === "query")
        .map((parameter) => parameter.name),
    );
    const intoBody = parametersOf(
      before,
      operation.operation,
      isJsonObject(oldItem) ? oldItem : {},
    )
      .filter(
        (parameter) =>
          parameter.location === "query" &&
          !stillQuery.has(parameter.name) &&
          fields.has(parameter.name),
      )
      .map((parameter) => parameter.name);
    out.push({
      operationId: operation.operationId,
      from: { method: operation.method, path: operation.path },
      to: {
        method: arrival.method,
        path: arrival.path,
        operationId: arrival.operationId,
      },
      intoBody,
    });
  }
  return out;
}

/** The Changes a method move is: the route, and each query parameter's move into the body. */
export function methodMoveChanges(move: MethodMove): Change[] {
  const slug = `${move.operationId}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const route: Change = {
    irVersion: 1,
    id: `chg_method_${slug}`.slice(0, 120),
    summary:
      `${move.from.method.toUpperCase()} ${move.from.path} is now ` +
      `${move.to.method.toUpperCase()} ${move.to.path}.`,
    ops: [
      {
        op: "route",
        from: move.from,
        to: { method: move.to.method, path: move.to.path },
        ...(move.to.operationId !== move.operationId
          ? { operationId: { from: move.operationId, to: move.to.operationId } }
          : {}),
      },
    ],
    provenance: { proposed_by: { judge: "rules", confidence: 1 } },
  };
  if (move.intoBody.length === 0) return [route];
  return [
    route,
    {
      irVersion: 1,
      id: `chg_method_${slug}_body`.slice(0, 120),
      summary: `${move.intoBody.map((name) => `\`${name}\``).join(", ")} moved from the query string into the body.`,
      scopes: [{ operation: move.operationId, location: "query" }],
      ops: move.intoBody.map((name) => ({
        op: "move" as const,
        from: `/${name}`,
        to: `/@body/${name}`,
      })),
      provenance: { proposed_by: { judge: "rules", confidence: 1 } },
    },
  ];
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

/** The exact success statuses an operation declares, each with whether it promises a body. */
function successStatuses(
  document: OpenApiDocument,
  operation: JsonObject,
): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const responses = operation["responses"];
  if (!isJsonObject(responses)) return out;
  for (const [status, declared] of Object.entries(responses)) {
    if (!/^2\d\d$/.test(status)) continue;
    const response =
      isJsonObject(declared) && typeof declared["$ref"] === "string"
        ? resolveRef(document, declared["$ref"])
        : declared;
    const content = isJsonObject(response) ? response["content"] : undefined;
    out.set(status, isJsonObject(content) && Object.keys(content).length > 0);
  }
  return out;
}

/**
 * Operations that kept their place and stopped answering one success status,
 * where the two documents settle which status took its place: the one the
 * new document added, or, where it added none, the one success status it has
 * left. Gitea 1.25 answers the creation of an Actions variable only `201`,
 * where 1.24 listed `201` and `204` and answered `204`.
 *
 * Not drafted where the old status promised a body the new one does not
 * carry, since nothing can stand in for it; the gate then asks for a
 * `behavior` Change, as it always did.
 */
export function statusChanges(before: OpenApiDocument, after: OpenApiDocument): Change[] {
  const next = new Map(
    operationsOf(after)
      .filter((operation) => !operation.webhook)
      .map((operation) => [`${operation.method} ${operation.path}`, operation.operation]),
  );
  return operationsOf(before).flatMap((operation) => {
    const now = next.get(`${operation.method} ${operation.path}`);
    if (operation.webhook || now === undefined) return [];
    const old = successStatuses(before, operation.operation);
    const current = successStatuses(after, now);
    const gone = [...old.keys()].filter((status) => !current.has(status));
    const added = [...current.keys()].filter((status) => !old.has(status));
    const replacement =
      added.length === 1
        ? added[0]
        : added.length === 0 && current.size === 1
          ? [...current.keys()][0]
          : undefined;
    const from = gone[0];
    if (gone.length !== 1 || from === undefined || replacement === undefined) return [];
    if (old.get(from) === true && current.get(replacement) !== true) return [];
    const endpoint = { method: operation.method, path: operation.path };
    const slug = `${operation.method}_${operation.path}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return [
      {
        irVersion: 1 as const,
        id: `chg_status_${slug}`.slice(0, 120),
        summary: `${operation.method.toUpperCase()} ${operation.path} answers ${replacement} where it answered ${from}.`,
        ops: [{ op: "status" as const, endpoint, from, to: replacement }],
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
  description?: string;
  /** For a list: the type of each item, and the values it lists, if it does. */
  items?: { type: string | undefined; enumValues?: string[] };
  /** The bounds the schema puts on the value, by keyword, apart from its format. */
  bounds?: Record<string, JsonValue>;
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
    ...(typeof parameter["description"] === "string"
      ? { description: parameter["description"] }
      : {}),
    ...(isJsonObject(schema["items"])
      ? {
          items: {
            type: typeOfItems(document, schema["items"]),
            ...listedValues(document, schema["items"]),
          },
        }
      : {}),
    ...boundsOf(schema),
  };
}

function boundsOf(schema: JsonObject): Pick<ParameterShape, "bounds"> {
  const bounds: Record<string, JsonValue> = {};
  for (const keyword of CONSTRAINT_KEYWORDS) {
    const bound = schema[keyword];
    if (keyword !== "format" && bound !== undefined) bounds[keyword] = bound;
  }
  return Object.keys(bounds).length > 0 ? { bounds } : {};
}

/** A parameter's value as a schema, as much of it as its shape records. */
function statedAs(shape: ParameterShape): JsonObject {
  return {
    ...(shape.type === undefined
      ? {}
      : { type: shape.nullable ? [shape.type, "null"] : shape.type }),
    ...(shape.format === undefined ? {} : { format: shape.format }),
    ...(shape.enumValues === undefined ? {} : { enum: shape.enumValues }),
    ...(shape.bounds ?? {}),
  };
}

/**
 * Whether a parameter whose format changed still accepts every value old
 * callers could send, and nothing else about it moved. Twilio stated `int64`
 * on a `PageSize` it had always bounded to 1 and 1000: the differ reads any
 * format that appears as a new type, and no value an old caller sends is
 * refused. The compiler proves it again, on the declarations themselves,
 * before it believes it.
 */
function restatedFormat(before: ParameterShape, after: ParameterShape): boolean {
  if (
    before.format === after.format ||
    before.type === undefined ||
    before.type !== after.type ||
    before.nullable !== after.nullable ||
    before.enumValues?.join("|") !== after.enumValues?.join("|") ||
    JSON.stringify(before.items) !== JSON.stringify(after.items)
  ) {
    return false;
  }
  return covers(
    { document: UNREFERENCED, schema: statedAs(after) },
    { document: UNREFERENCED, schema: statedAs(before) },
  ).covered;
}

/** The document a shape's schema is read in: it names no other schema, so none. */
const UNREFERENCED = { openapi: "3.1.0", paths: {} } as unknown as OpenApiDocument;

function listedValues(
  document: OpenApiDocument,
  raw: JsonValue,
): { enumValues?: string[] } {
  const items = resolveSchema(document, raw);
  const values = isJsonObject(items) ? items["enum"] : undefined;
  return Array.isArray(values)
    ? { enumValues: values.filter((value): value is string => typeof value === "string") }
    : {};
}

function typeOfItems(document: OpenApiDocument, raw: JsonValue): string | undefined {
  const items = resolveSchema(document, raw);
  if (!isJsonObject(items)) return undefined;
  const declared = items["type"];
  return (Array.isArray(declared) ? declared : [declared]).find(
    (type): type is string => typeof type === "string" && type !== "null",
  );
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
  a.enumValues?.join("|") === b.enumValues?.join("|") &&
  a.items?.enumValues?.join("|") === b.items?.enumValues?.join("|");

/** Whether two declarations of a parameter differ in nothing but the values listed. */
function onlyValuesChanged(before: ParameterShape, after: ParameterShape): boolean {
  const { enumValues: _before, description: _was, default: _had, ...rest } = before;
  const { enumValues: _after, description: _is, default: _has, ...next } = after;
  return JSON.stringify(rest) === JSON.stringify(next);
}

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
 * as the parameter left out. Where only a value is missing, the decision a
 * body field would get is returned with the op written around it: what an
 * old caller sends for a parameter that became required or arrived required
 * with no default, and which accepted value each it may send that went is
 * sent as. Anything else is a question for a person, and is returned as one.
 */
export function parameterDrafts(deltas: readonly ParameterDelta[]): {
  drafts: ParameterDraft[];
  questions: ParameterQuestion[];
  decisions: Decision[];
} {
  const drafts: ParameterDraft[] = [];
  const questions: ParameterQuestion[] = [];
  const decisions: Decision[] = [];
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

  // What an old caller should send where the specification says nothing:
  // asked as the decision a body field's is, with the op written around the
  // answer. The parameter as the new contract declares it is what the
  // answer has to satisfy.
  const decide = (
    delta: ParameterDelta,
    parameter: ParameterShape,
    op: ValueDecision["op"],
    summary: string,
    why: string,
  ) =>
    decisions.push({
      kind: "value",
      id: `chg_param_${slugOf(delta.operation, parameter.name)}_${op.op === "add" ? "add" : "default_new"}`.slice(
        0,
        128,
      ),
      schema: `${delta.operation} ${delta.location} parameters`,
      scope: { operation: delta.operation, location: delta.location },
      field: parameter.name,
      pointer: `/${parameter.name}`,
      op,
      shape: {
        name: parameter.name,
        pointer: `/${parameter.name}`,
        type: parameter.type,
        format: parameter.format,
        enumValues: parameter.enumValues,
        description: parameter.description,
        required: parameter.required,
        nullable: parameter.nullable,
      },
      summary,
      why,
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
        decide(
          delta,
          parameter,
          { op: "add" },
          `The \`${parameter.name}\` ${delta.location} parameter of ${delta.operation} is new and required.`,
          `Old callers never send \`${parameter.name}\`, and it is now required. ` +
            "What their requests should carry instead is not in the specification.",
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
      let guessed = false;
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
            // Where nothing else about the parameter changed, which value
            // each that went is sent as is asked, as for a body field.
            const retired = onlyValuesChanged(before, after)
              ? retiredValueDecision({
                  schema: `${delta.operation} ${delta.location} parameters`,
                  scope: { operation: delta.operation, location: delta.location },
                  field: before.name,
                  pointer: path,
                  from,
                  to,
                })
              : undefined;
            if (retired !== undefined) {
              decisions.push(retired);
            } else {
              ask(
                delta,
                before.name,
                `the allowed values changed (${dropped.join(", ")} went), and which old value maps to which new one is a decision`,
                "removed",
              );
            }
            continue;
          }
          ops.push({ op: "convert", path, codec: { kind: "enumMap", pairs } });
          if (pairs.some(([from, to]) => from !== to)) {
            guessed = true;
            notes.push(
              `\`${dropped[0]}\` is paired with \`${gained[0]}\` only because each was the only one to go and to arrive; confirm it is the same value renamed`,
            );
          } else {
            notes.push("the new vocabulary keeps every old value");
          }
        }
      }

      // A list whose items stopped accepting values: Asana took a hundred and
      // twenty-six fields out of what `opt_fields` may ask for. What an old
      // caller asks for that is gone is left out, and the rest is served, a
      // loss the provider acknowledges. Values that went while others
      // arrived may be renames, which is a decision.
      const listedFrom = before.type === "array" ? before.items?.enumValues : undefined;
      const listedTo = after.type === "array" ? after.items?.enumValues : undefined;
      if (listedFrom && listedTo) {
        const went = listedFrom.filter((value) => !listedTo.includes(value));
        const arrived = listedTo.filter((value) => !listedFrom.includes(value));
        if (went.length > 0 && arrived.length > 0) {
          ask(
            delta,
            before.name,
            `the values its list accepts changed (${went.slice(0, 5).join(", ")}${went.length > 5 ? ", ..." : ""} went while others arrived), and whether any was renamed is a decision`,
            "removed",
          );
          continue;
        }
        if (went.length > 0) {
          ops.push({ op: "convert", path, codec: { kind: "dropValues", values: went } });
          notes.push(
            `${went.length} value${went.length === 1 ? "" : "s"} the list no longer accepts ${went.length === 1 ? "is" : "are"} left out of what old callers send; what they asked for with ${went.length === 1 ? "it" : "them"} is not given`,
          );
        }
      }

      const recoded =
        before.type !== undefined && after.type !== undefined
          ? (timeCodec(before, after) ?? (inPath ? undefined : listCodec(before, after)))
          : undefined;
      if (recoded !== undefined) {
        ops.push({ op: "convert", path, codec: recoded.codec });
        notes.push(recoded.note);
      } else if (
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
        const when =
          nowRequired && nullGone ? "absent-or-null" : nowRequired ? "absent" : "null";
        if (after.default === undefined) {
          // Asked where nothing else was drafted for it, so the answer is
          // the one Change on this parameter and nothing runs before it.
          if (ops.length === 0) {
            decide(
              delta,
              after,
              { op: "default", when, toward: "new" },
              `The \`${before.name}\` ${delta.location} parameter of ${delta.operation} is now required.`,
              `Old callers could leave \`${before.name}\` out, and it is now required. ` +
                "What their requests should carry in its place is not in the specification.",
            );
          } else {
            ask(
              delta,
              before.name,
              "old callers could leave it out, it is now required, and the value they should send is not in the specification",
              "added",
            );
          }
          continue;
        }
        ops.push({
          op: "default",
          path,
          value: after.default,
          when,
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

      if (ops.length === 0 && restatedFormat(before, after)) {
        ops.push({ op: "restate", path });
        notes.push(
          after.format === undefined
            ? `it no longer states the format ${before.format}, which refuses nothing old callers send`
            : `it now states the format ${after.format}, and every value old callers could send is one it holds`,
        );
      }

      if (ops.length === 0) continue;
      draft(
        delta,
        before.name,
        `The \`${before.name}\` ${delta.location} parameter of ${delta.operation} changed.`,
        ops,
        notes,
        guessed ? "explicit" : "normal",
      );
    }
  }

  return { drafts, questions, decisions };
}
