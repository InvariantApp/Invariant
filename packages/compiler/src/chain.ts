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
  EnvelopeProgram,
  Instr,
  ParamCodec,
  RouteRule,
  SiteProgram,
} from "@invariant/ir";
import {
  formatPointer,
  IR_VERSION,
  isJsonObject,
  parsePointer,
  siteKey,
} from "@invariant/ir";
import { mergeForms } from "./form.ts";
import { mapEndpoint, type RouteMapping, routeMappings } from "./predict.ts";
import {
  byCodec,
  type ProjectionIssue,
  prefixInstr,
  projectStep,
  templateNames,
  underBody,
} from "./project.ts";

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

  const form = mergeForms(earlier.form, later.form, bodyInstrsOf(earlier));
  if (form) out.form = form;

  if (earlier.envelope || later.envelope) {
    // One step reaches a parameter, so the whole chain runs over the
    // envelope, in order, with each body-only step's instructions under
    // `/@body`.
    const first = asEnvelope(earlier);
    const second = asEnvelope(later);
    const oldCodecs = new Map<string, ParamCodec>();
    const newCodecs = new Map<string, ParamCodec>();
    for (const codec of first.params.old) oldCodecs.set(codecKey(codec), codec);
    for (const codec of first.params.new) newCodecs.set(codecKey(codec), codec);
    // A name no earlier step touched is written by the historical caller just
    // as the later step's old contract declares it, since nothing changed it
    // in between. A name an earlier step introduced is only ever written by
    // the program, and the last word on how the provider expects any name is
    // the latest step's.
    for (const codec of second.params.old) {
      const key = codecKey(codec);
      if (!oldCodecs.has(key) && !newCodecs.has(key)) oldCodecs.set(key, codec);
    }
    for (const codec of second.params.new) newCodecs.set(codecKey(codec), codec);
    out.envelope = {
      instrs: [...first.instrs, ...second.instrs],
      params: {
        old: [...oldCodecs.values()].sort(byCodec),
        new: [...newCodecs.values()].sort(byCodec),
      },
      body: first.body || second.body,
    };
  } else {
    const request = [...(earlier.request ?? []), ...(later.request ?? [])];
    if (request.length > 0) out.request = request;
  }

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

const codecKey = (codec: ParamCodec) => `${codec.in} ${codec.name}`;

/** A site's request instructions over the body, relative to it. */
function bodyInstrsOf(site: SiteProgram): Instr[] {
  if (site.envelope) {
    return site.envelope.instrs.flatMap((instr) => {
      const under = underBody(instr);
      return under ? [under] : [];
    });
  }
  return site.request ?? [];
}

function asEnvelope(site: SiteProgram): EnvelopeProgram {
  if (site.envelope) return site.envelope;
  const instrs = (site.request ?? []).map((instr) => prefixInstr(instr, "@body"));
  return { instrs, params: { old: [], new: [] }, body: instrs.length > 0 };
}

/**
 * A site program as it reads once later route changes have renamed the path
 * it lives at. Path parameters are named by the template, so a parameter a
 * later step renamed has to be addressed by its new name, found by position.
 */
function renamePathParameters(
  program: SiteProgram,
  fromPath: string,
  toPath: string,
): SiteProgram {
  const envelope = program.envelope;
  if (!envelope || fromPath === toPath) return program;
  const from = templateNames(fromPath);
  const to = templateNames(toPath);
  const rename = (name: string) => to[from.indexOf(name)] ?? name;
  const pointer = (value: string) => {
    const segments = parsePointer(value);
    if (segments[0] !== "@path" || segments[1] === undefined) return value;
    return formatPointer(["@path", rename(segments[1]), ...segments.slice(2)]);
  };
  const codec = (entry: ParamCodec): ParamCodec =>
    entry.in === "path" ? { ...entry, name: rename(entry.name) } : entry;
  return {
    ...program,
    envelope: {
      ...envelope,
      instrs: envelope.instrs.map((instr) =>
        instr.k === "move"
          ? { ...instr, from: pointer(instr.from), to: pointer(instr.to) }
          : instr.k === "call"
            ? instr
            : { ...instr, path: pointer(instr.path) },
      ),
      params: {
        old: envelope.params.old.map(codec),
        new: envelope.params.new.map(codec),
      },
    },
  };
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
  const retired: ContractProgram["retired"] = [];
  // Each step names its blocks after its own label, so steps never collide.
  const blocks: Record<string, Instr[]> = {};

  // Route rules for the whole chain, expressed from the historical contract's
  // endpoint straight to the current one.
  const laterRoutes: RouteMapping[][] = steps.map((step) => routeMappings(step.changes));

  steps.forEach((step, index) => {
    const projected = projectStep(step.label, step.from, step.changes, step.to);
    issues.push(...projected.issues);
    behaviors.push(...projected.program.behaviors);
    Object.assign(blocks, projected.program.blocks ?? {});
    // A retired endpoint is named as it stood in the contract that retired it,
    // which is also the path a request reaches after the earlier steps' route
    // rewrites. Later steps never touch it, because it no longer exists there.
    retired.push(...projected.program.retired);

    const after = laterRoutes.slice(index + 1);

    for (const [key, raw] of Object.entries(projected.program.sites)) {
      const finalKey = remapKey(key, after);
      const program = renamePathParameters(
        raw,
        key.slice(key.indexOf(" ") + 1),
        finalKey.slice(finalKey.indexOf(" ") + 1),
      );
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
      ...(Object.keys(blocks).length > 0
        ? { blocks: Object.fromEntries(Object.entries(blocks).sort()) }
        : {}),
      behaviors: [...new Set(behaviors)].sort(),
      retired: [
        ...new Map(retired.map((e) => [`${e.method} ${e.path}`, e])).values(),
      ].sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`)),
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
/**
 * The path every server of a contract serves the API under, when they agree
 * on one. `https://api.example.com/v1` and `/v1` both give `/v1`. Servers that
 * disagree, or a URL with a variable in its path, give nothing, rather than a
 * guess that would stop every request matching.
 */
export function basePathOf(document: OpenApiDocument | undefined): string | undefined {
  const served = servedUnder(document);
  return served === "" ? undefined : served;
}

/**
 * Where every server of a contract serves its API: a path, `""` for the root,
 * or nothing when the servers disagree, carry a variable, or are not declared.
 */
export function servedUnder(document: OpenApiDocument | undefined): string | undefined {
  const servers = document?.["servers"];
  if (!Array.isArray(servers) || servers.length === 0) return undefined;
  const paths = new Set<string>();
  for (const server of servers) {
    const url = isJsonObject(server) ? server["url"] : undefined;
    if (typeof url !== "string" || url.includes("{")) return undefined;
    let path: string;
    try {
      path = new URL(url, "http://base.invalid").pathname;
    } catch {
      return undefined;
    }
    paths.add(path.replace(/\/+$/, ""));
  }
  const [only] = [...paths];
  return paths.size === 1 && only !== undefined ? only : undefined;
}

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
    // Right after a release the last step runs from the released contract to
    // head, which is the same contract. It is still compared, so a breaking
    // edit made without naming a new contract is caught, but there is nothing
    // to serve: a caller on the current contract never reaches a program.
    if (label === currentLabel) return;
    const chained = chainContract(label, steps.slice(index));
    issues.push(...chained.issues);
    // Versioned in the server URL rather than the paths: this contract's
    // callers use a base path the current contract does not.
    const own = servedUnder(step.from);
    const current = servedUnder(steps.at(-1)?.to);
    contracts[label] =
      own !== undefined && current !== undefined && own !== current
        ? { ...chained.program, basePath: own }
        : chained.program;
  });

  const base = basePathOf(steps.at(-1)?.to);
  return {
    program: {
      irVersion: IR_VERSION,
      api,
      ...(base === undefined ? {} : { basePath: base }),
      current: currentDigest,
      currentLabel,
      contracts,
    },
    issues,
  };
}
