/**
 * Decoding a compiled program.
 *
 * The decoder is hand-written and strict on purpose. This is the boundary where
 * a build artifact becomes something that runs against live traffic, so an
 * unrecognised instruction, an unexpected field or a malformed path is a
 * refusal to load rather than something to skip over at request time.
 */
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
  /** Instructions over the whole request, where a Change reaches a parameter. */
  envelope?: DecodedEnvelope;
  /** The site's path template, split on `/`, as the contract writes it. */
  template: string[];
  /** How the request body is written when it arrives form-encoded. */
  form?: DecodedForm;
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
  /** Where this contract's callers send requests, when it is not the current base path. */
  basePath?: string;
  routes: DecodedRoute[];
  sites: Map<string, DecodedSite>;
  behaviors: string[];
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

export interface DecodedProgram {
  api: string;
  current: string;
  currentLabel: string;
  contracts: Map<string, DecodedContract>;
  /** The path the API is served under, or empty when it is served at the root. */
  basePath: string;
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
    case "set": {
      expectKeys(value, ["k", "path", "value", "ifAbsent", "ifNull", "c"], where);
      if (typeof value["ifAbsent"] !== "boolean") {
        throw new ProgramError(`${where}.ifAbsent must be a boolean`);
      }
      return {
        k: "set",
        path: segmentsOf(string(value["path"], `${where}.path`), `${where}.path`),
        value: value["value"] as Json,
        ifAbsent: value["ifAbsent"],
        ...(onlyTrue(value["ifNull"], `${where}.ifNull`) ? { ifNull: true } : {}),
        c: changeId,
      };
    }
    case "del": {
      expectKeys(value, ["k", "path", "ifNull", "c"], where);
      return {
        k: "del",
        path: segmentsOf(string(value["path"], `${where}.path`), `${where}.path`),
        ...(onlyTrue(value["ifNull"], `${where}.ifNull`) ? { ifNull: true } : {}),
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
 * `DENIED_HEADERS` in `@invariant/ir` is the list, and a test keeps them equal.
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

function decodeEnvelope(raw: unknown, where: string): DecodedEnvelope {
  const value = object(raw, where);
  expectKeys(value, ["instrs", "params", "body"], where);
  const instrs = (array(value["instrs"], `${where}.instrs`) as unknown[]).map(
    (instr, index) => decodeInstr(instr, `${where}.instrs[${index}]`),
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
    const paths = instr.k === "move" ? [instr.from, instr.to] : [instr.path];
    for (const path of paths) {
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
        instr.k !== "cast"
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

function decodeSite(raw: unknown, where: string, template: string[]): DecodedSite {
  const value = object(raw, where);
  expectKeys(value, ["form", "request", "envelope", "response"], where);
  const form =
    value["form"] === undefined ? undefined : decodeForm(value["form"], `${where}.form`);
  if (value["request"] !== undefined && value["envelope"] !== undefined) {
    throw new ProgramError(
      `${where} has both request and envelope; one list keeps the order`,
    );
  }
  const envelope =
    value["envelope"] === undefined
      ? undefined
      : decodeEnvelope(value["envelope"], `${where}.envelope`);

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
    needsExactNumbers(request) ||
    (envelope !== undefined && needsExactNumbers(envelope.instrs)) ||
    [...response.values()].some(needsExactNumbers);
  return {
    request,
    response,
    numeric,
    template,
    ...(envelope === undefined ? {} : { envelope }),
    ...(form === undefined ? {} : { form }),
  };
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

/** An optional flag that is either left out or true, never anything else. */
function onlyTrue(value: unknown, where: string): boolean {
  if (value === undefined) return false;
  if (value !== true) throw new ProgramError(`${where} must be true when present`);
  return true;
}

export function decodeProgram(raw: unknown): DecodedProgram {
  const value = object(raw, "program");
  expectKeys(
    value,
    ["irVersion", "api", "current", "currentLabel", "contracts", "basePath"],
    "program",
  );
  const basePath = value["basePath"];
  if (
    basePath !== undefined &&
    (typeof basePath !== "string" || !basePath.startsWith("/") || basePath.endsWith("/"))
  ) {
    throw new ProgramError(
      "program.basePath must be a path such as /v1, without a trailing /",
    );
  }

  if (value["irVersion"] !== 1) {
    throw new ProgramError(`Unsupported IR version ${String(value["irVersion"])}`);
  }

  const contracts = new Map<string, DecodedContract>();
  for (const [label, entry] of Object.entries(
    object(value["contracts"], "program.contracts"),
  )) {
    const where = `program.contracts.${label}`;
    const contract = object(entry, where);
    expectKeys(
      contract,
      ["label", "routes", "sites", "behaviors", "retired", "basePath"],
      where,
    );
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
        decodeSite(site, `${where}.sites["${key}"]`, path.split("/")),
      );
    }

    contracts.set(label, {
      ...(ownBase === undefined ? {} : { basePath: ownBase as string }),
      label: string(contract["label"], `${where}.label`),
      routes: (array(contract["routes"], `${where}.routes`) as unknown[]).map(
        (route, index) => decodeRoute(route, `${where}.routes[${index}]`),
      ),
      sites,
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

  return {
    api: string(value["api"], "program.api"),
    current: string(value["current"], "program.current"),
    currentLabel: string(value["currentLabel"], "program.currentLabel"),
    contracts,
    basePath: (basePath as string | undefined) ?? "",
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
