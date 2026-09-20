/**
 * Chaining contract steps into one program per historical contract.
 *
 * Every system that has done this in production chains per-version transforms
 * at request time. Invariant chains at build time instead: the steps between a
 * historical contract and the current one are concatenated once, so a request
 * from a consumer four contracts behind costs the same single pass as one from
 * a consumer one contract behind.
 *
 * Concatenation is correct because each step's ops were written against the two
 * contracts either side of it, and the forward pass replays them in the order
 * they happened while the backward pass undoes them in the reverse order.
 */
import { type OpenApiDocument, operationsOf } from "@invariant/contract";
import type {
  Change,
  CompiledProgram,
  ContractProgram,
  Instr,
  RouteRule,
  SiteProgram,
} from "@invariant/ir";
import { IR_VERSION, siteKey } from "@invariant/ir";
import { mapEndpoint, type RouteMapping, routeMappings } from "./predict.ts";
import { type ProjectionIssue, projectStep } from "./project.ts";

export interface ContractStep {
  /** Label of the contract this step produces. */
  label: string;
  /** Label of the contract this step starts from. */
  parent: string;
  from: OpenApiDocument;
  to: OpenApiDocument;
  changes: Change[];
}

export interface ChainResult {
  program: CompiledProgram;
  issues: ProjectionIssue[];
}

/** Follows an endpoint through each later step's route changes, in order. */
function mapThrough(
  routeSteps: readonly (readonly RouteMapping[])[],
  method: string,
  path: string,
): { method: string; path: string } {
  let current = { method: method.toLowerCase(), path };
  for (const routes of routeSteps) {
    current = mapEndpoint(routes, current.method, current.path);
  }
  return current;
}

function remapKey(key: string, routeSteps: readonly (readonly RouteMapping[])[]): string {
  const separator = key.indexOf(" ");
  const target = mapThrough(
    routeSteps,
    key.slice(0, separator),
    key.slice(separator + 1),
  );
  return siteKey(target.method, target.path);
}

/**
 * Folds a later step into what earlier steps already produced.
 *
 * The two directions compose in opposite orders, and this is the only place
 * that matters. A request moves forward through time, so the later step's work
 * happens last. A response moves backward through time, so the later step is
 * the first thing undone.
 */
function mergeSite(earlier: SiteProgram, later: SiteProgram): SiteProgram {
  const out: SiteProgram = {};

  const request = [...(earlier.request ?? []), ...(later.request ?? [])];
  if (request.length > 0) out.request = request;

  if (earlier.response || later.response) {
    const response: Record<string, Instr[]> = {};
    const statuses = new Set([
      ...Object.keys(earlier.response ?? {}),
      ...Object.keys(later.response ?? {}),
    ]);
    for (const status of [...statuses].sort()) {
      response[status] = [
        ...(later.response?.[status] ?? []),
        ...(earlier.response?.[status] ?? []),
      ];
    }
    out.response = response;
  }

  return out;
}

/**
 * Builds the program for one historical contract, straight through to current.
 */
export function chainContract(
  label: string,
  steps: readonly ContractStep[],
): { program: ContractProgram; issues: ProjectionIssue[] } {
  const issues: ProjectionIssue[] = [];
  const sites = new Map<string, SiteProgram>();
  const routes: RouteRule[] = [];
  const behaviors: string[] = [];

  // Route rules for the whole chain, expressed from the historical contract's
  // endpoint straight to the current one.
  const laterRoutes: RouteMapping[][] = steps.map((step) => routeMappings(step.changes));

  steps.forEach((step, index) => {
    const projected = projectStep(step.label, step.from, step.changes);
    issues.push(...projected.issues);
    behaviors.push(...projected.program.behaviors);

    const after = laterRoutes.slice(index + 1);

    for (const [key, program] of Object.entries(projected.program.sites)) {
      const finalKey = remapKey(key, after);
      const existing = sites.get(finalKey);
      sites.set(finalKey, existing ? mergeSite(existing, program) : program);
    }
  });

  // One rewrite per endpoint, computed by walking each endpoint of the
  // historical contract all the way to where it lives now. A request is
  // rewritten once, however many steps it has to travel.
  const historical = steps[0]?.from;
  if (historical) {
    for (const operation of operationsOf(historical)) {
      const target = mapThrough(laterRoutes, operation.method, operation.path);
      if (target.method === operation.method && target.path === operation.path) continue;
      routes.push({
        from: { method: operation.method, path: operation.path },
        to: target,
        c: routeChangeFor(steps, operation.method, operation.path) ?? "",
      });
    }
  }

  return {
    program: {
      label,
      routes: routes.sort((a, b) =>
        siteKey(a.from.method, a.from.path).localeCompare(
          siteKey(b.from.method, b.from.path),
        ),
      ),
      sites: Object.fromEntries([...sites.entries()].sort()),
      behaviors: [...new Set(behaviors)].sort(),
    },
    issues,
  };
}

/** Which Change first moved this endpoint, for counting and kill-switching. */
function routeChangeFor(
  steps: readonly ContractStep[],
  method: string,
  path: string,
): string | undefined {
  let current = { method, path };
  for (const step of steps) {
    for (const route of routeMappings(step.changes)) {
      if (route.from.method === current.method && route.from.path === current.path) {
        return route.changeId;
      }
    }
    current = mapEndpoint(routeMappings(step.changes), current.method, current.path);
  }
  return undefined;
}

/**
 * Compiles every historical contract still served into one program.
 *
 * `steps` runs oldest first. The program for contract N is built from step N
 * onward, so each active contract gets a direct path to current.
 */
export function chainProgram(
  api: string,
  currentLabel: string,
  currentDigest: string,
  steps: readonly ContractStep[],
): ChainResult {
  const issues: ProjectionIssue[] = [];
  const contracts: Record<string, ContractProgram> = {};

  steps.forEach((step, index) => {
    const label = step.parent;
    const chained = chainContract(label, steps.slice(index));
    issues.push(...chained.issues);
    contracts[label] = chained.program;
  });

  return {
    program: {
      irVersion: IR_VERSION,
      api,
      current: currentDigest,
      currentLabel,
      contracts,
    },
    issues,
  };
}
