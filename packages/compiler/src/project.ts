/**
 * Projecting Changes into a compiled program.
 *
 * The runtime never sees a Change, a scope, or a direction. It sees an ordered
 * list of primitives per site, already inverted where inversion was needed. All
 * of the reasoning happens here, once, at build time.
 */
import {
  findSchemaSites,
  type OpenApiDocument,
  operationsOf,
  type RequestBodyMedia,
  requestBodyMedia,
  type Site,
} from "@invariant/contract";
import {
  type Change,
  type ContractProgram,
  type DataOp,
  type DefaultOp,
  type DropNullOp,
  type EnvelopeProgram,
  formatPointer,
  type Instr,
  isDataOp,
  isSchemaScope,
  type ParamCodec,
  type ParameterScope,
  parsePointer,
  type RouteRule,
  type SiteProgram,
  siteKey,
} from "@invariant/ir";
import { errorParamTargets, paramRenames } from "./error-params.ts";
import { formProgramFor, takesForm } from "./form.ts";
import { findInterference } from "./independence.ts";
import {
  addressOf,
  codecOf,
  envelopePointer,
  findParameter,
  headerRefusal,
  operationById,
  parametersOf,
} from "./parameters.ts";
import { mapEndpoint, type RouteMapping, routeMappings } from "./predict.ts";

export interface ProjectionIssue {
  changeId: string;
  message: string;
}

export interface Projection {
  program: ContractProgram;
  issues: ProjectionIssue[];
}

function prefixed(prefix: string, path: string): string {
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
function forwardInstrs(op: DataOp, prefix: string, changeId: string): Instr[] {
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
function backwardInstrs(op: DataOp, prefix: string, changeId: string): Instr[] {
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
 * One Change's primitives, in both directions, at a given pointer prefix.
 *
 * The verifier uses this to run a Change on its own: the whole point of the
 * lens laws is to test a single declaration against its own schema, before it
 * is concatenated with anything else.
 */
export function instrsFor(
  change: Change,
  prefix = "",
): { forward: Instr[]; backward: Instr[] } {
  const dataOps = change.ops.filter(isDataOp);
  return {
    forward: dataOps.flatMap((op) => forwardInstrs(op, prefix, change.id)),
    backward: [...dataOps]
      .reverse()
      .flatMap((op) => backwardInstrs(op, prefix, change.id)),
  };
}

interface SiteAccumulator {
  /**
   * In declared order. `param` marks an instruction over the request envelope;
   * the rest are over the body alone, and gain `/@body` if the site needs an
   * envelope at all.
   */
  request: { instr: Instr; param: boolean }[];
  response: Map<string, Instr[]>;
  /** How each parameter an instruction names is written, keyed `in name`. */
  old: Map<string, ParamCodec>;
  new: Map<string, ParamCodec>;
  /**
   * The request body as an old caller sends it and as the provider now takes
   * it, where either may be a form.
   */
  body?: { old: RequestBodyMedia; current: RequestBodyMedia | undefined } | undefined;
}

function accumulatorFor(
  sites: Map<string, SiteAccumulator>,
  key: string,
): SiteAccumulator {
  let entry = sites.get(key);
  if (!entry) {
    entry = { request: [], response: new Map(), old: new Map(), new: new Map() };
    sites.set(key, entry);
  }
  return entry;
}

/**
 * Compiles one contract step: the Changes released between `oldContract` and
 * `newContract`, projected onto the endpoints of the NEW contract, because that
 * is where the request will have arrived by the time the program runs.
 */
export function projectStep(
  label: string,
  oldContract: OpenApiDocument,
  changes: readonly Change[],
  newContract?: OpenApiDocument,
): Projection {
  const issues: ProjectionIssue[] = [...findInterference(changes)];
  const routes = routeMappings(changes);
  const sites = new Map<string, SiteAccumulator>();

  const routeRules: RouteRule[] = routes.map((route) => ({
    from: route.from,
    to: route.to,
    c: route.changeId,
  }));

  const behaviors: string[] = [];
  const retired: {
    method: string;
    path: string;
    guidance?: string;
    c: string;
    refuse?: true;
  }[] = [];
  for (const change of changes) {
    for (const op of change.ops) {
      if (op.op === "behavior") behaviors.push(op.flag);
      if (op.op === "retire") {
        retired.push({
          method: op.endpoint.method,
          path: op.endpoint.path,
          ...(op.guidance === undefined ? {} : { guidance: op.guidance }),
          c: change.id,
          ...(op.refuse === true || reachesAnother(op.endpoint, newContract)
            ? { refuse: true as const }
            : {}),
        });
      }
    }
  }

  // Requests apply Changes in declared order; responses undo them in reverse.
  for (const change of changes) {
    collectForward(change, oldContract, newContract, routes, sites, issues);
    collectParameters(change, oldContract, newContract, routes, sites, issues);
  }
  for (const change of [...changes].reverse()) {
    collectBackward(change, oldContract, routes, sites, issues);
  }

  if (newContract) {
    collectErrorParams(oldContract, newContract, changes, routes, sites);
  }

  const out: Record<string, SiteProgram> = {};
  for (const [key, entry] of [...sites.entries()].sort()) {
    const program: SiteProgram = {};
    if (entry.body && takesForm(entry.body.old)) {
      const bodyInstrs = entry.request.flatMap((item) => {
        if (!item.param) return [item.instr];
        const under = underBody(item.instr);
        return under ? [under] : [];
      });
      if (bodyInstrs.length > 0) {
        program.form = formProgramFor(
          oldContract,
          entry.body.old,
          entry.body.current,
          bodyInstrs,
        );
      }
    }
    if (entry.request.some((item) => item.param)) {
      program.envelope = envelopeOf(entry);
    } else if (entry.request.length > 0) {
      program.request = entry.request.map((item) => item.instr);
    }
    if (entry.response.size > 0) {
      program.response = Object.fromEntries(
        [...entry.response.entries()].sort().filter(([, instrs]) => instrs.length > 0),
      );
    }
    if (program.request || program.envelope || program.response) out[key] = program;
  }

  return {
    program: { label, routes: routeRules, sites: out, behaviors, retired },
    issues,
  };
}

/**
 * Whether a call to a retired operation could land on a different operation
 * of the new contract, if it were passed on.
 *
 * Only then is it refused outright. Two templates can match the same path
 * when every pair of segments either is the same text or contains a
 * parameter, which is deliberately generous: a parameter could hold anything.
 * Without the new contract nothing is known, and the refusal is kept.
 */
function reachesAnother(
  endpoint: { method: string; path: string },
  newContract: OpenApiDocument | undefined,
): boolean {
  if (!newContract) return true;
  const retired = endpoint.path.split("/");
  return operationsOf(newContract).some((operation) => {
    if (operation.webhook || operation.method !== endpoint.method) return false;
    const other = operation.path.split("/");
    return (
      other.length === retired.length &&
      other.every(
        (segment, index) =>
          segment === retired[index] ||
          segment.includes("{") ||
          (retired[index] as string).includes("{"),
      )
    );
  });
}

function sitesOf(
  change: Change,
  oldContract: OpenApiDocument,
  issues: ProjectionIssue[],
): Site[] {
  const found: Site[] = [];
  for (const scope of change.scopes ?? []) {
    // A parameter scope reaches one operation's request, collected on its own.
    if (!isSchemaScope(scope)) continue;
    const scan = findSchemaSites(oldContract, scope.schema);
    for (const message of scan.unsupported) {
      issues.push({ changeId: change.id, message });
    }
    found.push(...scan.sites);
  }
  return found;
}

function collectForward(
  change: Change,
  oldContract: OpenApiDocument,
  newContract: OpenApiDocument | undefined,
  routes: readonly RouteMapping[],
  sites: Map<string, SiteAccumulator>,
  issues: ProjectionIssue[],
): void {
  const dataOps = change.ops.filter(isDataOp);
  if (dataOps.length === 0) return;

  for (const site of sitesOf(change, oldContract, issues)) {
    if (site.direction !== "request") continue;
    const target = mapEndpoint(routes, site.method, site.path);
    const entry = accumulatorFor(sites, siteKey(target.method, target.path));
    entry.body ??= bodiesOf(oldContract, newContract, site, target);
    for (const op of dataOps) {
      entry.request.push(
        ...forwardInstrs(op, site.prefix, change.id).map((instr) => ({
          instr,
          param: false,
        })),
      );
    }
  }
}

/** An operation's request body before and after, located by where its calls now land. */
function bodiesOf(
  oldContract: OpenApiDocument,
  newContract: OpenApiDocument | undefined,
  from: { method: string; path: string },
  target: { method: string; path: string },
): SiteAccumulator["body"] {
  const find = (document: OpenApiDocument, where: { method: string; path: string }) =>
    operationsOf(document).find(
      (candidate) => candidate.method === where.method && candidate.path === where.path,
    );
  const before = find(oldContract, from);
  const old = before ? requestBodyMedia(oldContract, before.operation) : undefined;
  if (!old) return undefined;
  const after = newContract ? find(newContract, target) : undefined;
  return {
    old,
    current:
      after && newContract ? requestBodyMedia(newContract, after.operation) : undefined,
  };
}

/** An envelope instruction over the body alone, relative to the body, if it is one. */
export function underBody(instr: Instr): Instr | undefined {
  const strip = (pointer: string): string | undefined => {
    const segments = parsePointer(pointer);
    return segments[0] === "@body" ? formatPointer(segments.slice(1)) : undefined;
  };
  if (instr.k === "move") {
    const from = strip(instr.from);
    const to = strip(instr.to);
    // A value moved into the body from a parameter has no place in the form
    // an old caller sent, so there is nothing to type it by.
    return from !== undefined && to !== undefined ? { ...instr, from, to } : undefined;
  }
  const path = strip(instr.path);
  return path === undefined ? undefined : { ...instr, path };
}

/** The op with every pointer passed through `map`. */
function withPointers(op: DataOp, map: (pointer: string) => string): DataOp {
  return op.op === "move"
    ? { ...op, from: map(op.from), to: map(op.to) }
    : { ...op, path: map(op.path) };
}

function pointersOf(instr: Instr): string[] {
  return instr.k === "move" ? [instr.from, instr.to] : [instr.path];
}

/** The template's parameter names, in order. */
export function templateNames(path: string): string[] {
  return [...path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1] as string);
}

/**
 * A parameter scope's ops, over the request envelope of the one operation it
 * names, with each parameter they touch declared as each contract writes it.
 */
function collectParameters(
  change: Change,
  oldContract: OpenApiDocument,
  newContract: OpenApiDocument | undefined,
  routes: readonly RouteMapping[],
  sites: Map<string, SiteAccumulator>,
  issues: ProjectionIssue[],
): void {
  const dataOps = change.ops.filter(isDataOp);
  if (dataOps.length === 0) return;
  const refuse = (message: string) => issues.push({ changeId: change.id, message });

  for (const scope of change.scopes ?? []) {
    if (isSchemaScope(scope)) continue;
    const operation = operationById(oldContract, scope.operation);
    if (!operation) {
      refuse(`no operation called ${scope.operation} to scope a parameter change to`);
      continue;
    }
    const target = mapEndpoint(routes, operation.method, operation.path);
    const oldParams = parametersOf(oldContract, operation.method, operation.path);
    const newParams = newContract
      ? parametersOf(newContract, target.method, target.path)
      : [];
    const oldNames = templateNames(operation.path);
    const newNames = templateNames(target.path);
    const staged: { instr: Instr; param: boolean }[] = [];
    const codecs: { side: "old" | "new"; codec: ParamCodec }[] = [];
    let refused = false;

    for (const op of dataOps) {
      // A parameter exists only on the way in, so an op facing old callers'
      // responses has nothing to do here.
      if ((op.op === "default" || op.op === "dropNull") && op.toward === "old") continue;
      const touchesPath = (op.op === "move" ? [op.from, op.to] : [op.path]).some(
        (pointer) => {
          try {
            return addressOf(envelopePointer(scope.location, pointer)).part === "path";
          } catch {
            return false;
          }
        },
      );
      if (touchesPath && op.op !== "convert") {
        refuse(
          `a path parameter can only be converted: ${scope.operation}'s path has the ` +
            "parameters its template has, and renaming one is a route change",
        );
        refused = true;
        continue;
      }
      let absolute: DataOp;
      try {
        absolute = withPointers(op, (pointer) =>
          renamePathParameter(
            envelopePointer(scope.location, pointer),
            oldNames,
            newNames,
          ),
        );
      } catch (error) {
        refuse(error instanceof Error ? error.message : String(error));
        refused = true;
        continue;
      }
      const pointers =
        absolute.op === "move" ? [absolute.from, absolute.to] : [absolute.path];
      for (const pointer of pointers) {
        const problem = declare(scope, absolute, pointer, {
          oldContract,
          newContract,
          oldParams,
          newParams,
          oldNames,
          newNames,
          codecs,
        });
        if (problem) {
          refuse(problem);
          refused = true;
        }
      }
      // Instructions over the body alone are body instructions like any
      // other, so a site that needs nothing more keeps the plain body path.
      staged.push(
        ...forwardInstrs(absolute, "", change.id).map((instr) => {
          const under = underBody(instr);
          return under ? { instr: under, param: false } : { instr, param: true };
        }),
      );
    }

    if (refused) continue;
    const entry = accumulatorFor(sites, siteKey(target.method, target.path));
    entry.body ??= bodiesOf(oldContract, newContract, operation, target);
    entry.request.push(...staged);
    for (const { side, codec } of codecs) {
      const key = `${codec.in} ${codec.name}`;
      const map = side === "old" ? entry.old : entry.new;
      if (!map.has(key)) map.set(key, codec);
    }
  }
}

/**
 * A path parameter as the site's template names it. The old operation's
 * template and the one its calls now reach can name the same position
 * differently when a route change renamed it.
 */
function renamePathParameter(
  pointer: string,
  oldNames: readonly string[],
  newNames: readonly string[],
): string {
  const segments = parsePointer(pointer);
  if (segments[0] !== "@path" || segments[1] === undefined) return pointer;
  const index = oldNames.indexOf(segments[1]);
  if (index === -1) throw new Error(`the path has no parameter called ${segments[1]}`);
  const renamed = newNames[index];
  if (renamed === undefined) {
    throw new Error(
      `the path parameter ${segments[1]} has no place in the path it now reaches`,
    );
  }
  return formatPointer(["@path", renamed, ...segments.slice(2)]);
}

/**
 * Checks one pointer of a parameter op and records how the parameter it names
 * is written. Returns why it cannot be served, if it cannot.
 */
function declare(
  scope: ParameterScope,
  op: DataOp,
  pointer: string,
  context: {
    oldContract: OpenApiDocument;
    newContract: OpenApiDocument | undefined;
    oldParams: ReturnType<typeof parametersOf>;
    newParams: ReturnType<typeof parametersOf>;
    oldNames: readonly string[];
    newNames: readonly string[];
    codecs: { side: "old" | "new"; codec: ParamCodec }[];
  },
): string | undefined {
  const { oldContract, newContract, oldParams, newParams, codecs } = context;
  const address = addressOf(pointer);
  if (address.part === "body") return undefined;
  const name = address.name;
  if (name === undefined || name === "*") {
    return `${pointer} names every ${address.part} parameter at once, not one of them`;
  }
  if (address.part === "path" && op.op !== "convert") {
    return (
      `a path parameter can only be converted: ${scope.operation}'s path has the ` +
      "parameters its template has, and renaming one is a route change"
    );
  }
  if (address.part === "header") {
    const refusal =
      headerRefusal(oldContract, name) ??
      (newContract ? headerRefusal(newContract, name) : undefined);
    if (refusal) return refusal;
  }
  // A path parameter is named here as the site's template names it, which
  // is the old operation's name for the same position.
  const oldName =
    address.part === "path"
      ? (context.oldNames[context.newNames.indexOf(name)] ?? name)
      : name;
  const oldDeclared = findParameter(oldParams, address.part, oldName);
  const newDeclared = findParameter(newParams, address.part, name);
  if (!oldDeclared && !newDeclared) {
    return `the ${address.part} parameter ${name} is declared by neither contract of ${scope.operation}`;
  }
  for (const [side, declared, document] of [
    ["old", oldDeclared, oldContract],
    ["new", newDeclared, newContract],
  ] as const) {
    if (!declared || !document) continue;
    const codec = codecOf(document, declared);
    if ("refused" in codec) return codec.refused;
    // Written under the name the site's template uses.
    codecs.push({ side, codec: { ...codec, name } });
  }
  return undefined;
}

/** A site's request instructions as one program over the whole request. */
function envelopeOf(entry: SiteAccumulator): EnvelopeProgram {
  const instrs = entry.request.map((item) =>
    item.param ? item.instr : prefixInstr(item.instr, "@body"),
  );
  return {
    instrs,
    params: {
      old: [...entry.old.values()].sort(byCodec),
      new: [...entry.new.values()].sort(byCodec),
    },
    body: instrs.some((instr) =>
      pointersOf(instr).some((pointer) => parsePointer(pointer)[0] === "@body"),
    ),
  };
}

export function byCodec(a: ParamCodec, b: ParamCodec): number {
  return `${a.in} ${a.name}`.localeCompare(`${b.in} ${b.name}`);
}

/** The instruction with every pointer placed under one part of the envelope. */
export function prefixInstr(instr: Instr, part: string): Instr {
  const under = (pointer: string) => formatPointer([part, ...parsePointer(pointer)]);
  return instr.k === "move"
    ? { ...instr, from: under(instr.from), to: under(instr.to) }
    : { ...instr, path: under(instr.path) };
}

function collectBackward(
  change: Change,
  oldContract: OpenApiDocument,
  routes: readonly RouteMapping[],
  sites: Map<string, SiteAccumulator>,
  issues: ProjectionIssue[],
): void {
  const dataOps = change.ops.filter(isDataOp);
  if (dataOps.length === 0) return;

  for (const site of sitesOf(change, oldContract, issues)) {
    if (site.direction !== "response" || site.status === undefined) continue;
    const target = mapEndpoint(routes, site.method, site.path);
    const entry = accumulatorFor(sites, siteKey(target.method, target.path));
    let instrs = entry.response.get(site.status);
    if (!instrs) {
      instrs = [];
      entry.response.set(site.status, instrs);
    }
    for (const op of [...dataOps].reverse()) {
      instrs.push(...backwardInstrs(op, site.prefix, change.id));
    }
  }
}

/**
 * Maps the parameter name an error points at back to what the old contract
 * called it, using the renames the step already declared.
 */
function collectErrorParams(
  oldContract: OpenApiDocument,
  newContract: OpenApiDocument,
  changes: readonly Change[],
  routes: readonly RouteMapping[],
  sites: Map<string, SiteAccumulator>,
): void {
  const renames = paramRenames(oldContract, changes);
  if (renames.size === 0) return;

  // An operation may have been renamed along with its fields, so match the
  // new contract's operations by where the old ones ended up.
  const canonicalId = new Map<string, string>();
  for (const { operationId, method, path } of operationsOf(oldContract)) {
    const target = mapEndpoint(routes, method, path);
    const match = operationsOf(newContract).find(
      (candidate) => candidate.method === target.method && candidate.path === target.path,
    );
    if (match) canonicalId.set(match.operationId, operationId);
  }

  for (const target of errorParamTargets(newContract)) {
    const originalId = canonicalId.get(target.operationId) ?? target.operationId;
    const list = renames.get(originalId);
    if (!list || list.length === 0) continue;

    const entry = accumulatorFor(sites, siteKey(target.method, target.path));
    let instrs = entry.response.get(target.status);
    if (!instrs) {
      instrs = [];
      entry.response.set(target.status, instrs);
    }

    const map: Record<string, string> = {};
    for (const rename of list) map[rename.from] = rename.to;
    instrs.push({
      k: "enum",
      path: target.pointer,
      map,
      lenient: true,
      c: list[0]?.changeId ?? "",
    });
  }
}
