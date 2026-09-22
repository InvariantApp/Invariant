/**
 * A specification split across files, read as the one document it describes.
 *
 * Many providers keep their OpenAPI document in pieces, a file per schema or
 * per path, joined by relative `$ref`s such as `./schemas/Pet.yaml`. Every
 * part of this system reads one self-contained document, and a Change names a
 * schema by where it sits in that document, so the pieces are gathered here,
 * once, when the file is loaded.
 *
 * A referenced schema is placed among the document's named schemas, under the
 * name its reference gives it (`#/Pet` or `Pet.yaml` names it `Pet`), so a
 * Change can be scoped to it like any other. Anything else, a path item or a
 * parameter kept in its own file, is written in where it is referenced, which
 * is what the reference means.
 *
 * Only files are read, never URLs, and never outside the repository the
 * document sits in: a specification is input, and resolving a reference must
 * not become a way to read or fetch anything else. Documents that arrive over
 * the network never come through here; they are refused any external
 * reference at all.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { isJsonObject, type JsonObject, type JsonValue } from "@invariant-app/ir";
import { stringify as stringifyYaml } from "yaml";
import { DocumentTooLargeError, parseDocumentText } from "./parse.ts";

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleError";
  }
}

/** How many files one document may pull in. A real split specification has hundreds, not thousands. */
const MAX_FILES = 2000;

/** Keys under which the value is a schema, or a map or list of them. */
const SCHEMA_VALUE = new Set(["schema", "items", "additionalProperties", "not"]);
const SCHEMA_LIST = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_MAP = new Set(["properties", "patternProperties", "definitions", "$defs"]);

interface Target {
  file: string;
  /** JSON Pointer within the file, without the leading `#`. */
  pointer: string;
}

function parseText(path: string, text: string): JsonValue {
  try {
    return parseDocumentText(path, text);
  } catch (error) {
    if (error instanceof DocumentTooLargeError) throw new BundleError(error.message);
    throw error;
  }
}

function pointerKey(segment: string): string {
  return decodeURIComponent(segment).replaceAll("~1", "/").replaceAll("~0", "~");
}

function at(value: JsonValue, pointer: string, where: string): JsonValue {
  let node: JsonValue | undefined = value;
  for (const segment of pointer.split("/").slice(1)) {
    const key = pointerKey(segment);
    node = Array.isArray(node)
      ? node[Number(key)]
      : isJsonObject(node)
        ? node[key]
        : undefined;
    if (node === undefined) throw new BundleError(`${where} points at nothing`);
  }
  return node as JsonValue;
}

/** The repository the document lives in, which references may not leave. */
export function repositoryOf(path: string): string {
  let dir = dirname(resolve(path));
  for (;;) {
    if (existsSync(resolve(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return dirname(resolve(path));
    dir = parent;
  }
}

/** Whether a document refers to anything outside itself. */
export function refersOutside(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(refersOutside);
  if (!isJsonObject(value)) return false;
  const ref = value["$ref"];
  if (typeof ref === "string" && !ref.startsWith("#")) return true;
  return Object.values(value).some(refersOutside);
}

/**
 * The document at `path` with every reference to another file resolved into
 * it. A document that refers to no other file is returned as it was parsed.
 */
export async function bundleDocument(
  path: string,
  options: { root?: string } = {},
): Promise<JsonObject> {
  const entry = resolve(path);
  const root = resolve(options.root ?? repositoryOf(entry));
  const files = new Map<string, JsonValue>();

  const load = async (file: string, from: string): Promise<JsonValue> => {
    const cached = files.get(file);
    if (cached !== undefined) return cached;
    const inside = relative(root, file);
    if (inside.startsWith("..") || isAbsolute(inside)) {
      throw new BundleError(
        `${from} refers to ${file}, outside the repository at ${root}. A specification may only refer to files beside it.`,
      );
    }
    if (files.size >= MAX_FILES) {
      throw new BundleError(`${entry} refers to more than ${MAX_FILES} files`);
    }
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      throw new BundleError(`${from} refers to ${file}, which cannot be read`);
    }
    const value = parseText(file, text);
    files.set(file, value);
    return value;
  };

  const document = await load(entry, entry);
  if (!isJsonObject(document))
    throw new BundleError(`${entry} does not contain an OpenAPI document`);
  if (!refersOutside(document)) return document;

  const swagger = document["swagger"] === "2.0";
  const named: JsonObject = {};
  /** Where each target was placed, by `file#pointer`. */
  const placed = new Map<string, string>();
  const taken = new Set<string>(
    Object.keys(
      (swagger
        ? document["definitions"]
        : isJsonObject(document["components"])
          ? document["components"]["schemas"]
          : undefined) ?? {},
    ),
  );
  const home = swagger ? "#/definitions/" : "#/components/schemas/";

  const targetOf = (ref: string, file: string): Target => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) {
      throw new BundleError(
        `${file} refers to ${ref}. References are resolved from files, never fetched.`,
      );
    }
    const [path = "", fragment = ""] = ref.split("#", 2);
    return { file: path === "" ? file : resolve(dirname(file), path), pointer: fragment };
  };

  /** A name for a schema kept in another file, from the reference itself. */
  const nameFor = (target: Target): string => {
    const last = target.pointer
      .split("/")
      .filter((part) => part !== "")
      .at(-1);
    const base = (
      last ? pointerKey(last) : basename(target.file, extname(target.file))
    ).replace(/[^A-Za-z0-9_.-]+/g, "_");
    let name = base;
    for (let n = 2; taken.has(name); n += 1) name = `${base}_${n}`;
    taken.add(name);
    return name;
  };

  // Rewrites one value from `file`. `schema` says whether it sits where a
  // schema does, which decides whether a reference out of it is named or
  // written in place; `path` is where it sits in the entry document, for the
  // two places named schemas are kept.
  const visit = async (
    value: JsonValue,
    file: string,
    schema: boolean,
    stack: string[],
    path: string[],
  ): Promise<JsonValue> => {
    if (Array.isArray(value)) {
      const out: JsonValue[] = [];
      for (const item of value) out.push(await visit(item, file, schema, stack, []));
      return out;
    }
    if (!isJsonObject(value)) return value;

    const { $ref: ref, ...rest } = value;
    let siblings: JsonObject = {};
    if (typeof ref === "string" && Object.keys(rest).length > 0) {
      siblings = (await visit(rest, file, schema, stack, [])) as JsonObject;
    }
    if (typeof ref === "string") {
      const target = targetOf(ref, file);
      // Within the entry document a reference to its own parts stays as it is.
      if (target.file === entry) return { ...siblings, $ref: `#${target.pointer}` };
      const key = `${target.file}#${target.pointer}`;
      const content = async () =>
        at(await load(target.file, file), target.pointer, `${file}: ${ref}`);
      if (schema) {
        let name = placed.get(key);
        if (name === undefined) {
          const local = nameFor(target);
          name = `${home}${local}`;
          // Placed before its content is read, so a schema that contains
          // itself refers to the name rather than recursing forever.
          placed.set(key, name);
          named[local] = await visit(
            await content(),
            target.file,
            true,
            [...stack, key],
            [],
          );
        }
        return { ...siblings, $ref: name };
      }
      if (stack.includes(key)) {
        throw new BundleError(
          `${ref} in ${file} refers back to itself outside a schema, which cannot be written in place`,
        );
      }
      const inlined = await visit(
        await content(),
        target.file,
        false,
        [...stack, key],
        path,
      );
      return isJsonObject(inlined) ? { ...inlined, ...siblings } : inlined;
    }

    const holdsNamed =
      (path.length === 1 && path[0] === "components" && swagger === false) ||
      (path.length === 0 && swagger && file === entry);
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      const here = [...path, key];
      if (key === "example" || key === "examples") {
        // An illustration, kept as it is: it describes nothing on the wire.
        out[key] = child;
      } else if (SCHEMA_VALUE.has(key) || (schema && SCHEMA_LIST.has(key))) {
        out[key] = await visit(child, file, true, stack, []);
      } else if (
        isJsonObject(child) &&
        ((schema && SCHEMA_MAP.has(key)) ||
          (holdsNamed && key === (swagger ? "definitions" : "schemas")))
      ) {
        const map: JsonObject = {};
        for (const [name, member] of Object.entries(child)) {
          map[name] = await visit(member, file, true, stack, []);
        }
        out[key] = map;
      } else {
        // A value, a default or a constant is data even inside a schema.
        const data = ["enum", "const", "default"].includes(key);
        out[key] = await visit(
          child,
          file,
          schema && !data,
          stack,
          file === entry ? here : [],
        );
      }
    }
    return out;
  };

  const bundled = (await visit(document, entry, false, [], [])) as JsonObject;
  if (Object.keys(named).length > 0) {
    if (swagger) {
      bundled["definitions"] = {
        ...(isJsonObject(bundled["definitions"]) ? bundled["definitions"] : {}),
        ...named,
      };
    } else {
      const components = isJsonObject(bundled["components"]) ? bundled["components"] : {};
      components["schemas"] = {
        ...(isJsonObject(components["schemas"]) ? components["schemas"] : {}),
        ...named,
      };
      bundled["components"] = components;
    }
  }
  return bundled;
}

/**
 * The text to keep as a snapshot of the document at `path`: the file as it is
 * where it stands alone, and the document it assembles to where it refers to
 * other files, written in the same format. A snapshot has to keep describing
 * the API after the files it was assembled from have moved on.
 */
export async function standaloneText(path: string): Promise<string> {
  const raw = await readFile(path, "utf8");
  if (!refersOutside(parseText(path, raw))) return raw;
  const assembled = await bundleDocument(path);
  return extname(path).toLowerCase() === ".json"
    ? `${JSON.stringify(assembled, null, 2)}\n`
    : stringifyYaml(assembled);
}
