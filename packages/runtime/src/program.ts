/**
 * Decoding a compiled program.
 *
 * The decoder is hand-written and strict on purpose. This is the boundary where
 * a build artifact becomes something that runs against live traffic, so an
 * unrecognised instruction, an unexpected field or a malformed path is a
 * refusal to load rather than something to skip over at request time.
 */

import type { XmlBody, XmlNode } from "@invariant-app/ir";
import type { StringCase, TimeFormat } from "./codecs.ts";
import {
  codecKey,
  type DecodedEnvelope,
  type ParamCodec,
  type ParamLocation,
  type ParamScalar,
  type ParamStyle,
  type ParamType,
} from "./envelope.ts";
import type { DecodedForm, FormField, FormType } from "./form.ts";
import {
  type CompiledInstr,
  type JsonKind,
  type ScalarType,
  touchedPaths,
} from "./interpreter.ts";
import type { Json } from "./json.ts";
import { isUnsafeKey, isWildcard } from "./pointer.ts";
import { VERSION } from "./version.ts";
import { isNcName } from "./xml.ts";

export class ProgramError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramError";
  }
}

export interface DecodedSite {
  request: CompiledInstr[];
  /** Instructions over the whole request, where a Change reaches a parameter. */
  envelope?: DecodedEnvelope;
  /** The site's path template, split on `/`, as the contract writes it. */
  template: string[];
  /** How the request body is written when it arrives form-encoded. */
  form?: DecodedForm;
  /** How each body is written when it arrives as XML: the request's, and each status's. */
  xml?: DecodedXml;
  /** Keyed by the status the provider answered with. */
  response: Map<string, CompiledInstr[]>;
  /**
   * Success statuses an old caller is answered as another, applied in turn
   * to the status the provider answered with. Empty for most sites.
   */
  status: StatusRule[];
  /** True when any instruction re-encodes a number. */
  numeric: boolean;
}

/**
 * The provider's `from` answered as `to`, with no body where `empty` says
 * the caller's contract promised none.
 */
export interface StatusRule {
  from: number;
  to: number;
  empty: boolean;
  c: string;
}

export interface DecodedXml {
  request?: XmlBody;
  response: Map<string, XmlBody>;
}

/** Success statuses whose answer never carries a body, whatever a rule says. */
export const EMPTY_STATUSES: ReadonlySet<number> = new Set([204, 205]);

function decodeStatusRules(raw: unknown, where: string): StatusRule[] {
  const list = array(raw, where);
  if (list.length === 0) throw new ProgramError(`${where} must name at least one rule`);
  return list.map((entry, index) => {
    const at = `${where}[${index}]`;
    const value = object(entry, at);
    expectKeys(value, ["from", "to", "empty", "c"], at);
    const status = (name: "from" | "to"): number => {
      const code = value[name];
      if (
        typeof code !== "number" ||
        !Number.isInteger(code) ||
        code < 200 ||
        code > 299
      ) {
        throw new ProgramError(`${at}.${name} must be a success status, 200 to 299`);
      }
      return code;
    };
    const from = status("from");
    const to = status("to");
    if (from === to) throw new ProgramError(`${at} answers ${from} as itself`);
    const empty = onlyTrue(value["empty"], `${at}.empty`);
    // A 204 or a 205 never carries a body, so a rule that would send one
    // with it is a program nobody should have compiled.
    if (EMPTY_STATUSES.has(to) && !empty) {
      throw new ProgramError(
        `${at} answers ${to}, which carries no body, so it must be empty`,
      );
    }
    return { from, to, empty, c: string(value["c"], `${at}.c`) };
  });
}

const HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

export interface DecodedRoute {
  method: string;
  /**
   * The method the canonical handler takes, which a route can change: a
   * search that moved from `GET` with a query string to `POST` with a body.
   */
  toMethod: string;
  /** Template segments; `{name}` matches one segment. */
  from: string[];
  to: string[];
  changeId: string;
}

export interface DecodedContract {
  label: string;
  /** Where this contract's callers send requests, when it is not the current base path. */
  basePath?: string;
  routes: DecodedRoute[];
  sites: Map<string, DecodedSite>;
  /**
   * What the provider sends of its own accord, keyed `method webhook:<name>`
   * or `method callback:<operation>/<callback>`, with whether any of it
   * re-encodes a number.
   */
  outbound: Map<string, { instrs: CompiledInstr[]; numeric: boolean }>;
  behaviors: string[];
  /**
   * When this contract was deprecated and when it stops being served, as the
   * provider declared them: a date each, sent to its callers on every answer
   * as `Deprecation` (RFC 9745) and `Sunset` (RFC 8594), so a caller learns
   * from the API itself and not only from a changelog it may never read.
   */
  deprecated?: string;
  sunset?: string;
  /** Endpoints this contract had that the current one does not. */
  retired: {
    method: string;
    path: string;
    guidance: string | undefined;
    c: string;
    /** Refused without reaching the provider; otherwise passed on. */
    refuse: boolean;
  }[];
}

/** How a request says which contract it expects, tried in order. */
export type IdentityStrategy =
  | { kind: "header"; name: string }
  | { kind: "urlPrefix"; map: Record<string, string> }
  | { kind: "principal" }
  | { kind: "default"; label: string };

export interface DecodedProgram {
  api: string;
  current: string;
  currentLabel: string;
  contracts: Map<string, DecodedContract>;
  /** The path the API is served under, or empty when it is served at the root. */
  basePath: string;
  /** How requests name their contract, as `invariant.yaml` declares it. */
  identity?: IdentityStrategy[];
}

/** The identity strategies a program declares, checked as strictly as the rest of it. */
function decodeIdentity(raw: unknown): IdentityStrategy[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ProgramError("program.identity must list at least one strategy");
  }
  return raw.map((entry, index): IdentityStrategy => {
    const where = `program.identity[${index}]`;
    const value = object(entry, where);
    switch (value["kind"]) {
      case "header":
        expectKeys(value, ["kind", "name"], where);
        // Header names are case-insensitive, and compared lower-cased.
        return {
          kind: "header",
          name: string(value["name"], `${where}.name`).toLowerCase(),
        };
      case "urlPrefix": {
        expectKeys(value, ["kind", "map"], where);
        const map = object(value["map"], `${where}.map`);
        return {
          kind: "urlPrefix",
          map: Object.fromEntries(
            Object.entries(map).map(([prefix, label]) => [
              prefix,
              string(label, `${where}.map["${prefix}"]`),
            ]),
          ),
        };
      }
      case "principal":
        expectKeys(value, ["kind"], where);
        return { kind: "principal" };
      case "default":
        expectKeys(value, ["kind", "label"], where);
        return { kind: "default", label: string(value["label"], `${where}.label`) };
      default:
        throw new ProgramError(`${where}.kind is not a strategy this runtime knows`);
    }
  });
}

const SCALARS = new Set<ScalarType>(["string", "integer", "number", "boolean"]);
const TIME_FORMATS = new Set<TimeFormat>(["epoch-s", "epoch-ms", "rfc3339"]);
const STRING_CASES = new Set<StringCase>([
  "snake",
  "screaming",
  "kebab",
  "camel",
  "pascal",
]);

function object(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProgramError(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, where: string): string {
  if (typeof value !== "string") throw new ProgramError(`${where} must be a string`);
  return value;
}

function array(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new ProgramError(`${where} must be an array`);
  return value;
}

function expectKeys(
  value: Record<string, unknown>,
  allowed: string[],
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ProgramError(`${where} has an unexpected field "${key}"`);
    }
  }
}

const POINTER_SEGMENT = /^([^/~]|~[01])*$/;

function segmentsOf(pointer: string, where: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new ProgramError(`${where} must be a JSON Pointer, got "${pointer}"`);
  }
  return pointer
    .slice(1)
    .split("/")
    .map((raw) => {
      if (raw !== "*" && !POINTER_SEGMENT.test(raw)) {
        throw new ProgramError(`${where} has an invalid segment "${raw}"`);
      }
      const decoded = isWildcard(raw) ? raw : raw.replace(/~1/g, "/").replace(/~0/g, "~");
      if (isUnsafeKey(decoded)) {
        throw new ProgramError(`${where} may not name "${decoded}"`);
      }
      return decoded;
    });
}

/** The wildcards in a path, in order; a move has to take list to list and map to map. */
function wildcardsOf(segments: readonly string[]): string {
  return segments.filter(isWildcard).join(",");
}

/**
 * How deeply blocks may nest. A union inside a union inside a list is three;
 * nothing a compiler emits needs more, and each level multiplies how many
 * places one instruction can reach.
 */
const MAX_BLOCK_DEPTH = 8;

/** A contract's named blocks, each filled in once all of them are decoded. */
type Blocks = ReadonlyMap<string, { instrs: CompiledInstr[] }>;

const NO_BLOCKS: Blocks = new Map();

const JSON_KINDS = new Set<JsonKind>([
  "object",
  "array",
  "string",
  "number",
  "boolean",
  "null",
]);

function decodeBlock(
  raw: unknown,
  where: string,
  depth: number,
  blocks: Blocks,
  descended: boolean,
): CompiledInstr[] {
  if (depth > MAX_BLOCK_DEPTH) {
    throw new ProgramError(`${where} nests blocks more than ${MAX_BLOCK_DEPTH} deep`);
  }
  return (array(raw, where) as unknown[]).map((instr, index) =>
    decodeInstr(instr, `${where}[${index}]`, depth, blocks, descended),
  );
}

/**
 * `descended` is whether the instruction runs on a value a `within` went down
 * to, the only place one may write the value itself: an object replaced by
 * its id, or a list item removed. A named block may be called anywhere, so it
 * is allowed there and refused at run time where it stands on a whole body.
 */
function decodeInstr(
  raw: unknown,
  where: string,
  depth = 0,
  blocks: Blocks = NO_BLOCKS,
  descended = false,
): CompiledInstr {
  const itself = (path: readonly string[], field: string) => {
    if (path.length === 0 && !descended) {
      throw new ProgramError(
        `${where}.${field} writes a whole body, which only a value inside one can be`,
      );
    }
  };
  const value = object(raw, where);
  const kind = string(value["k"], `${where}.k`);
  const changeId = string(value["c"], `${where}.c`);

  switch (kind) {
    case "within": {
      expectKeys(value, ["k", "path", "block", "c"], where);
      const path = segmentsOf(string(value["path"], `${where}.path`), `${where}.path`);
      return {
        k: "within",
        path,
        block: decodeBlock(
          value["block"],
          `${where}.block`,
          depth + 1,
          blocks,
          descended || path.length > 0,
        ),
        c: changeId,
      };
    }
    case "call": {
      expectKeys(value, ["k", "block", "c"], where);
      const name = string(value["block"], `${where}.block`);
      const target = blocks.get(name);
      if (!target) throw new ProgramError(`${where} calls "${name}", which is no block`);
      return { k: "call", name, target, c: changeId };
    }
    case "switch":
    case "has":
    case "is": {
      const path = segmentsOf(string(value["path"], `${where}.path`), `${where}.path`);
      // A key is one value, read at one place.
      if (path.some(isWildcard)) {
        throw new ProgramError(`${where}.path reads a key through a wildcard`);
      }
      if (kind === "has") {
        expectKeys(value, ["k", "path", "block", "absent", "c"], where);
        if (path.length === 0) throw new ProgramError(`${where}.path names nothing`);
        return {
          k: "has",
          path,
          block: decodeBlock(
            value["block"],
            `${where}.block`,
            depth + 1,
            blocks,
            descended,
          ),
          ...(onlyTrue(value["absent"], `${where}.absent`) ? { absent: true } : {}),
          c: changeId,
        };
      }
      if (kind === "is") {
        expectKeys(value, ["k", "path", "type", "block", "c"], where);
        const type = value["type"];
        if (typeof type !== "string" || !JSON_KINDS.has(type as JsonKind)) {
          throw new ProgramError(`${where}.type is not a JSON type`);
        }
        return {
          k: "is",
          path,
          type: type as JsonKind,
          block: decodeBlock(
            value["block"],
            `${where}.block`,
            depth + 1,
            blocks,
            descended,
          ),
          c: changeId,
        };
      }
      expectKeys(value, ["k", "path", "cases", "c"], where);
      const cases = new Map<string, CompiledInstr[]>();
      for (const [key, block] of Object.entries(
        object(value["cases"], `${where}.cases`),
      )) {
        cases.set(
          key,
          decodeBlock(block, `${where}.cases.${key}`, depth + 1, blocks, descended),
        );
      }
      return { k: "switch", path, cases, c: changeId };
    }
    case "move": {
      expectKeys(value, ["k", "from", "to", "c"], where);
      const from = segmentsOf(string(value["from"], `${where}.from`), `${where}.from`);
      const to = segmentsOf(string(value["to"], `${where}.to`), `${where}.to`);
      if (wildcardsOf(from) !== wildcardsOf(to)) {
        // Each wildcard on the left has to line up with one of the same kind
        // on the right, or there is no telling which element a value belongs to.
        throw new ProgramError(
          `${where} moves between paths whose wildcards do not line up`,
        );
      }
      if (from.length === 0) {
        throw new ProgramError(`${where} cannot move the document root`);
      }
      // Moving onto the value itself replaces it with one of its own fields.
      itself(to, "to");
      return { k: "move", from, to, c: changeId };
    }
    case "scale": {
      expectKeys(value, ["k", "path", "exp", "c"], where);
      const exp = value["exp"];
      if (typeof exp !== "number" || !Number.isInteger(exp) || exp < -9 || exp > 9) {
        throw new ProgramError(`${where}.exp must be an integer between -9 and 9`);
      }
      return {
        k: "scale",
        path: segmentsOf(string(value["path"], `${where}.path`), `${where}.path`),
        exp,
        c: changeId,
      };
    }
    case "enum": {
      expectKeys(value, ["k", "path", "map", "lenient", "folded", "c"], where);
      const lenient = value["lenient"];
      if (lenient !== undefined && typeof lenient !== "boolean") {
        throw new ProgramError(`${where}.lenient must be a boolean`);
      }
      const map = object(value["map"], `${where}.map`);
      const decoded: Record<string, string> = {};
      for (const [from, to] of Object.entries(map)) {
        decoded[from] = string(to, `${where}.map.${from}`);
      }
      const rawFolded = value["folded"];
      let folded: string[] | undefined;
      if (rawFolded !== undefined) {
        folded = array(rawFolded, `${where}.folded`).map((entry, index) =>
          string(entry, `${where}.folded[${index}]`),
        );
        // A fold names a value the map translates. One that is not in the map
        // would claim a substitution that can never happen, so the program is
        // refused rather than trusted to be harmless.
        for (const key of folded) {
          if (!Object.hasOwn(decoded, key)) {
            throw new ProgramError(
              `${where}.folded names "${key}", which the map does not`,
            );
          }
        }
      }
      return {
        k: "enum",
        path: segmentsOf(string(value["path"], `${where}.path`), `${where}.path`),
        map: decoded,
        ...(lenient === true ? { lenient: true } : {}),
        ...(folded !== undefined && folded.length > 0 ? { folded } : {}),
        c: changeId,
      };
    }
    case "cast": {
      expectKeys(value, ["k", "path", "to", "c"], where);
      const to = string(value["to"], `${where}.to`) as ScalarType;
      if (!SCALARS.has(to)) throw new ProgramError(`${where}.to is not a scalar type`);
      return {
        k: "cast",
        path: segmentsOf(string(value["path"], `${where}.path`), `${where}.path`),
        to,
        c: changeId,
      };
    }
    case "time": {
      expectKeys(value, ["k", "path", "from", "to", "truncate", "c"], where);
      const from = string(value["from"], `${where}.from`) as TimeFormat;
      const to = string(value["to"], `${where}.to`) as TimeFormat;
      if (!TIME_FORMATS.has(from) || !TIME_FORMATS.has(to) || from === to) {
        throw new ProgramError(`${where} must name two different time formats`);
      }
      return {
        k: "time",
        path: segmentsOf(string(value["path"], `${where}.path`), `${where}.path`),
        from,
        to,
        ...(onlyTrue(value["truncate"], `${where}.truncate`) ? { truncate: true } : {}),
        c: changeId,
      };
    }
    case "case": {
      expectKeys(value, ["k", "path", "from", "to", "c"], where);
      const from = string(value["from"], `${where}.from`) as StringCase;
      const to = string(value["to"], `${where}.to`) as StringCase;
      if (!STRING_CASES.has(from) || !STRING_CASES.has(to) || from === to) {
        throw new ProgramError(`${where} must name two different cases`);
      }
      return {
        k: "case",
        path: segmentsOf(string(value["path"], `${where}.path`), `${where}.path`),
        from,
        to,
        c: changeId,
      };
    }
    case "wrap": {
      expectKeys(value, ["k", "path", "c"], where);
      return {
        k: "wrap",
        path: segmentsOf(string(value["path"], `${where}.path`), `${where}.path`),
        c: changeId,
      };
    }
    case "unwrap": {
      expectKeys(value, ["k", "path", "first", "c"], where);
      return {
        k: "unwrap",
        path: segmentsOf(string(value["path"], `${where}.path`), `${where}.path`),
        ...(onlyTrue(value["first"], `${where}.first`) ? { first: true } : {}),
        c: changeId,
      };
    }
    case "drop": {
      expectKeys(value, ["k", "path", "values", "c"], where);
      const values = value["values"];
      if (
        !Array.isArray(values) ||
        values.length === 0 ||
        !values.every((entry) => typeof entry === "string")
      ) {
        throw new ProgramError(`${where}.values must be a list of strings`);
      }
      return {
        k: "drop",
        path: segmentsOf(string(value["path"], `${where}.path`), `${where}.path`),
        values: new Set(values as string[]),
        c: changeId,
      };
    }
    case "set": {
      expectKeys(value, ["k", "path", "value", "ifAbsent", "ifNull", "c"], where);
      if (typeof value["ifAbsent"] !== "boolean") {
        throw new ProgramError(`${where}.ifAbsent must be a boolean`);
      }
      const path = segmentsOf(string(value["path"], `${where}.path`), `${where}.path`);
      itself(path, "path");
      if (path.length === 0 && (value["ifAbsent"] || value["ifNull"] !== undefined)) {
        // The value is there, or nothing would be running on it.
        throw new ProgramError(
          `${where} replaces the value itself, which is never absent`,
        );
      }
      return {
        k: "set",
        path,
        value: value["value"] as Json,
        ifAbsent: value["ifAbsent"],
        ...(onlyTrue(value["ifNull"], `${where}.ifNull`) ? { ifNull: true } : {}),
        c: changeId,
      };
    }
    case "del": {
      expectKeys(value, ["k", "path", "ifNull", "c"], where);
      const path = segmentsOf(string(value["path"], `${where}.path`), `${where}.path`);
      itself(path, "path");
      if (path.length === 0 && value["ifNull"] !== undefined) {
        throw new ProgramError(`${where} removes the value itself, which is never null`);
      }
      return {
        k: "del",
        path,
        ...(onlyTrue(value["ifNull"], `${where}.ifNull`) ? { ifNull: true } : {}),
        c: changeId,
      };
    }
    default:
      throw new ProgramError(`${where} has an unknown instruction "${kind}"`);
  }
}

function needsExactNumbers(
  instrs: readonly CompiledInstr[],
  entered: Set<string> = new Set(),
): boolean {
  return instrs.some((instr) => {
    if (instr.k === "scale" || instr.k === "cast" || instr.k === "time") return true;
    if (instr.k === "within" || instr.k === "has" || instr.k === "is") {
      return needsExactNumbers(instr.block, entered);
    }
    if (instr.k === "switch") {
      return [...instr.cases.values()].some((block) => needsExactNumbers(block, entered));
    }
    if (instr.k === "call") {
      if (entered.has(instr.name)) return false;
      entered.add(instr.name);
      return needsExactNumbers(instr.target.instrs, entered);
    }
    return false;
  });
}

/**
 * Refuses blocks that could call one another forever on one value.
 *
 * A call runs where it stands; only a `within` with a path moves to a value
 * inside. So a cycle of calls none of which sits under such a `within` would
 * run on the same value without end, and a program containing one is refused
 * rather than trusted. Every cycle that remains descends on each turn, and so
 * ends where the value does.
 */
function refuseStandingCycles(blocks: Blocks, where: string): void {
  /** The blocks a list calls without first descending into the value. */
  const standing = (instrs: readonly CompiledInstr[], into: Set<string>): void => {
    for (const instr of instrs) {
      if (instr.k === "call") into.add(instr.name);
      else if (instr.k === "within" && instr.path.length === 0)
        standing(instr.block, into);
      else if (instr.k === "has" || instr.k === "is") standing(instr.block, into);
      else if (instr.k === "switch") {
        for (const block of instr.cases.values()) standing(block, into);
      }
    }
  };
  const edges = new Map<string, Set<string>>();
  for (const [name, holder] of blocks) {
    const into = new Set<string>();
    standing(holder.instrs, into);
    edges.set(name, into);
  }
  const state = new Map<string, "open" | "done">();
  const visit = (name: string, trail: string[]): void => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "open") {
      throw new ProgramError(
        `${where} call one another without descending: ${[...trail, name].join(" -> ")}`,
      );
    }
    state.set(name, "open");
    for (const next of edges.get(name) ?? []) visit(next, [...trail, name]);
    state.set(name, "done");
  };
  for (const name of blocks.keys()) visit(name, []);
}

/**
 * Named blocks, able to call one another and any in `shared`, the program's
 * own. Every name is declared first, so a block can call any of them, itself
 * included. A name may not be declared twice, here and there alike.
 */
function decodeBlocks(raw: unknown, where: string, shared: Blocks = NO_BLOCKS): Blocks {
  if (raw === undefined) return shared;
  const entries = Object.entries(object(raw, where));
  const blocks = new Map<string, { instrs: CompiledInstr[] }>(shared);
  for (const [name] of entries) {
    if (name.length === 0 || name.length > 256) {
      throw new ProgramError(`${where} has a block name that is empty or too long`);
    }
    if (shared.has(name)) {
      throw new ProgramError(`${where} declares ${name}, which the program already does`);
    }
    blocks.set(name, { instrs: [] });
  }
  for (const [name, list] of entries) {
    (blocks.get(name) as { instrs: CompiledInstr[] }).instrs = decodeBlock(
      list,
      `${where}["${name}"]`,
      0,
      blocks,
      true,
    );
  }
  refuseStandingCycles(blocks, where);
  return blocks;
}

const LOCATIONS: Record<string, ParamLocation> = {
  "@path": "path",
  "@query": "query",
  "@header": "header",
  "@cookie": "cookie",
};

/**
 * Styles each location can be written in. `label` and `matrix` path styles
 * and exploded form objects are left out on purpose: the first two are rare
 * enough to refuse rather than half-support, and an exploded form object
 * spreads its properties across the query string with nothing to say which
 * keys belong to it.
 */
const STYLES: Record<ParamLocation, readonly string[]> = {
  path: ["simple"],
  query: ["form", "spaceDelimited", "pipeDelimited", "deepObject"],
  header: ["simple"],
  cookie: ["form"],
};
const PARAM_TYPES = new Set([
  "string",
  "integer",
  "number",
  "boolean",
  "array",
  "object",
]);

/**
 * Headers no program may touch. The compiler refuses these first; this is the
 * copy the runtime holds, so a program built by anything else is refused too.
 * `DENIED_HEADERS` in `@invariant-app/ir` is the list, and a test keeps them equal.
 */
export const RUNTIME_DENIED_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "expect",
  "content-length",
  "content-type",
  "content-encoding",
  "x-api-key",
  "api-key",
  "x-auth-token",
]);
const RUNTIME_DENIED_WORDS = /signature|hmac|digest|credential|secret/;

function decodeCodec(raw: unknown, where: string): ParamCodec {
  const value = object(raw, where);
  expectKeys(value, ["in", "name", "style", "explode", "type", "items"], where);
  const location = string(value["in"], `${where}.in`) as ParamLocation;
  if (!(location in STYLES))
    throw new ProgramError(`${where}.in is not a parameter location`);
  const name = string(value["name"], `${where}.name`);
  if (name === "" || isUnsafeKey(name)) {
    throw new ProgramError(`${where}.name may not be "${name}"`);
  }
  if (location === "header") {
    if (name !== name.toLowerCase()) {
      throw new ProgramError(`${where}.name must be lowercase for a header`);
    }
    if (RUNTIME_DENIED_HEADERS.has(name) || RUNTIME_DENIED_WORDS.test(name)) {
      throw new ProgramError(
        `${where} names the ${name} header, which no program may touch`,
      );
    }
  }
  const style = string(value["style"], `${where}.style`) as ParamStyle;
  if (!STYLES[location].includes(style)) {
    throw new ProgramError(
      `${where}.style ${style} is not served for a ${location} parameter`,
    );
  }
  const explode = value["explode"];
  if (typeof explode !== "boolean")
    throw new ProgramError(`${where}.explode must be a boolean`);
  const type = string(value["type"], `${where}.type`) as ParamType;
  if (!PARAM_TYPES.has(type))
    throw new ProgramError(`${where}.type is not a parameter type`);
  if (type === "object" && explode && style === "form") {
    throw new ProgramError(`${where} is an exploded form object, which is not served`);
  }
  if (style === "deepObject" && type !== "object") {
    throw new ProgramError(`${where} is a deepObject that is not an object`);
  }
  const items = value["items"];
  if (items !== undefined && (type !== "array" || !SCALARS.has(items as ScalarType))) {
    throw new ProgramError(`${where}.items must be a scalar type, on an array`);
  }
  return {
    in: location,
    name,
    style,
    explode,
    type,
    ...(items === undefined ? {} : { items: items as ParamScalar }),
  };
}

function decodeEnvelope(raw: unknown, where: string, blocks: Blocks): DecodedEnvelope {
  const value = object(raw, where);
  expectKeys(value, ["instrs", "params", "body"], where);
  const instrs = (array(value["instrs"], `${where}.instrs`) as unknown[]).map(
    (instr, index) => decodeInstr(instr, `${where}.instrs[${index}]`, 0, blocks),
  );
  const params = object(value["params"], `${where}.params`);
  expectKeys(params, ["old", "new"], `${where}.params`);
  const codecs = (side: "old" | "new") => {
    const map = new Map<string, ParamCodec>();
    (array(params[side], `${where}.params.${side}`) as unknown[]).forEach(
      (entry, index) => {
        const codec = decodeCodec(entry, `${where}.params.${side}[${index}]`);
        map.set(codecKey(codec.in, codec.name), codec);
      },
    );
    return map;
  };
  const old = codecs("old");
  const next = codecs("new");
  const body = value["body"];
  if (typeof body !== "boolean")
    throw new ProgramError(`${where}.body must be a boolean`);

  // Every place an instruction reaches is a part of the request and, outside
  // the body, one named parameter the program says how to write. Anything
  // else would be a program rewriting what it has no declaration for.
  instrs.forEach((instr, index) => {
    for (const path of touchedPaths(instr)) {
      const part = path[0];
      if (part === "@body") {
        if (!body) {
          throw new ProgramError(
            `${where}.instrs[${index}] reaches the body, which body says is not read`,
          );
        }
        continue;
      }
      const location = part === undefined ? undefined : LOCATIONS[part];
      const name = path[1];
      if (location === undefined || name === undefined || name === "*") {
        throw new ProgramError(
          `${where}.instrs[${index}] must address one named parameter or the body`,
        );
      }
      const key = codecKey(location, name);
      if (!old.has(key) && !next.has(key)) {
        throw new ProgramError(
          `${where}.instrs[${index}] names the ${location} parameter ${name}, which params does not declare`,
        );
      }
      if (
        location === "path" &&
        instr.k !== "scale" &&
        instr.k !== "enum" &&
        instr.k !== "cast" &&
        instr.k !== "time" &&
        instr.k !== "case"
      ) {
        // A template has exactly the parameters it has, so a path parameter
        // can be converted but not moved, added or taken away.
        throw new ProgramError(
          `${where}.instrs[${index}] can only convert a path parameter`,
        );
      }
    }
  });
  return { instrs, old, new: next, body };
}

const FORM_TYPES = new Set(["string", "integer", "number", "boolean", "array", "object"]);

function decodeForm(raw: unknown, where: string): DecodedForm {
  const value = object(raw, where);
  expectKeys(value, ["fields", "types"], where);
  const fields = new Map<string, FormField>();
  for (const [name, entry] of Object.entries(
    object(value["fields"], `${where}.fields`),
  )) {
    if (isUnsafeKey(name))
      throw new ProgramError(`${where}.fields may not name "${name}"`);
    const field = object(entry, `${where}.fields.${name}`);
    expectKeys(field, ["style", "explode"], `${where}.fields.${name}`);
    const style = field["style"];
    if (style !== "form" && style !== "deepObject") {
      throw new ProgramError(`${where}.fields.${name}.style must be form or deepObject`);
    }
    if (typeof field["explode"] !== "boolean") {
      throw new ProgramError(`${where}.fields.${name}.explode must be a boolean`);
    }
    fields.set(name, { style, explode: field["explode"] });
  }
  const types = new Map<string, FormType>();
  for (const [pointer, type] of Object.entries(
    object(value["types"], `${where}.types`),
  )) {
    segmentsOf(pointer, `${where}.types`);
    if (typeof type !== "string" || !FORM_TYPES.has(type)) {
      throw new ProgramError(`${where}.types["${pointer}"] is not a type`);
    }
    types.set(pointer, type as FormType);
  }
  return { fields, types };
}

const XML_TYPES = new Set([
  "object",
  "array",
  "string",
  "integer",
  "number",
  "boolean",
  "any",
]);
const XML_SCALARS = new Set(["string", "integer", "number", "boolean"]);

function decodeXmlNode(raw: unknown, where: string, depth: number): XmlNode {
  if (depth > 256) throw new ProgramError(`${where} nests too deeply`);
  const value = object(raw, where);
  expectKeys(
    value,
    [
      "type",
      "name",
      "namespace",
      "prefix",
      "attribute",
      "wrapped",
      "properties",
      "items",
    ],
    where,
  );
  const type = value["type"];
  if (typeof type !== "string" || !XML_TYPES.has(type)) {
    throw new ProgramError(`${where}.type is not a type`);
  }
  const node: XmlNode = { type: type as XmlNode["type"] };
  for (const key of ["name", "prefix"] as const) {
    if (value[key] === undefined) continue;
    const name = string(value[key], `${where}.${key}`);
    if (!isNcName(name) || (key === "prefix" && name === "xmlns")) {
      throw new ProgramError(`${where}.${key} is not a name XML allows`);
    }
    node[key] = name;
  }
  if (value["namespace"] !== undefined) {
    const namespace = string(value["namespace"], `${where}.namespace`);
    if (namespace === "") throw new ProgramError(`${where}.namespace is empty`);
    node.namespace = namespace;
  }
  if (onlyTrue(value["attribute"], `${where}.attribute`)) {
    if (!XML_SCALARS.has(type)) {
      throw new ProgramError(`${where} is an attribute, which only holds a value`);
    }
    node.attribute = true;
  }
  if (onlyTrue(value["wrapped"], `${where}.wrapped`)) {
    if (type !== "array")
      throw new ProgramError(`${where} is wrapped, which only a list is`);
    node.wrapped = true;
  }
  if (value["properties"] !== undefined) {
    if (type !== "object")
      throw new ProgramError(`${where} has properties, which only an object has`);
    const properties: Record<string, XmlNode> = {};
    const elements = new Set<string>();
    const attributes = new Set<string>();
    for (const [key, entry] of Object.entries(
      object(value["properties"], `${where}.properties`),
    )) {
      // Elements nothing names are kept under keys that begin with NUL.
      if (isUnsafeKey(key) || key.includes("\u0000")) {
        throw new ProgramError(`${where}.properties may not name "${key}"`);
      }
      const property = decodeXmlNode(entry, `${where}.properties.${key}`, depth + 1);
      const name =
        property.type === "array" && property.wrapped !== true
          ? (property.items?.name ?? key)
          : (property.name ?? key);
      const seen = property.attribute === true ? attributes : elements;
      const identity = `${property.namespace ?? ""} ${name}`;
      if (seen.has(identity)) {
        throw new ProgramError(`${where}.properties write two fields as ${name}`);
      }
      seen.add(identity);
      properties[key] = property;
    }
    node.properties = properties;
  }
  if (value["items"] !== undefined) {
    if (type !== "array")
      throw new ProgramError(`${where} has items, which only a list has`);
    const items = decodeXmlNode(value["items"], `${where}.items`, depth + 1);
    if (items.type === "array")
      throw new ProgramError(`${where} is a list of lists, which XML has no form for`);
    if (items.attribute === true)
      throw new ProgramError(`${where}.items cannot be an attribute`);
    if (items.name === undefined) throw new ProgramError(`${where}.items must be named`);
    node.items = items;
  } else if (type === "array") {
    throw new ProgramError(`${where} is a list with no items described`);
  }
  return node;
}

function decodeXmlBody(raw: unknown, where: string): XmlBody {
  const value = object(raw, where);
  expectKeys(value, ["read", "write"], where);
  const read = decodeXmlNode(value["read"], `${where}.read`, 0);
  const write = decodeXmlNode(value["write"], `${where}.write`, 0);
  if (read.type !== "object" || write.type !== "object") {
    throw new ProgramError(`${where} must describe an object at the root`);
  }
  return { read, write };
}

function decodeXml(raw: unknown, where: string): DecodedXml {
  const value = object(raw, where);
  expectKeys(value, ["request", "response"], where);
  const response = new Map<string, XmlBody>();
  for (const [status, body] of Object.entries(
    object(value["response"] ?? {}, `${where}.response`),
  )) {
    if (!/^([1-5]\d\d|[1-5][xX][xX]|default)$/.test(status)) {
      throw new ProgramError(`${where}.response has an invalid status key "${status}"`);
    }
    response.set(
      status.toLowerCase(),
      decodeXmlBody(body, `${where}.response.${status}`),
    );
  }
  return {
    ...(value["request"] === undefined
      ? {}
      : { request: decodeXmlBody(value["request"], `${where}.request`) }),
    response,
  };
}

function decodeSite(
  raw: unknown,
  where: string,
  template: string[],
  blocks: Blocks,
): DecodedSite {
  const value = object(raw, where);
  expectKeys(value, ["form", "xml", "request", "envelope", "response", "status"], where);
  const form =
    value["form"] === undefined ? undefined : decodeForm(value["form"], `${where}.form`);
  const xml =
    value["xml"] === undefined ? undefined : decodeXml(value["xml"], `${where}.xml`);
  if (value["request"] !== undefined && value["envelope"] !== undefined) {
    throw new ProgramError(
      `${where} has both request and envelope; one list keeps the order`,
    );
  }
  const envelope =
    value["envelope"] === undefined
      ? undefined
      : decodeEnvelope(value["envelope"], `${where}.envelope`, blocks);

  const request = (array(value["request"] ?? [], `${where}.request`) as unknown[]).map(
    (instr, index) => decodeInstr(instr, `${where}.request[${index}]`, 0, blocks),
  );

  const response = new Map<string, CompiledInstr[]>();
  if (value["response"] !== undefined) {
    for (const [status, list] of Object.entries(
      object(value["response"], `${where}.response`),
    )) {
      // As OpenAPI writes them: an exact status, a class such as 2XX, or
      // `default` for every status nothing more specific names.
      if (!/^([1-5]\d\d|[1-5][xX][xX]|default)$/.test(status)) {
        throw new ProgramError(`${where}.response has an invalid status key "${status}"`);
      }
      const key = status.toLowerCase();
      if (response.has(key)) {
        throw new ProgramError(`${where}.response names ${key} twice`);
      }
      response.set(
        key,
        (array(list, `${where}.response.${status}`) as unknown[]).map((instr, index) =>
          decodeInstr(instr, `${where}.response.${status}[${index}]`, 0, blocks),
        ),
      );
    }
  }

  const numeric =
    needsExactNumbers(request) ||
    (envelope !== undefined && needsExactNumbers(envelope.instrs)) ||
    [...response.values()].some((list) => needsExactNumbers(list));
  const status =
    value["status"] === undefined
      ? []
      : decodeStatusRules(value["status"], `${where}.status`);
  if (xml !== undefined) {
    // An XML body has no maps: what a map's wildcard would reach there are the
    // elements nothing names, kept whole.
    const lists = [request, ...response.values(), envelope?.instrs ?? []];
    if (
      lists.some((list) =>
        list.some((instr) => touchedPaths(instr).some((path) => path.includes("{}"))),
      )
    ) {
      throw new ProgramError(
        `${where} reads a map's values in an XML body, which has none`,
      );
    }
  }
  return {
    request,
    response,
    status,
    numeric,
    template,
    ...(envelope === undefined ? {} : { envelope }),
    ...(form === undefined ? {} : { form }),
    ...(xml === undefined ? {} : { xml }),
  };
}

function decodeRoute(raw: unknown, where: string): DecodedRoute {
  const value = object(raw, where);
  expectKeys(value, ["from", "to", "c"], where);
  const from = object(value["from"], `${where}.from`);
  const to = object(value["to"], `${where}.to`);
  const fromMethod = string(from["method"], `${where}.from.method`).toLowerCase();
  const toMethod = string(to["method"], `${where}.to.method`).toLowerCase();
  for (const method of [fromMethod, toMethod]) {
    if (!HTTP_METHODS.has(method)) {
      throw new ProgramError(`${where} names ${method}, which is not an HTTP method`);
    }
  }
  return {
    method: fromMethod,
    toMethod,
    from: string(from["path"], `${where}.from.path`).split("/"),
    to: string(to["path"], `${where}.to.path`).split("/"),
    changeId: string(value["c"], `${where}.c`),
  };
}

/** An optional flag that is either left out or true, never anything else. */
function onlyTrue(value: unknown, where: string): boolean {
  if (value === undefined) return false;
  if (value !== true) throw new ProgramError(`${where} must be true when present`);
  return true;
}

/** The program format this runtime reads. */
export const PROGRAM_VERSION = 2;

/**
 * A program this runtime is too old to run, refused before anything in it is
 * read. A newer program is never partly run: an instruction skipped because it
 * was not understood is a response in a shape nobody promised.
 */
export class ProgramTooNewError extends ProgramError {
  readonly code = "invariant_program_too_new";
  /** The runtime the program asks for, or the format it is written in. */
  readonly needs: string;
  /** What compiled it, when it says. */
  readonly compiledBy: string | undefined;
  constructor(needs: string, compiledBy: string | undefined) {
    super(
      `This program needs ${needs}, and this runtime is ${VERSION}` +
        (compiledBy === undefined ? "" : `; it was compiled by ${compiledBy}`) +
        ". Upgrade the runtime to at least that version, or compile with a CLI no newer than it.",
    );
    this.name = "ProgramTooNewError";
    this.needs = needs;
    this.compiledBy = compiledBy;
  }
}

/** Orders two `major.minor.patch` versions; a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const [core = "", pre] = version.split("-", 2);
    return { parts: core.split(".").map((part) => Number(part) || 0), pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === undefined) return 1;
  if (right.pre === undefined) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/**
 * Whether this runtime can run the program at all, read before anything else
 * in it: a newer program's first unfamiliar key should say which runtime it
 * needs, not that the key is unknown.
 */
function checkVersion(value: Record<string, unknown>): void {
  const compiledBy =
    typeof value["compiledBy"] === "string" ? value["compiledBy"] : undefined;
  const format = value["irVersion"];
  if (typeof format === "number" && format > PROGRAM_VERSION) {
    throw new ProgramTooNewError(`program format ${format}`, compiledBy);
  }
  if (format !== PROGRAM_VERSION) {
    // Parsed JSON can carry a `toString` that is data, so only a primitive is printed.
    const shown =
      typeof format === "object" && format !== null
        ? Array.isArray(format)
          ? "an array"
          : "an object"
        : String(format);
    throw new ProgramError(
      `Unsupported program format ${shown}; this runtime reads format ` +
        `${PROGRAM_VERSION}. Compile the program again with a current CLI.`,
    );
  }
  const minRuntime = value["minRuntime"];
  if (minRuntime === undefined) return;
  if (
    typeof minRuntime !== "string" ||
    !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(minRuntime)
  ) {
    throw new ProgramError("program.minRuntime must be a version such as 1.2.3");
  }
  // A feature not yet released asks for a pre-release of the patch after the
  // last release, `-next`. The runtime built from the same unreleased source
  // implements it; every published one is older and refuses it here.
  if (compareVersions(minRuntime, VERSION) > 0 && minRuntime !== nextRelease(VERSION)) {
    throw new ProgramTooNewError(`runtime ${minRuntime}`, compiledBy);
  }
}

/** The version a feature not yet released asks for, as `@invariant-app/ir` writes it. */
function nextRelease(version: string): string {
  const [core = "0.0.0"] = version.split("-", 1);
  const [major = 0, minor = 0, patch = 0] = core.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}-next`;
}

export function decodeProgram(raw: unknown): DecodedProgram {
  const value = object(raw, "program");
  checkVersion(value);
  expectKeys(
    value,
    [
      "irVersion",
      "compiledBy",
      "minRuntime",
      "api",
      "current",
      "currentLabel",
      "contracts",
      "blocks",
      "basePath",
      "identity",
    ],
    "program",
  );
  if (value["compiledBy"] !== undefined && typeof value["compiledBy"] !== "string") {
    throw new ProgramError("program.compiledBy must be a string");
  }
  const basePath = value["basePath"];
  if (
    basePath !== undefined &&
    (typeof basePath !== "string" || !basePath.startsWith("/") || basePath.endsWith("/"))
  ) {
    throw new ProgramError(
      "program.basePath must be a path such as /v1, without a trailing /",
    );
  }

  const shared = decodeBlocks(value["blocks"], "program.blocks");
  const contracts = new Map<string, DecodedContract>();
  for (const [label, entry] of Object.entries(
    object(value["contracts"], "program.contracts"),
  )) {
    const where = `program.contracts.${label}`;
    const contract = object(entry, where);
    expectKeys(
      contract,
      [
        "label",
        "routes",
        "sites",
        "outbound",
        "blocks",
        "behaviors",
        "retired",
        "basePath",
        "deprecated",
        "sunset",
      ],
      where,
    );
    const blocks = decodeBlocks(contract["blocks"], `${where}.blocks`, shared);
    const ownBase = contract["basePath"];
    if (
      ownBase !== undefined &&
      (typeof ownBase !== "string" || !/^(\/.*[^/])?$/.test(ownBase))
    ) {
      throw new ProgramError(`${where}.basePath must be a path such as /v1, or empty`);
    }

    const sites = new Map<string, DecodedSite>();
    for (const [key, site] of Object.entries(
      object(contract["sites"], `${where}.sites`),
    )) {
      // Only the method is case-insensitive. A path is not, and lowercasing
      // it meant a site such as `/v1/{name}:batchGet` was never found, so its
      // callers were passed on untranslated without a word.
      const separator = key.indexOf(" ");
      if (separator <= 0) {
        throw new ProgramError(
          `${where}.sites has a key "${key}" that is not "method path"`,
        );
      }
      const method = key.slice(0, separator).toLowerCase();
      const path = key.slice(separator + 1);
      sites.set(
        `${method} ${path}`,
        decodeSite(site, `${where}.sites["${key}"]`, path.split("/"), blocks),
      );
    }

    const outbound = new Map<string, { instrs: CompiledInstr[]; numeric: boolean }>();
    for (const [key, list] of Object.entries(
      object(contract["outbound"] ?? {}, `${where}.outbound`),
    )) {
      const separator = key.indexOf(" ");
      const event = key.slice(separator + 1);
      if (separator <= 0 || !/^(webhook|callback):./.test(event)) {
        throw new ProgramError(
          `${where}.outbound has a key "${key}" that is not "method webhook:<name>" or "method callback:<operation>/<callback>"`,
        );
      }
      const instrs = (array(list, `${where}.outbound["${key}"]`) as unknown[]).map(
        (instr, index) =>
          decodeInstr(instr, `${where}.outbound["${key}"][${index}]`, 0, blocks),
      );
      outbound.set(`${key.slice(0, separator).toLowerCase()} ${event}`, {
        instrs,
        numeric: needsExactNumbers(instrs),
      });
    }

    const when = (key: "deprecated" | "sunset") => {
      const value = contract[key];
      if (value === undefined) return {};
      const text = string(value, `${where}.${key}`);
      if (Number.isNaN(Date.parse(text))) {
        throw new ProgramError(`${where}.${key} must be a date, found ${text}`);
      }
      return { [key]: text };
    };

    contracts.set(label, {
      ...(ownBase === undefined ? {} : { basePath: ownBase as string }),
      ...when("deprecated"),
      ...when("sunset"),
      label: string(contract["label"], `${where}.label`),
      routes: (array(contract["routes"], `${where}.routes`) as unknown[]).map(
        (route, index) => decodeRoute(route, `${where}.routes[${index}]`),
      ),
      sites,
      outbound,
      behaviors: (
        array(contract["behaviors"] ?? [], `${where}.behaviors`) as unknown[]
      ).map((flag, index) => string(flag, `${where}.behaviors[${index}]`)),
      retired: (array(contract["retired"] ?? [], `${where}.retired`) as unknown[]).map(
        (entry, index) => {
          const at = `${where}.retired[${index}]`;
          const row = object(entry, at);
          const guidance = row["guidance"];
          const refuse = row["refuse"];
          if (refuse !== undefined && refuse !== true) {
            throw new ProgramError(`${at}.refuse must be true when present`);
          }
          return {
            method: string(row["method"], `${at}.method`).toLowerCase(),
            path: string(row["path"], `${at}.path`),
            guidance:
              guidance === undefined ? undefined : string(guidance, `${at}.guidance`),
            c: string(row["c"], `${at}.c`),
            refuse: refuse === true,
          };
        },
      ),
    });
  }

  const identity = decodeIdentity(value["identity"]);
  return {
    api: string(value["api"], "program.api"),
    current: string(value["current"], "program.current"),
    currentLabel: string(value["currentLabel"], "program.currentLabel"),
    contracts,
    basePath: (basePath as string | undefined) ?? "",
    ...(identity ? { identity } : {}),
  };
}

const PARAMETER = /\{[^{}]+\}/g;

/**
 * A template segment with literal text around its parameters, such as
 * `{name}:cancel`, the custom-method form of Google's design guide, or
 * `{id}.{format}`. Compiled once per segment: the literal parts are escaped,
 * each parameter matches one or more characters of that segment only, since
 * an OpenAPI path parameter never spans a `/`.
 */
const mixedSegments = new Map<string, RegExp>();
function mixedSegment(template: string): RegExp {
  let compiled = mixedSegments.get(template);
  if (!compiled) {
    const source = template
      .split(PARAMETER)
      .map((literal) => literal.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&"))
      .join("(.+)");
    compiled = new RegExp(`^${source}$`, "s");
    mixedSegments.set(template, compiled);
  }
  return compiled;
}

const isWholeParameter = (segment: string): boolean =>
  segment.startsWith("{") &&
  segment.endsWith("}") &&
  segment.indexOf("}") === segment.length - 1;

/** Matches a concrete request path against a route template. */
export function matchTemplate(
  template: readonly string[],
  path: string,
): string[] | undefined {
  const actual = path.split("/");
  if (actual.length !== template.length) return undefined;

  const params: string[] = [];
  for (const [index, expected] of template.entries()) {
    const segment = actual[index] as string;
    if (isWholeParameter(expected)) {
      if (segment === "") return undefined;
      params.push(segment);
      continue;
    }
    if (expected.includes("{")) {
      const matched = mixedSegment(expected).exec(segment);
      if (!matched) return undefined;
      params.push(...matched.slice(1));
      continue;
    }
    if (expected !== segment) return undefined;
  }
  return params;
}

export function fillTemplate(
  template: readonly string[],
  params: readonly string[],
): string {
  let next = 0;
  return template
    .map((segment) =>
      segment.replace(PARAMETER, () => {
        const value = params[next] ?? "";
        next += 1;
        return value;
      }),
    )
    .join("/");
}

/** The compiled site for a concrete request, found by template match. */
export function findSite(
  contract: DecodedContract,
  method: string,
  path: string,
): DecodedSite | undefined {
  const lower = method.toLowerCase();
  const direct = contract.sites.get(`${lower} ${path}`);
  if (direct) return direct;

  for (const [key, site] of contract.sites) {
    const separator = key.indexOf(" ");
    if (key.slice(0, separator) !== lower) continue;
    if (matchTemplate(key.slice(separator + 1).split("/"), path)) return site;
  }
  return undefined;
}
