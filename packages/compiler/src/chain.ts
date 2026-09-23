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
import { type OpenApiDocument, operationsOf } from "@invariant-app/contract";
import type {
  Change,
  CompiledProgram,
  ContractProgram,
  EnvelopeProgram,
  IdentityStrategy,
  Instr,
  ParamCodec,
  RouteRule,
  SiteProgram,
} from "@invariant-app/ir";
import {
  BRAND,
  formatPointer,
  isJsonObject,
  minRuntimeFor,
  PRODUCT_VERSION,
  PROGRAM_VERSION,
  parsePointer,
  siteKey,
} from "@invariant-app/ir";
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

  // Each status the provider answers with runs the later step's work for it,
  // then the earlier step's for the status the later step answered with,
  // each found as the runtime finds it: the exact status, then its class,
  // then `default`. A later step that answers an old caller another status
  // hands the earlier step that one.
  const rules = later.status ?? [];
  if (earlier.response || later.response || rules.length > 0) {
    const handed = (status: string): string => {
      let current = status;
      for (const rule of rules)
        if (String(rule.from) === current) current = String(rule.to);
      return current;
    };
    const response: Record<string, Instr[]> = {};
    const statuses = new Set([
      ...Object.keys(earlier.response ?? {}),
      ...Object.keys(later.response ?? {}),
      ...rules.map((rule) => String(rule.from)),
    ]);
    for (const status of [...statuses].sort()) {
      response[status] = [
        ...(lookup(later.response, status) ?? []),
        ...(lookup(earlier.response, handed(status)) ?? []),
      ];
    }
    if (Object.values(response).some((list) => list.length > 0)) out.response = response;
  }
  // Applied in turn to the provider's status: the later step's rules first,
  // as a response undoes the later step first.
  const status = [...rules, ...(earlier.status ?? [])];
  if (status.length > 0) out.status = status;

  return out;
}

/**
 * The work a site's response map holds for a status, found as the runtime
 * finds it: the key itself, then, for an exact status, its class, and then
 * `default`. Classes are compared without regard to case, as OpenAPI's `2XX`
 * and the runtime's `2xx` are the same key.
 */
function lookup(
  response: Record<string, Instr[]> | undefined,
  status: string,
): Instr[] | undefined {
  if (!response) return undefined;
  const wanted = /^\d{3}$/.test(status)
    ? [status, `${status[0]}xx`, "default"]
    : /^\d[xX]{2}$/.test(status)
      ? [status.toLowerCase(), "default"]
      : [status];
  const byKey = new Map(
    Object.entries(response).map(([key, list]) => [key.toLowerCase(), list]),
  );
  for (const key of wanted) {
    const found = byKey.get(key);
    if (found !== undefined) return found;
  }
  return undefined;
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

/** One step, projected once, with its work filed where its calls arrive by the end of the chain. */
interface Projected {
  issues: ProjectionIssue[];
  sites: Map<string, SiteProgram>;
  outbound: Record<string, Instr[]>;
  blocks: Record<string, Instr[]>;
  behaviors: string[];
  retired: ContractProgram["retired"];
}

/**
 * Every step projected once. Each step's program is the same whichever older
 * contract it serves: its sites are filed under the endpoints requests reach
 * after every later route change, which is where they are served from, and
 * nothing about it depends on how far back the caller started.
 */
function projectAll(steps: readonly ContractStep[]): Projected[] {
  const laterRoutes: RouteMapping[][] = steps.map((step) => routeMappings(step.changes));
  return steps.map((step, index) => {
    const projected = projectStep(step.label, step.from, step.changes, step.to);
    const after = laterRoutes.slice(index + 1);
    const sites = new Map<string, SiteProgram>();
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
    return {
      issues: projected.issues,
      sites,
      outbound: projected.program.outbound ?? {},
      blocks: projected.program.blocks ?? {},
      behaviors: projected.program.behaviors,
      // A retired endpoint is named as it stood in the contract that retired
      // it, which is also the path a request reaches after the earlier steps'
      // route rewrites. Later steps never touch it.
      retired: projected.program.retired,
    };
  });
}

/** What every contract from `index` onward shares besides its sites. */
function contractFrame(
  label: string,
  steps: readonly ContractStep[],
  projected: readonly Projected[],
  index: number,
): Omit<ContractProgram, "sites"> {
  const laterRoutes = steps.slice(index).map((step) => routeMappings(step.changes));
  const routes: RouteRule[] = [];
  // One rewrite per endpoint, computed by walking each endpoint of the
  // historical contract all the way to where it lives now. A request is
  // rewritten once, however many steps it has to travel.
  const historical = steps[index]?.from;
  if (historical) {
    for (const operation of operationsOf(historical)) {
      if (operation.webhook) continue;
      const target = mapThrough(laterRoutes, operation.method, operation.path);
      if (target.method === operation.method && target.path === operation.path) continue;
      routes.push({
        from: { method: operation.method, path: operation.path },
        to: target,
        c: routeChangeFor(steps.slice(index), operation.method, operation.path) ?? "",
      });
    }
  }
  const later = projected.slice(index);
  const retired = later.flatMap((step) => step.retired);
  return {
    label,
    routes: routes.sort((a, b) =>
      siteKey(a.from.method, a.from.path).localeCompare(
        siteKey(b.from.method, b.from.path),
      ),
    ),
    behaviors: [...new Set(later.flatMap((step) => step.behaviors))].sort(),
    retired: [...new Map(retired.map((e) => [`${e.method} ${e.path}`, e])).values()].sort(
      (a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`),
    ),
  };
}

/**
 * What marks a block as a link in a chain: one contract's work, kept for the
 * contracts older than it, as opposed to a schema's blocks.
 */
const LINK = ">";

/**
 * The program with every link in its chains written out where it is called,
 * as it would read if each contract carried every later step itself. For
 * reading a contract's work in one list, and for holding the linked program
 * to the same instructions. Blocks of schemas that contain themselves are
 * left as they are, since those recurse.
 */
export function expandChains(program: CompiledProgram): CompiledProgram {
  const blocks = program.blocks ?? {};
  const expand = (list: readonly Instr[]): Instr[] =>
    list.flatMap((instr) => {
      if (instr.k === "call" && instr.block.includes(LINK)) {
        return expand(blocks[instr.block] ?? []);
      }
      if (instr.k === "within" || instr.k === "has" || instr.k === "is") {
        return [{ ...instr, block: expand(instr.block) }];
      }
      if (instr.k === "switch") {
        return [
          {
            ...instr,
            cases: Object.fromEntries(
              Object.entries(instr.cases).map(([key, block]) => [key, expand(block)]),
            ),
          },
        ];
      }
      return [instr];
    });
  const contracts = Object.fromEntries(
    Object.entries(program.contracts).map(([label, contract]) => {
      const sites = Object.fromEntries(
        Object.entries(contract.sites).map(([key, site]) => {
          const out: SiteProgram = { ...site };
          if (site.request) out.request = expand(site.request);
          if (site.envelope)
            out.envelope = { ...site.envelope, instrs: expand(site.envelope.instrs) };
          if (site.response) {
            out.response = Object.fromEntries(
              Object.entries(site.response).map(([status, list]) => [
                status,
                expand(list),
              ]),
            );
          }
          return [key, out];
        }),
      );
      const outbound = contract.outbound
        ? Object.fromEntries(
            Object.entries(contract.outbound).map(([event, list]) => [
              event,
              expand(list),
            ]),
          )
        : undefined;
      return [label, { ...contract, sites, ...(outbound ? { outbound } : {}) }];
    }),
  );
  const kept = Object.entries(blocks).filter(([name]) => !name.includes(LINK));
  const { blocks: _, ...rest } = program;
  return {
    ...rest,
    contracts,
    ...(kept.length > 0 ? { blocks: Object.fromEntries(kept) } : {}),
  };
}

/** A contract's sites and payloads, as the next older contract builds on them. */
interface Link {
  label: string;
  sites: Map<string, SiteProgram>;
  outbound: Record<string, Instr[]>;
}

/**
 * `link`'s work, each list of it replaced by one `call` to a block holding
 * it. The older contract runs its own step and then this, so it stores one
 * instruction where it used to store every later step again, and a chain of
 * any length costs what its steps cost. A list of one is kept as it is: a
 * block and a call to it would be larger than the instruction.
 *
 * Blocks are named for what they hold, so sites doing the same work share one.
 * A schema every operation returns, as Stripe's shared objects are, makes that
 * most of them, and since the calls into the next contract are shared the same
 * way, the sharing carries down the whole chain.
 */
function called(link: Link, blocks: Record<string, Instr[]>): Link {
  const named = new Map<string, string>();
  const store = (list: readonly Instr[] | undefined): Instr[] | undefined => {
    if (list === undefined || list.length <= 1) return list as Instr[] | undefined;
    const text = JSON.stringify(list);
    let name = named.get(text);
    if (name === undefined) {
      name = `${link.label}${LINK}${named.size}`;
      named.set(text, name);
      blocks[name] = [...list];
    }
    return [{ k: "call", block: name, c: (list[0] as Instr).c }];
  };
  const sites = new Map<string, SiteProgram>();
  for (const key of [...link.sites.keys()].sort()) {
    const site = link.sites.get(key) as SiteProgram;
    const out: SiteProgram = { ...site };
    const request = store(site.request);
    if (request) out.request = request;
    if (site.envelope) {
      out.envelope = { ...site.envelope, instrs: store(site.envelope.instrs) ?? [] };
    }
    if (site.response) {
      out.response = Object.fromEntries(
        Object.entries(site.response)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([status, list]) => [status, store(list) ?? []]),
      );
    }
    sites.set(key, out);
  }
  const outbound = Object.fromEntries(
    Object.entries(link.outbound)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([event, list]) => [event, store(list) ?? []]),
  );
  return { label: link.label, sites, outbound };
}

/** One step's work followed by everything after it: a request forward, a payload back. */
function joined(own: Projected, later: Link | undefined, label: string): Link {
  const sites = new Map<string, SiteProgram>();
  const keys = new Set([...own.sites.keys(), ...(later?.sites.keys() ?? [])]);
  for (const key of [...keys].sort()) {
    const earlier = own.sites.get(key);
    const after = later?.sites.get(key);
    sites.set(
      key,
      earlier && after ? mergeSite(earlier, after) : ((earlier ?? after) as SiteProgram),
    );
  }
  const outbound: Record<string, Instr[]> = {};
  const events = new Set([
    ...Object.keys(own.outbound),
    ...Object.keys(later?.outbound ?? {}),
  ]);
  for (const event of [...events].sort()) {
    // What the provider sends moves backward through time, as a response
    // does: the later steps are undone first.
    outbound[event] = [...(later?.outbound[event] ?? []), ...(own.outbound[event] ?? [])];
  }
  return { label, sites, outbound };
}

function contractOf(frame: Omit<ContractProgram, "sites">, link: Link): ContractProgram {
  const sites = Object.fromEntries(
    [...link.sites.entries()].filter(
      ([, site]) => site.request || site.envelope || site.response || site.status,
    ),
  );
  const outbound = Object.entries(link.outbound).filter(([, list]) => list.length > 0);
  return {
    ...frame,
    sites,
    ...(outbound.length > 0 ? { outbound: Object.fromEntries(outbound) } : {}),
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

/**
 * Compiles every historical contract still served into one program.
 *
 * `steps` runs oldest first. The program for contract N is step N's work and
 * then contract N+1's, reached through a block, so a caller on any contract
 * gets one pass straight to current and the program grows with the number of
 * steps rather than with its square. Each step is projected once.
 */
export function chainProgram(
  api: string,
  currentLabel: string,
  currentDigest: string,
  steps: readonly ContractStep[],
  options: {
    identity?: readonly IdentityStrategy[];
    /** What the provider declared about each contract's end, by label. */
    retirement?: ReadonlyMap<string, { deprecated?: string; sunset?: string }>;
  } = {},
): ChainResult {
  const projected = projectAll(steps);
  const issues = projected.flatMap((step) => step.issues);
  const contracts: Record<string, ContractProgram> = {};
  // Every step's own shared blocks, and the blocks each contract's work is
  // kept in for the contracts older than it. Each is named after the step or
  // contract that owns it, so none collide.
  const blocks: Record<string, Instr[]> = {};
  for (const step of projected) Object.assign(blocks, step.blocks);

  // Newest first, so each contract is its own step and then the next.
  let tail: Link | undefined;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index] as ContractStep;
    const label = step.parent;
    const own = joined(projected[index] as Projected, tail, label);
    // Kept in blocks when an older contract will call it, and then this
    // contract calls the same blocks rather than holding a second copy.
    const link = index > 0 ? called(own, blocks) : own;
    tail = link;
    // Right after a release the last step runs from the released contract to
    // head, which is the same contract. It is still compared, so a breaking
    // edit made without naming a new contract is caught, but there is nothing
    // to serve: a caller on the current contract never reaches a program.
    if (label === currentLabel) continue;
    const program = contractOf(contractFrame(label, steps, projected, index), link);
    // Versioned in the server URL rather than the paths: this contract's
    // callers use a base path the current contract does not.
    const served = servedUnder(step.from);
    const current = servedUnder(steps.at(-1)?.to);
    const ending = options.retirement?.get(label);
    contracts[label] = {
      ...program,
      ...(served !== undefined && current !== undefined && served !== current
        ? { basePath: served }
        : {}),
      ...(ending?.deprecated === undefined ? {} : { deprecated: ending.deprecated }),
      ...(ending?.sunset === undefined ? {} : { sunset: ending.sunset }),
    };
  }

  const base = basePathOf(steps.at(-1)?.to);
  const used = Object.fromEntries(Object.entries(blocks).sort());
  const body = {
    api,
    ...(base === undefined ? {} : { basePath: base }),
    current: currentDigest,
    currentLabel,
    contracts: Object.fromEntries(Object.entries(contracts).sort()),
    ...(Object.keys(used).length > 0 ? { blocks: used } : {}),
    ...(options.identity ? { identity: [...options.identity] } : {}),
  };
  return {
    program: {
      irVersion: PROGRAM_VERSION,
      compiledBy: `${BRAND.scope}/compiler@${PRODUCT_VERSION}`,
      minRuntime: minRuntimeFor({ irVersion: PROGRAM_VERSION, ...body }),
      ...body,
    },
    issues,
  };
}
