/**
 * Decoding a compiled program.
 *
 * The decoder is hand-written and strict on purpose. This is the boundary where
 * a build artifact becomes something that runs against live traffic, so an
 * unrecognised instruction, an unexpected field or a malformed path is a
 * refusal to load rather than something to skip over at request time.
 */
import type { CompiledInstr, ScalarType } from "./interpreter.ts";
import type { Json } from "./json.ts";
import { isUnsafeKey } from "./pointer.ts";

export class ProgramError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramError";
  }
}

export interface DecodedSite {
  request: CompiledInstr[];
  response: Map<string, CompiledInstr[]>;
  /** True when any instruction re-encodes a number. */
  numeric: boolean;
}

export interface DecodedRoute {
  method: string;
  /** Template segments; `{name}` matches one segment. */
  from: string[];
  to: string[];
  changeId: string;
}

export interface DecodedContract {
  label: string;
  routes: DecodedRoute[];
  sites: Map<string, DecodedSite>;
  behaviors: string[];
}

export interface DecodedProgram {
  api: string;
  current: string;
  currentLabel: string;
  contracts: Map<string, DecodedContract>;
}

const SCALARS = new Set<ScalarType>(["string", "integer", "number", "boolean"]);

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
      const decoded = raw === "*" ? "*" : raw.replace(/~1/g, "/").replace(/~0/g, "~");
      if (isUnsafeKey(decoded)) {
        throw new ProgramError(`${where} may not name "${decoded}"`);
      }
      return decoded;
    });
}

function countWildcards(segments: readonly string[]): number {
  return segments.filter((segment) => segment === "*").length;
}

function decodeInstr(raw: unknown, where: string): CompiledInstr {
  const value = object(raw, where);
  const kind = string(value["k"], `${where}.k`);
  const changeId = string(value["c"], `${where}.c`);

  switch (kind) {
    case "move": {
      expectKeys(value, ["k", "from", "to", "c"], where);
      const from = segmentsOf(string(value["from"], `${where}.from`), `${where}.from`);
      const to = segmentsOf(string(value["to"], `${where}.to`), `${where}.to`);
      if (countWildcards(from) !== countWildcards(to)) {
        // Each wildcard on the left has to line up with one on the right, or
        // there is no telling which element a value belongs to.
        throw new ProgramError(
          `${where} moves between paths with different wildcard counts`,
        );
      }
      if (from.length === 0 || to.length === 0) {
        throw new ProgramError(`${where} cannot move the document root`);
      }
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
      expectKeys(value, ["k", "path", "map", "lenient", "c"], where);
      const lenient = value["lenient"];
      if (lenient !== undefined && typeof lenient !== "boolean") {
        throw new ProgramError(`${where}.lenient must be a boolean`);
      }
      const map = object(value["map"], `${where}.map`);
      const decoded: Record<string, string> = {};
      for (const [from, to] of Object.entries(map)) {
        decoded[from] = string(to, `${where}.map.${from}`);
      }
      return {
        k: "enum",
        path: segmentsOf(string(value["path"], `${where}.path`), `${where}.path`),
        map: decoded,
        ...(lenient === true ? { lenient: true } : {}),
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
    case "set": {
      expectKeys(value, ["k", "path", "value", "ifAbsent", "c"], where);
      if (typeof value["ifAbsent"] !== "boolean") {
        throw new ProgramError(`${where}.ifAbsent must be a boolean`);
      }
      return {
        k: "set",
        path: segmentsOf(string(value["path"], `${where}.path`), `${where}.path`),
        value: value["value"] as Json,
        ifAbsent: value["ifAbsent"],
        c: changeId,
      };
    }
    case "del": {
      expectKeys(value, ["k", "path", "c"], where);
      return {
        k: "del",
        path: segmentsOf(string(value["path"], `${where}.path`), `${where}.path`),
        c: changeId,
      };
    }
    default:
      throw new ProgramError(`${where} has an unknown instruction "${kind}"`);
  }
}

function needsExactNumbers(instrs: readonly CompiledInstr[]): boolean {
  return instrs.some((instr) => instr.k === "scale" || instr.k === "cast");
}

function decodeSite(raw: unknown, where: string): DecodedSite {
  const value = object(raw, where);
  expectKeys(value, ["request", "response"], where);

  const request = (array(value["request"] ?? [], `${where}.request`) as unknown[]).map(
    (instr, index) => decodeInstr(instr, `${where}.request[${index}]`),
  );

  const response = new Map<string, CompiledInstr[]>();
  if (value["response"] !== undefined) {
    for (const [status, list] of Object.entries(
      object(value["response"], `${where}.response`),
    )) {
      if (!/^([1-5]\d\d|[1-5]xx)$/.test(status)) {
        throw new ProgramError(`${where}.response has an invalid status key "${status}"`);
      }
      response.set(
        status,
        (array(list, `${where}.response.${status}`) as unknown[]).map((instr, index) =>
          decodeInstr(instr, `${where}.response.${status}[${index}]`),
        ),
      );
    }
  }

  const numeric =
    needsExactNumbers(request) || [...response.values()].some(needsExactNumbers);
  return { request, response, numeric };
}

function decodeRoute(raw: unknown, where: string): DecodedRoute {
  const value = object(raw, where);
  expectKeys(value, ["from", "to", "c"], where);
  const from = object(value["from"], `${where}.from`);
  const to = object(value["to"], `${where}.to`);
  const fromMethod = string(from["method"], `${where}.from.method`).toLowerCase();
  const toMethod = string(to["method"], `${where}.to.method`).toLowerCase();
  if (fromMethod !== toMethod) {
    throw new ProgramError(`${where} changes the HTTP method, which is not supported`);
  }
  return {
    method: fromMethod,
    from: string(from["path"], `${where}.from.path`).split("/"),
    to: string(to["path"], `${where}.to.path`).split("/"),
    changeId: string(value["c"], `${where}.c`),
  };
}

export function decodeProgram(raw: unknown): DecodedProgram {
  const value = object(raw, "program");
  expectKeys(
    value,
    ["irVersion", "api", "current", "currentLabel", "contracts"],
    "program",
  );

  if (value["irVersion"] !== 1) {
    throw new ProgramError(`Unsupported IR version ${String(value["irVersion"])}`);
  }

  const contracts = new Map<string, DecodedContract>();
  for (const [label, entry] of Object.entries(
    object(value["contracts"], "program.contracts"),
  )) {
    const where = `program.contracts.${label}`;
    const contract = object(entry, where);
    expectKeys(contract, ["label", "routes", "sites", "behaviors"], where);

    const sites = new Map<string, DecodedSite>();
    for (const [key, site] of Object.entries(
      object(contract["sites"], `${where}.sites`),
    )) {
      sites.set(key.toLowerCase(), decodeSite(site, `${where}.sites["${key}"]`));
    }

    contracts.set(label, {
      label: string(contract["label"], `${where}.label`),
      routes: (array(contract["routes"], `${where}.routes`) as unknown[]).map(
        (route, index) => decodeRoute(route, `${where}.routes[${index}]`),
      ),
      sites,
      behaviors: (
        array(contract["behaviors"] ?? [], `${where}.behaviors`) as unknown[]
      ).map((flag, index) => string(flag, `${where}.behaviors[${index}]`)),
    });
  }

  return {
    api: string(value["api"], "program.api"),
    current: string(value["current"], "program.current"),
    currentLabel: string(value["currentLabel"], "program.currentLabel"),
    contracts,
  };
}

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
    if (expected.startsWith("{") && expected.endsWith("}")) {
      if (segment === "") return undefined;
      params.push(segment);
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
    .map((segment) => {
      if (segment.startsWith("{") && segment.endsWith("}")) {
        const value = params[next] ?? "";
        next += 1;
        return value;
      }
      return segment;
    })
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
