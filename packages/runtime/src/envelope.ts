/**
 * A request as one tree, and back.
 *
 * `open` reads the parameters a program names out of the request, decoded
 * into typed values the way their declaration says they are written, and
 * places them beside the body under `@path`, `@query`, `@header` and
 * `@cookie`. The interpreter then runs over that tree like any body. `close`
 * writes what the tree holds back into the request, encoded the way the
 * current contract declares each parameter.
 *
 * Only named parameters are ever decoded or rewritten. Everything else in the
 * request, including the order of an untouched query string, is passed on
 * exactly as it arrived, because a program that quietly re-encodes what it
 * was never asked about is a program that breaks a signature or a cache key
 * nobody knew depended on those bytes.
 */
import { type CompiledInstr, TransformError, touchedPaths } from "./interpreter.ts";
import {
  type Json,
  type NumberFidelity,
  numberTextOf,
  parseJson,
  stringifyJson,
} from "./json.ts";
import { isUnsafeKey } from "./pointer.ts";

export type ParamLocation = "path" | "query" | "header" | "cookie";
export type ParamStyle =
  | "simple"
  | "form"
  | "spaceDelimited"
  | "pipeDelimited"
  | "deepObject";
export type ParamType = "string" | "integer" | "number" | "boolean" | "array" | "object";
export type ParamScalar = "string" | "integer" | "number" | "boolean";

export interface ParamCodec {
  in: ParamLocation;
  name: string;
  style: ParamStyle;
  explode: boolean;
  type: ParamType;
  items?: ParamScalar;
}

export interface DecodedEnvelope {
  instrs: CompiledInstr[];
  /** How an old caller writes each named parameter, keyed `in name`. */
  old: Map<string, ParamCodec>;
  /** How the current contract expects each one, keyed the same way. */
  new: Map<string, ParamCodec>;
  body: boolean;
}

/** A request as a binding hands it over and gets it back. */
export interface EnvelopeRequest {
  /** The routed path as the contract writes it, without the base path. */
  path: string;
  /** The raw query string, without its `?`. */
  search: string;
  /** Every header line, in the order received. */
  headers: [string, string][];
  /** The body text, when the program reads the body and there is one. */
  body: string | undefined;
  /** True when the body is form-encoded rather than JSON. */
  form?: boolean;
}

export const PART = {
  path: "@path",
  query: "@query",
  header: "@header",
  cookie: "@cookie",
  body: "@body",
} as const;

export const codecKey = (location: ParamLocation, name: string): string =>
  `${location} ${location === "header" ? name.toLowerCase() : name}`;

const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

interface QueryPair {
  raw: string;
  key: string;
  value: string;
}

function decodeComponent(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    // Not valid percent-encoding. Compared as written, so it can only ever
    // match a parameter literally named that, and it is passed on untouched.
    return text;
  }
}

/** A path segment: percent-decoded, where `+` is a plus sign, not a space. */
function decodeSegment(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function queryPairs(search: string): QueryPair[] {
  if (search === "") return [];
  return search.split("&").map((raw) => {
    const equals = raw.indexOf("=");
    return equals === -1
      ? { raw, key: decodeComponent(raw), value: "" }
      : {
          raw,
          key: decodeComponent(raw.slice(0, equals)),
          value: decodeComponent(raw.slice(equals + 1)),
        };
  });
}

function cookiePairs(headers: readonly [string, string][]): [string, string][] {
  const pairs: [string, string][] = [];
  for (const [name, value] of headers) {
    if (name.toLowerCase() !== "cookie") continue;
    for (const part of value.split(";")) {
      const trimmed = part.trim();
      if (trimmed === "") continue;
      const equals = trimmed.indexOf("=");
      pairs.push(
        equals === -1
          ? [trimmed, ""]
          : [trimmed.slice(0, equals), trimmed.slice(equals + 1)],
      );
    }
  }
  return pairs;
}

/** A scalar written as text, typed the way its declaration says it is. */
function scalar(
  text: string,
  type: ParamScalar | ParamType,
  fidelity: NumberFidelity,
): Json {
  if ((type === "integer" || type === "number") && JSON_NUMBER.test(text)) {
    return parseJson(text, fidelity);
  }
  if (type === "boolean" && (text === "true" || text === "false")) return text === "true";
  // Anything else stays text. An instruction that needs a number refuses it
  // then, with the Change that asked; one that does not passes it through.
  return text;
}

function delimiterOf(codec: ParamCodec): string {
  if (codec.style === "spaceDelimited") return " ";
  if (codec.style === "pipeDelimited") return "|";
  return ",";
}

/** A value from its written parts: every occurrence for an exploded list. */
function decodeValue(
  parts: readonly string[],
  codec: ParamCodec,
  fidelity: NumberFidelity,
): Json {
  const item = codec.items ?? "string";
  if (codec.type === "array") {
    const values =
      codec.explode && codec.in !== "header" && codec.in !== "path"
        ? parts
        : (parts[0] ?? "")
            .split(delimiterOf(codec))
            .map((entry) => (codec.in === "header" ? entry.trim() : entry));
    return values.map((entry) => scalar(entry, item, fidelity));
  }
  if (codec.type === "object") {
    const text = parts[0] ?? "";
    const object: Record<string, Json> = {};
    if (codec.explode) {
      for (const entry of text.split(",")) {
        const equals = entry.indexOf("=");
        const key = entry.slice(0, equals).trim();
        if (equals === -1 || isUnsafeKey(key)) continue;
        object[key] = entry.slice(equals + 1).trim();
      }
    } else {
      const flat = text.split(",");
      for (let index = 0; index + 1 < flat.length; index += 2) {
        const key = flat[index] as string;
        if (!isUnsafeKey(key)) object[key] = flat[index + 1] as string;
      }
    }
    return object;
  }
  return scalar(parts[0] ?? "", codec.type, fidelity);
}

/** The template's parameter names, in the order `matchTemplate` returns values. */
export function templateNames(template: readonly string[]): string[] {
  return template.flatMap((segment) =>
    [...segment.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1] as string),
  );
}

/**
 * The request as a tree holding only what the program names.
 *
 * `pathValues` are the values the routed path matched its template with, in
 * template order.
 */
export function openEnvelope(
  envelope: DecodedEnvelope,
  template: readonly string[],
  pathValues: readonly string[],
  request: EnvelopeRequest,
  fidelity: NumberFidelity,
): Record<string, Json> {
  const tree: Record<string, Json> = {
    [PART.path]: {},
    [PART.query]: {},
    [PART.header]: {},
    [PART.cookie]: {},
  };
  const names = templateNames(template);
  const query = queryPairs(request.search);
  const cookies = cookiePairs(request.headers);

  for (const codec of envelope.old.values()) {
    let parts: string[] = [];
    let object: Record<string, Json> | undefined;
    switch (codec.in) {
      case "path": {
        const index = names.indexOf(codec.name);
        const raw = index === -1 ? undefined : pathValues[index];
        if (raw !== undefined) parts = [decodeSegment(raw)];
        break;
      }
      case "query":
        if (codec.style === "deepObject") {
          const prefix = `${codec.name}[`;
          for (const pair of query) {
            if (!pair.key.startsWith(prefix) || !pair.key.endsWith("]")) continue;
            // A property name is the caller's to choose, including
            // `__proto__`, which must never reach an object as a key.
            const key = pair.key.slice(prefix.length, -1);
            if (isUnsafeKey(key)) continue;
            object ??= {};
            object[key] = pair.value;
          }
        } else {
          parts = query
            .filter((pair) => pair.key === codec.name)
            .map((pair) => pair.value);
        }
        break;
      case "header": {
        const lines = request.headers
          .filter(([name]) => name.toLowerCase() === codec.name)
          .map(([, value]) => value.trim());
        // Several lines of one header are one comma-separated value.
        if (lines.length > 0) parts = [lines.join(", ")];
        break;
      }
      case "cookie":
        parts = cookies.filter(([name]) => name === codec.name).map(([, value]) => value);
        break;
    }
    const part = tree[PART[codec.in]] as Record<string, Json>;
    if (object !== undefined) part[codec.name] = object;
    else if (parts.length > 0) part[codec.name] = decodeValue(parts, codec, fidelity);
  }

  if (envelope.body && request.body !== undefined && request.body !== "") {
    tree[PART.body] = parseJson(request.body, fidelity);
  }
  return tree;
}

function text(value: Json, changeId: string, where: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  if (value === null) return "";
  try {
    return numberTextOf(value);
  } catch {
    throw new TransformError(
      changeId,
      `${where} holds a value that cannot be written as text`,
    );
  }
}

/** The written parts of a value: one per occurrence for an exploded list. */
function encodeValue(value: Json, codec: ParamCodec, changeId: string): string[] {
  const where = `${codec.in} parameter ${codec.name}`;
  if (Array.isArray(value)) {
    const items = value.map((entry) => text(entry, changeId, where));
    if (codec.explode && (codec.in === "query" || codec.in === "cookie")) return items;
    return [items.join(delimiterOf(codec))];
  }
  if (typeof value === "object" && value !== null && !numberLike(value)) {
    const entries = Object.entries(value as Record<string, Json>).map(
      ([key, entry]) => [key, text(entry, changeId, where)] as const,
    );
    return [
      codec.explode
        ? entries.map(([key, entry]) => `${key}=${entry}`).join(",")
        : entries.flat().join(","),
    ];
  }
  return [text(value, changeId, where)];
}

function numberLike(value: unknown): boolean {
  return JSON.isRawJSON(value);
}

const FALLBACK: Record<ParamLocation, Pick<ParamCodec, "style" | "explode">> = {
  path: { style: "simple", explode: false },
  query: { style: "form", explode: true },
  header: { style: "simple", explode: false },
  cookie: { style: "form", explode: true },
};

/** The change that last wrote under a pointer prefix, for naming a refusal. */
function writerOf(instrs: readonly CompiledInstr[], part: string, name: string): string {
  for (let index = instrs.length - 1; index >= 0; index -= 1) {
    const instr = instrs[index] as CompiledInstr;
    if (touchedPaths(instr).some((path) => path[0] === part && path[1] === name)) {
      return instr.c;
    }
  }
  return instrs[0]?.c ?? "";
}

/** Characters that would end a header line or a cookie early. */
const UNSAFE_HEADER = /[\r\n\0]/;
const UNSAFE_COOKIE = /[\r\n\0;,\s]/;

/**
 * Writes the tree back into a request.
 *
 * A parameter the program named is taken out of the request wherever it was
 * and written again from the tree, so one it moved away is gone and one it
 * moved in arrives in the current contract's own style.
 */
export function closeEnvelope(
  envelope: DecodedEnvelope,
  template: readonly string[],
  pathValues: readonly string[],
  request: EnvelopeRequest,
  tree: Record<string, Json>,
): EnvelopeRequest {
  const named = new Map<ParamLocation, Set<string>>();
  for (const codec of [...envelope.old.values(), ...envelope.new.values()]) {
    const set = named.get(codec.in) ?? new Set<string>();
    set.add(codec.name);
    named.set(codec.in, set);
  }
  const codecFor = (location: ParamLocation, name: string): ParamCodec =>
    envelope.new.get(codecKey(location, name)) ??
    envelope.old.get(codecKey(location, name)) ?? {
      in: location,
      name,
      type: "string",
      ...FALLBACK[location],
    };
  const partOf = (location: ParamLocation) =>
    (tree[PART[location]] ?? {}) as Record<string, Json>;

  // Path: every parameter of the template has to have a value afterwards.
  let path = request.path;
  const pathNamed = named.get("path");
  if (pathNamed && pathNamed.size > 0) {
    const names = templateNames(template);
    const values = partOf("path");
    const filled = names.map((name, index) => {
      if (!pathNamed.has(name)) return pathValues[index] as string;
      const value = values[name];
      const changeId = writerOf(envelope.instrs, PART.path, name);
      if (value === undefined || value === null) {
        throw new TransformError(
          changeId,
          `path parameter ${name} was left without a value`,
        );
      }
      return encodeURIComponent(
        encodeValue(value, codecFor("path", name), changeId)[0] ?? "",
      );
    });
    let next = 0;
    path = template
      .map((segment) =>
        segment.replace(/\{[^{}]+\}/g, () => {
          const value = filled[next] ?? "";
          next += 1;
          return value;
        }),
      )
      .join("/");
  }

  // Query: untouched pairs keep their bytes and their order.
  let search = request.search;
  const queryNamed = named.get("query");
  if (queryNamed && queryNamed.size > 0) {
    const kept = queryPairs(request.search)
      .filter(
        (pair) =>
          !queryNamed.has(pair.key) &&
          ![...queryNamed].some(
            (name) => pair.key.startsWith(`${name}[`) && pair.key.endsWith("]"),
          ),
      )
      .map((pair) => pair.raw);
    const written: string[] = [];
    for (const [name, value] of Object.entries(partOf("query"))) {
      if (value === undefined) continue;
      const codec = codecFor("query", name);
      const changeId = writerOf(envelope.instrs, PART.query, name);
      if (
        codec.style === "deepObject" &&
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        !numberLike(value)
      ) {
        for (const [key, entry] of Object.entries(value as Record<string, Json>)) {
          written.push(
            `${encodeURIComponent(name)}[${encodeURIComponent(key)}]=${encodeURIComponent(text(entry, changeId, `query parameter ${name}`))}`,
          );
        }
        continue;
      }
      const parts = encodeValue(value, codec, changeId);
      const separator = codec.explode ? undefined : delimiterOf(codec);
      for (const part of parts) {
        const encoded =
          separator === undefined
            ? encodeURIComponent(part)
            : part
                .split(separator)
                .map(encodeURIComponent)
                .join(separator === " " ? "%20" : separator);
        written.push(`${encodeURIComponent(name)}=${encoded}`);
      }
    }
    search = [...kept, ...written].join("&");
  }

  // Headers: a named one is removed in every casing and written once.
  let headers = request.headers;
  const headerNamed = named.get("header");
  const cookieNamed = named.get("cookie");
  if ((headerNamed && headerNamed.size > 0) || (cookieNamed && cookieNamed.size > 0)) {
    const lowered = new Set([...(headerNamed ?? [])].map((name) => name.toLowerCase()));
    headers = request.headers.filter(([name]) => {
      const lower = name.toLowerCase();
      if (lowered.has(lower)) return false;
      return !(cookieNamed && cookieNamed.size > 0 && lower === "cookie");
    });
    for (const [name, value] of Object.entries(partOf("header"))) {
      if (value === undefined) continue;
      const changeId = writerOf(envelope.instrs, PART.header, name);
      const written = encodeValue(value, codecFor("header", name), changeId)[0] ?? "";
      if (UNSAFE_HEADER.test(written)) {
        throw new TransformError(changeId, `header ${name} would carry a line break`);
      }
      headers.push([name.toLowerCase(), written]);
    }
    if (cookieNamed && cookieNamed.size > 0) {
      const kept = cookiePairs(request.headers).filter(
        ([name]) => !cookieNamed.has(name),
      );
      const written: [string, string][] = [];
      for (const [name, value] of Object.entries(partOf("cookie"))) {
        if (value === undefined) continue;
        const changeId = writerOf(envelope.instrs, PART.cookie, name);
        for (const part of encodeValue(value, codecFor("cookie", name), changeId)) {
          if (UNSAFE_COOKIE.test(part)) {
            throw new TransformError(changeId, `cookie ${name} would carry a separator`);
          }
          written.push([name, part]);
        }
      }
      const all = [...kept, ...written];
      if (all.length > 0) {
        headers.push([
          "cookie",
          all.map(([name, value]) => `${name}=${value}`).join("; "),
        ]);
      }
    }
  }

  let body = request.body;
  if (envelope.body && tree[PART.body] !== undefined)
    body = stringifyJson(tree[PART.body]);
  // A body an instruction took away entirely is sent empty, never as it came.
  else if (envelope.body && body !== undefined && body !== "") body = "";

  return { path, search, headers, body };
}
