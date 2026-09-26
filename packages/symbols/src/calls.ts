/**
 * Which SDK method makes each HTTP call, when the call is made somewhere
 * else.
 *
 * Only some generators put the request in the method a consumer calls.
 * Stainless and Stripe do. Fern's `V2Client.chat` hands it to
 * `RawV2Client.chat`, Speakeasy's `Chat.complete` to a function
 * `chatComplete`, openapi-generator's `delete_identity` to a private
 * `_delete_identity_serialize`. So every function-like unit a release
 * declares is read for the calls it makes and the functions it calls, and a
 * unit inherits the calls of what it delegates to, followed as far as it
 * goes. Three kinds of delegation are followed, each narrow enough not to
 * wander: to a method of the same object (`self._x(...)`, `this.x(...)`), to
 * a function by its name (the same file's first), and to a method of the
 * same name on something else (`self._raw_client.chat(...)` inside `chat`).
 */
import type { CallSite } from "./types.ts";

export interface Request {
  verb: string;
  path: string;
  /** The operation's id, where the SDK records it beside the call. */
  operationId?: string;
}

export interface Unit {
  /** The class or Go receiver type; for a function, absent. */
  owner?: string;
  /**
   * `class` for a method a consumer can call, `object` for a function held in
   * an object or closure (openapi-generator's parameter creators),
   * `function` for a free function.
   */
  kind: "class" | "object" | "function";
  name: string;
  file: string;
  package?: string;
  requests: Request[];
  /** Methods of its own object it calls: `self.x(`, `this.x(`. */
  own: string[];
  /** Members of something else it calls: `.x(`. */
  member: string[];
  /** Free functions it calls: `x(`. */
  free: string[];
}

/** The names a body calls, sorted into own methods, other members and free functions. */
export function calledNames(
  body: string,
  self: RegExp,
): Pick<Unit, "own" | "member" | "free"> {
  const own = new Set<string>();
  const member = new Set<string>();
  const free = new Set<string>();
  for (const match of body.matchAll(
    /(\b[\w$]+\s*\.\s*)?([\w$]+)\s*(?:<[^<>()]*>)?\s*\(/g,
  )) {
    const name = match[2] as string;
    const receiver = match[1]?.replace(/[\s.]/g, "");
    if (receiver === undefined) free.add(name);
    else if (self.test(receiver)) own.add(name);
    else member.add(name);
  }
  // `a.b.c(` is a member call whose receiver the pattern above only sees the
  // last part of; any `.name(` is a member call.
  for (const match of body.matchAll(/\.\s*([\w$]+)\s*\(/g))
    member.add(match[1] as string);
  return { own: [...own], member: [...member], free: [...free] };
}

const dirOf = (file: string) => file.split("/").slice(0, -1).join("/");

/** The requests each method a consumer can call makes, directly or through what it calls. */
export function callSites(units: readonly Unit[]): CallSite[] {
  const byOwner = new Map<string, Unit[]>();
  const functions = new Map<string, Unit[]>();
  const byName = new Map<string, Unit[]>();
  for (const unit of units) {
    if (unit.owner !== undefined) {
      const at = `${unit.file}\u0000${unit.owner}`;
      byOwner.set(at, [...(byOwner.get(at) ?? []), unit]);
    }
    if (unit.kind === "function") {
      functions.set(unit.name, [...(functions.get(unit.name) ?? []), unit]);
    }
    byName.set(unit.name, [...(byName.get(unit.name) ?? []), unit]);
  }
  const reached = new Map<Unit, { requests: Request[]; through?: string }>();
  for (const unit of units) {
    if (unit.requests.length > 0) reached.set(unit, { requests: unit.requests });
  }
  // Delegation, followed until nothing new is reached, never further than a
  // handful of hops.
  for (let round = 0; round < 6; round += 1) {
    let grew = false;
    for (const unit of units) {
      if (reached.has(unit)) continue;
      const targets: Unit[] = [];
      const siblings = byOwner.get(`${unit.file}\u0000${unit.owner ?? ""}`) ?? [];
      for (const name of unit.own) {
        targets.push(...siblings.filter((each) => each.name === name && each !== unit));
      }
      for (const name of unit.free) {
        const candidates = functions.get(name) ?? [];
        const local = candidates.filter((each) => each.file === unit.file);
        targets.push(
          ...(local.length > 0 ? local : candidates.length === 1 ? candidates : []),
        );
      }
      if (unit.member.includes(unit.name)) {
        // The same name on something nearby: the same file (openapi-generator's
        // one `api.ts`), else the same directory (Fern's `raw_client.py`
        // beside `client.py`). Anything further, or more than a sync and
        // async pair or two, is some other resource's method of that name.
        const named = (byName.get(unit.name) ?? []).filter(
          (each) => each !== unit && each.kind !== "function" && reached.has(each),
        );
        const sameFile = named.filter((each) => each.file === unit.file);
        const sameDir = named.filter((each) => dirOf(each.file) === dirOf(unit.file));
        const near = sameFile.length > 0 ? sameFile : sameDir;
        if (near.length <= 4) targets.push(...near);
      }
      const requests: Request[] = [];
      const seen = new Set<string>();
      let through: string | undefined;
      for (const target of targets) {
        const found = reached.get(target);
        if (!found) continue;
        for (const request of found.requests) {
          const id = `${request.verb} ${request.path} ${request.operationId ?? ""}`;
          if (seen.has(id)) continue;
          seen.add(id);
          requests.push(request);
        }
        through ??= target.owner ? `${target.owner}.${target.name}` : target.name;
      }
      if (requests.length > 0) {
        reached.set(unit, { requests, ...(through ? { through } : {}) });
        grew = true;
      }
    }
    if (!grew) break;
  }
  const out: CallSite[] = [];
  for (const unit of units) {
    if (unit.kind !== "class" || unit.owner === undefined) continue;
    const found = reached.get(unit);
    if (!found) continue;
    const seen = new Set<string>();
    for (const request of found.requests) {
      const id = `${request.verb} ${request.path} ${request.operationId ?? ""}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        type: unit.owner,
        method: unit.name,
        verb: request.verb,
        path: request.path,
        ...(request.operationId ? { operationId: request.operationId } : {}),
        ...(found.through ? { through: found.through } : {}),
        ...(unit.package !== undefined ? { package: unit.package } : {}),
        file: unit.file,
      });
    }
  }
  return out;
}

/**
 * Pairs each path in a body with the HTTP verb nearest it, and the
 * operation id the body records, where it records exactly one.
 */
export function requestsIn(
  paths: readonly { at: number; path: string }[],
  verbs: readonly { at: number; verb: string }[],
  operationIds: readonly string[],
  // openapi-generator's axios client builds the path a few hundred
  // characters before the options that carry its method.
  reach = 1500,
): Request[] {
  if (verbs.length === 0) return [];
  const ids = [...new Set(operationIds)];
  const out: Request[] = [];
  for (const { at, path } of paths) {
    let best: { at: number; verb: string } | undefined;
    for (const verb of verbs) {
      if (!best || Math.abs(verb.at - at) < Math.abs(best.at - at)) best = verb;
    }
    if (!best || Math.abs(best.at - at) > reach) continue;
    out.push({
      verb: best.verb,
      path,
      ...(ids.length === 1 ? { operationId: ids[0] as string } : {}),
    });
  }
  return out;
}
