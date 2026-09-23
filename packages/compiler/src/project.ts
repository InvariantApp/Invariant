/**
 * Projecting Changes into a compiled program.
 *
 * The runtime never sees a Change, a scope, or a direction. It sees an ordered
 * list of primitives per site, already inverted where inversion was needed. All
 * of the reasoning happens here, once, at build time.
 */
import {
  findSchemaSites,
  findSchemaWithin,
  type Guard,
  type OpenApiDocument,
  operationsOf,
  type RequestBodyMedia,
  requestBodyMedia,
  requestBodySchema,
  responseSchemas,
  type Site,
  variantGuard,
} from "@invariant-app/contract";
import {
  type Change,
  type ContractProgram,
  type DataOp,
  type EnvelopeProgram,
  formatPointer,
  type Instr,
  isDataOp,
  isParameterScope,
  isResponseScope,
  isSchemaScope,
  type ParamCodec,
  type ParameterScope,
  parsePointer,
  type RouteRule,
  type SiteProgram,
  siteKey,
  type WidenOp,
} from "@invariant-app/ir";
import { derive } from "./derive.ts";
import { errorParamTargets, paramRenames } from "./error-params.ts";
import { formProgramFor, takesForm } from "./form.ts";
import { findInterference } from "./independence.ts";
import {
  backwardInstrs,
  forwardInstrs,
  guarded,
  PATH_PARAMETER_REFUSAL,
  prefixed,
  servesPathParameter,
  type VariantGuards,
} from "./lens.ts";
import {
  addressOf,
  codecOf,
  envelopePointer,
  findParameter,
  headerRefusal,
  operationById,
  parametersOf,
} from "./parameters.ts";
import {
  mapEndpoint,
  type RouteMapping,
  routeMappings,
  unaddressableKeys,
} from "./predict.ts";
import { type SharedBlocks, sharedBlocks } from "./shared.ts";

export interface ProjectionIssue {
  changeId: string;
  message: string;
}

export interface Projection {
  program: ContractProgram;
  issues: ProjectionIssue[];
}

/**
 * One Change's primitives, in both directions, at a given pointer prefix, for
 * looking at what a single declaration compiles to. What the laws check is
 * the composition `schemaLens` builds.
 */
export function instrsFor(
  change: Change,
  prefix = "",
  variants?: VariantGuards,
): { forward: Instr[]; backward: Instr[] } {
  const dataOps = change.ops.filter(isDataOp);
  return {
    forward: dataOps.flatMap((op) => forwardInstrs(op, prefix, change.id)),
    backward: [...dataOps]
      .reverse()
      .flatMap((op) => backwardInstrs(op, prefix, change.id, variants)),
  };
}

/**
 * How each widened union's new variant is recognised, from the contract it
 * arrives in, where the union and the variant both are.
 */
export function variantGuardsFor(
  changes: readonly Change[],
  newContract: OpenApiDocument | undefined,
): VariantGuards {
  const scopes = new Map<WidenOp, string>();
  for (const change of changes) {
    const scope = (change.scopes ?? []).find(isSchemaScope);
    if (!scope) continue;
    for (const op of change.ops) if (op.op === "widen") scopes.set(op, scope.schema);
  }
  const known = new Map<WidenOp, Guard | undefined>();
  return (op) => {
    if (!known.has(op)) {
      const scope = scopes.get(op);
      known.set(
        op,
        scope === undefined || newContract === undefined
          ? undefined
          : variantGuard(newContract, scope, op.path, op.variant),
      );
    }
    return known.get(op);
  };
}

/**
 * What a value of `schemaRef` goes through wherever it is a body, with every
 * Change in the release placed where its schema sits inside it: the lens the
 * compiler projects onto such a site, for checking on values.
 *
 * Requests apply the Changes in declared order and responses undo them in
 * reverse, as a site does.
 */
export function schemaLens(
  oldContract: OpenApiDocument,
  changes: readonly Change[],
  schemaRef: string,
  newContract?: OpenApiDocument,
): {
  forward: Instr[];
  backward: Instr[];
  changes: Change[];
  /** Where each direction may lose information by declaration, from the root, `*` for list items. */
  lossy: { forward: string[]; backward: string[] };
  /** The shared blocks the instructions call, for schemas whose places cannot be listed. */
  blocks: Record<string, Instr[]>;
} {
  const variants = variantGuardsFor(changes, newContract);
  const shared = sharedBlocks("lens", oldContract, changes, variants);
  const forward: Instr[] = [];
  const backward: Instr[][] = [];
  const involved: Change[] = [];
  const lossy = { forward: [] as string[], backward: [] as string[] };
  for (const change of changes) {
    const dataOps = change.ops.filter(isDataOp);
    if (dataOps.length === 0) continue;
    const declared = derive(change).lossy;
    const mine: Instr[] = [];
    let back: Instr[] = [];
    for (const scope of change.scopes ?? []) {
      if (!isSchemaScope(scope)) continue;
      const places = findSchemaWithin(oldContract, scope.schema, schemaRef).placements;
      if (shared.targets.has(scope.schema)) {
        // Run through the blocks below. Its declared loss is excused where the
        // schema sits down to the depth its places can be listed, which is as
        // deep as generated values of a recursive schema usually go.
        if (places.length > 0 && !involved.includes(change)) involved.push(change);
        for (const place of places) {
          lossy.forward.push(
            ...declared.forward.map((path) => prefixed(place.prefix, path)),
          );
          lossy.backward.push(
            ...declared.backward.map((path) => prefixed(place.prefix, path)),
          );
        }
        continue;
      }
      for (const place of places) {
        lossy.forward.push(
          ...declared.forward.map((path) => prefixed(place.prefix, path)),
        );
        lossy.backward.push(
          ...declared.backward.map((path) => prefixed(place.prefix, path)),
        );
        mine.push(
          ...guarded(place, change, "forward", (prefix) =>
            dataOps.flatMap((op) => forwardInstrs(op, prefix, change.id)),
          ),
        );
        // Undone in the reverse of the order it was applied in.
        back = [
          ...guarded(place, change, "backward", (prefix) =>
            [...dataOps]
              .reverse()
              .flatMap((op) => backwardInstrs(op, prefix, change.id, variants)),
          ),
          ...back,
        ];
      }
    }
    if (mine.length === 0 && back.length === 0) continue;
    if (!involved.includes(change)) involved.push(change);
    forward.push(...mine);
    backward.push(back);
  }
  // As at a site: the shared blocks after the listed instructions on the way
  // in, and before them on the way out.
  const root = { $ref: schemaRef };
  return {
    forward: [...forward, ...shared.entry(root, "forward")],
    backward: [...shared.entry(root, "backward"), ...backward.reverse().flat()],
    changes: involved,
    lossy,
    blocks: shared.blocks,
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
  const issues: ProjectionIssue[] = [
    ...unaddressableKeys(changes),
    ...findInterference(changes),
  ];
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

  const variants = variantGuardsFor(changes, newContract);
  for (const change of changes) {
    for (const op of change.ops) {
      if (op.op === "widen" && variants(op) === undefined) {
        issues.push({
          changeId: change.id,
          message: `${op.variant} cannot be told apart from the other kinds of value at ${op.path}, so it cannot be shown to old callers as anything else`,
        });
      }
    }
  }
  const shared = sharedBlocks(label, oldContract, changes, variants);
  issues.push(...shared.issues);

  // Requests apply Changes in declared order; responses undo them in reverse.
  for (const change of changes) {
    collectForward(
      change,
      oldContract,
      newContract,
      routes,
      sites,
      issues,
      shared.targets,
    );
    collectParameters(change, oldContract, newContract, routes, sites, issues);
  }
  const outbound = new Map<string, Instr[]>();
  for (const change of [...changes].reverse()) {
    collectBackward(
      change,
      oldContract,
      routes,
      sites,
      outbound,
      issues,
      shared.targets,
      variants,
    );
  }

  collectShared(shared, oldContract, newContract, routes, sites);

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
          shared.blocks,
        );
      }
    }
    if (entry.request.some((item) => item.param)) {
      program.envelope = envelopeOf(entry);
    } else if (entry.request.length > 0) {
      program.request = entry.request.map((item) => item.instr);
    }
    const responses = [...entry.response.entries()]
      .sort()
      .filter(([, instrs]) => instrs.length > 0);
    // A status whose Changes compile to nothing, as a bound does, is not work.
    if (responses.length > 0) program.response = Object.fromEntries(responses);
    if (program.request || program.envelope || program.response) out[key] = program;
  }

  const sent = [...outbound.entries()].sort().filter(([, instrs]) => instrs.length > 0);

  return {
    program: {
      label,
      routes: routeRules,
      sites: out,
      ...(sent.length > 0 ? { outbound: Object.fromEntries(sent) } : {}),
      ...(Object.keys(shared.blocks).length > 0 ? { blocks: shared.blocks } : {}),
      behaviors,
      retired,
    },
    issues,
  };
}

/**
 * Starts every body that can hold a schema served by shared blocks on its way
 * through them. After the listed instructions on the way in, and before them
 * on the way out, so each direction undoes the other.
 */
function collectShared(
  shared: SharedBlocks,
  oldContract: OpenApiDocument,
  newContract: OpenApiDocument | undefined,
  routes: readonly RouteMapping[],
  sites: Map<string, SiteAccumulator>,
): void {
  if (shared.targets.size === 0) return;
  for (const { method, path, operation, webhook } of operationsOf(oldContract)) {
    if (webhook === true) continue;
    const target = mapEndpoint(routes, method, path);
    const key = siteKey(target.method, target.path);
    const request = requestBodySchema(oldContract, operation);
    const forward = request === undefined ? [] : shared.entry(request, "forward");
    if (forward.length > 0) {
      const entry = accumulatorFor(sites, key);
      entry.body ??= bodiesOf(oldContract, newContract, { method, path }, target);
      entry.request.push(...forward.map((instr) => ({ instr, param: false })));
    }
    for (const { status, schema } of responseSchemas(oldContract, operation)) {
      const backward = shared.entry(schema, "backward");
      if (backward.length === 0) continue;
      const entry = accumulatorFor(sites, key);
      entry.response.set(status, [...backward, ...(entry.response.get(status) ?? [])]);
    }
  }
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
  shared: ReadonlySet<string>,
): Site[] {
  const found: Site[] = [];
  for (const scope of change.scopes ?? []) {
    // One operation's response body, at its root.
    if (isResponseScope(scope)) {
      const operation = operationById(oldContract, scope.operation);
      if (!operation) {
        issues.push({
          changeId: change.id,
          message: `no operation called ${scope.operation} to scope a response change to`,
        });
        continue;
      }
      found.push({
        operationId: operation.operationId,
        method: operation.method,
        path: operation.path,
        direction: "response",
        status: scope.response,
        prefix: "",
      });
      continue;
    }
    // A parameter scope reaches one operation's request, collected on its own.
    if (!isSchemaScope(scope)) continue;
    // Served by the blocks that follow the value, placed once for all of it.
    if (shared.has(scope.schema)) continue;
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
  shared: ReadonlySet<string>,
): void {
  const dataOps = change.ops.filter(isDataOp);
  if (dataOps.length === 0) return;

  for (const site of sitesOf(change, oldContract, issues, shared)) {
    if (site.direction !== "request") continue;
    const target = mapEndpoint(routes, site.method, site.path);
    const entry = accumulatorFor(sites, siteKey(target.method, target.path));
    entry.body ??= bodiesOf(oldContract, newContract, site, target);
    entry.request.push(
      ...guarded(site, change, "forward", (prefix) =>
        dataOps.flatMap((op) => forwardInstrs(op, prefix, change.id)),
      ).map((instr) => ({ instr, param: false })),
    );
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
  // A call stands where it is put, which in an envelope is under a `within`.
  if (instr.k === "call") return undefined;
  const path = strip(instr.path);
  return path === undefined ? undefined : { ...instr, path };
}

/** The op with every pointer passed through `map`. */
function withPointers(op: DataOp, map: (pointer: string) => string): DataOp {
  return op.op === "move"
    ? { ...op, from: map(op.from), to: map(op.to) }
    : { ...op, path: map(op.path) };
}

/** Where an instruction stands; a call stands wherever it is placed, which a `within` names. */
function pointersOf(instr: Instr): string[] {
  if (instr.k === "call") return [];
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
    if (!isParameterScope(scope)) continue;
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
      if (touchesPath && !servesPathParameter(op)) {
        refuse(
          `${PATH_PARAMETER_REFUSAL}: ${scope.operation}'s path has the ` +
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
  if (address.part === "path" && !servesPathParameter(op)) {
    return (
      `${PATH_PARAMETER_REFUSAL}: ${scope.operation}'s path has the ` +
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
  switch (instr.k) {
    case "move":
      return { ...instr, from: under(instr.from), to: under(instr.to) };
    case "within":
      return { ...instr, path: under(instr.path) };
    case "switch":
    case "has":
    case "is":
    case "call":
      // Its block runs where it stands, so it has to stand in the part.
      return { k: "within", path: formatPointer([part]), block: [instr], c: instr.c };
    default:
      return { ...instr, path: under(instr.path) };
  }
}

function collectBackward(
  change: Change,
  oldContract: OpenApiDocument,
  routes: readonly RouteMapping[],
  sites: Map<string, SiteAccumulator>,
  outbound: Map<string, Instr[]>,
  issues: ProjectionIssue[],
  shared: ReadonlySet<string>,
  variants: VariantGuards,
): void {
  const dataOps = change.ops.filter(isDataOp);
  if (dataOps.length === 0) return;

  for (const site of sitesOf(change, oldContract, issues, shared)) {
    if (site.direction === "outbound") {
      // Named by the event rather than an endpoint, so no route moves it.
      const key = siteKey(site.method, site.path);
      const instrs = outbound.get(key) ?? [];
      instrs.push(
        ...guarded(site, change, "backward", (prefix) =>
          [...dataOps]
            .reverse()
            .flatMap((op) => backwardInstrs(op, prefix, change.id, variants)),
        ),
      );
      outbound.set(key, instrs);
      continue;
    }
    if (site.direction !== "response" || site.status === undefined) continue;
    const target = mapEndpoint(routes, site.method, site.path);
    const entry = accumulatorFor(sites, siteKey(target.method, target.path));
    let instrs = entry.response.get(site.status);
    if (!instrs) {
      instrs = [];
      entry.response.set(site.status, instrs);
    }
    instrs.push(
      ...guarded(site, change, "backward", (prefix) =>
        [...dataOps]
          .reverse()
          .flatMap((op) => backwardInstrs(op, prefix, change.id, variants)),
      ),
    );
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
