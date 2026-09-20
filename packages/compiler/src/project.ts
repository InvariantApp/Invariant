/**
 * Projecting Changes into a compiled program.
 *
 * The runtime never sees a Change, a scope, or a direction. It sees an ordered
 * list of primitives per site, already inverted where inversion was needed. All
 * of the reasoning happens here, once, at build time.
 */
import { findSchemaSites, type OpenApiDocument, type Site } from "@invariant/contract";
import {
  type Change,
  type ContractProgram,
  type DataOp,
  formatPointer,
  type Instr,
  isDataOp,
  isSchemaScope,
  parsePointer,
  type RouteRule,
  type SiteProgram,
  siteKey,
} from "@invariant/ir";
import { findInterference } from "./independence.ts";
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
              map: Object.fromEntries(op.codec.pairs.map(([from, to]) => [to, from])),
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
  }
  return [];
}

interface SiteAccumulator {
  request: Instr[];
  response: Map<string, Instr[]>;
}

function accumulatorFor(
  sites: Map<string, SiteAccumulator>,
  key: string,
): SiteAccumulator {
  let entry = sites.get(key);
  if (!entry) {
    entry = { request: [], response: new Map() };
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
  for (const change of changes) {
    for (const op of change.ops) {
      if (op.op === "behavior") behaviors.push(op.flag);
    }
  }

  // Requests apply Changes in declared order; responses undo them in reverse.
  for (const change of changes) {
    collectForward(change, oldContract, routes, sites, issues);
  }
  for (const change of [...changes].reverse()) {
    collectBackward(change, oldContract, routes, sites, issues);
  }

  const out: Record<string, SiteProgram> = {};
  for (const [key, entry] of [...sites.entries()].sort()) {
    const program: SiteProgram = {};
    if (entry.request.length > 0) program.request = entry.request;
    if (entry.response.size > 0) {
      program.response = Object.fromEntries(
        [...entry.response.entries()].sort().filter(([, instrs]) => instrs.length > 0),
      );
    }
    if (program.request || program.response) out[key] = program;
  }

  return {
    program: { label, routes: routeRules, sites: out, behaviors },
    issues,
  };
}

function sitesOf(
  change: Change,
  oldContract: OpenApiDocument,
  issues: ProjectionIssue[],
): Site[] {
  const found: Site[] = [];
  for (const scope of change.scopes ?? []) {
    if (!isSchemaScope(scope)) {
      issues.push({ changeId: change.id, message: "only schema scopes are supported" });
      continue;
    }
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
    for (const op of dataOps) {
      entry.request.push(...forwardInstrs(op, site.prefix, change.id));
    }
  }
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
