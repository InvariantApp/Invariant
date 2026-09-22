/**
 * The independent oracle: is this body what the contract says?
 *
 * Rig C's verdicts come from here, so it deliberately shares nothing with the
 * code under test. It does not use `@invariant-app/contract`'s resolver or the
 * verifier's validator; it uses Ajv, which follows `$ref` and merges `allOf` by
 * its own reading of JSON Schema. If the product and this oracle disagree about
 * what a schema means, a traffic run fails and says so, which is the point. A
 * rig graded by the code it is testing can only ever agree with itself.
 */
import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import formats from "ajv-formats";
import qs from "qs";

// ajv-formats is CommonJS with a default export, which Node's ESM loader hands
// over as the module object.
const addFormats = ((formats as unknown as { default?: unknown }).default ??
  formats) as unknown as (ajv: Ajv) => void;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface OracleViolation {
  /** Where in the body, as a JSON Pointer. */
  pointer: string;
  message: string;
}

/**
 * OpenAPI 3.0 schemas are not quite JSON Schema. `nullable` has no meaning to
 * a JSON Schema validator, and `exclusiveMinimum` is a flag rather than a
 * bound. Rewritten here, once, into the JSON Schema they mean. OpenAPI 3.1
 * schemas are JSON Schema 2020-12 already and are left alone.
 */
function fromOpenApi30(value: Json): Json {
  if (Array.isArray(value)) return value.map(fromOpenApi30);
  if (!isObject(value)) return value;
  const out: JsonObject = {};
  for (const [key, child] of Object.entries(value)) out[key] = fromOpenApi30(child);

  if (out["nullable"] === true) {
    delete out["nullable"];
    if (Array.isArray(out["enum"]) && !out["enum"].includes(null)) {
      out["enum"] = [...out["enum"], null];
    }
    if (typeof out["type"] === "string") {
      out["type"] = [out["type"], "null"];
    } else if (out["type"] === undefined) {
      // A nullable schema with no type of its own, a reference or a union
      // such as GitHub's `anyOf: [simple-user, enterprise]`: either what it
      // describes, or null.
      const { description, ...rest } = out;
      return {
        ...(description === undefined ? {} : { description }),
        anyOf: [rest, { type: "null" }],
      };
    }
  } else if (out["nullable"] === false) {
    delete out["nullable"];
  }
  for (const [flag, bound] of [
    ["exclusiveMinimum", "minimum"],
    ["exclusiveMaximum", "maximum"],
  ] as const) {
    if (out[flag] === true && typeof out[bound] === "number") {
      out[flag] = out[bound];
      delete out[bound];
    } else if (out[flag] === false) {
      delete out[flag];
    }
  }
  return out;
}

/** Follows a local `$ref` to an OpenAPI object that is not itself a schema. */
function follow(document: JsonObject, value: Json | undefined): Json | undefined {
  let current = value;
  for (let hops = 0; hops < 16 && isObject(current); hops += 1) {
    const ref = current["$ref"];
    if (typeof ref !== "string" || !ref.startsWith("#/")) return current;
    let target: Json | undefined = document;
    for (const raw of ref.slice(2).split("/")) {
      const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
      target = isObject(target) ? target[key] : undefined;
    }
    current = target;
  }
  return current;
}

const escapePointer = (segment: string): string =>
  segment.replaceAll("~", "~0").replaceAll("/", "~1");

const JSON_MEDIA = /^application\/(?:[\w.+-]*\+)?json$/i;
const FORM_MEDIA = /^application\/x-www-form-urlencoded$/i;

/** What a request carries outside its body, as the mock received it. */
export interface RequestParts {
  url: URL;
  headers: Headers;
  /** Path parameter values by name, as the route matched them. */
  path: Record<string, string>;
}

export interface OperationRef {
  method: string;
  path: string;
}

export class Oracle {
  readonly #document: JsonObject;
  readonly #ajv: Ajv | Ajv2020;
  /**
   * The same contract, for values that arrive as text: parameters and form
   * fields. Coercion is what a server does with `limit=10` before it checks
   * it, and without it every number in a query string would read as wrong.
   */
  readonly #coercing: Ajv | Ajv2020;
  readonly #compiled = new Map<string, ValidateFunction | undefined>();

  constructor(document: JsonObject) {
    const openapi = String(document["openapi"] ?? "");
    const is31 = openapi.startsWith("3.1");
    this.#document = (is31 ? document : fromOpenApi30(document)) as JsonObject;
    // A format no validator knows, such as GitHub's `repo.nwo`, is an
    // annotation under JSON Schema and asserts nothing, so it is ignored
    // without a warning per schema compiled.
    const options = {
      strict: false,
      allErrors: true,
      validateFormats: true,
      logger: { log: () => {}, warn: () => {}, error: console.error },
    } as const;
    this.#ajv = is31 ? new Ajv2020(options) : new Ajv(options);
    addFormats(this.#ajv as Ajv);
    // The whole document is one schema resource, so every `$ref` in it is
    // resolved by Ajv, in Ajv's own way.
    this.#ajv.addSchema(this.#document as object, "contract");
    const coercing = { ...options, coerceTypes: "array" } as const;
    this.#coercing = is31 ? new Ajv2020(coercing) : new Ajv(coercing);
    addFormats(this.#coercing as Ajv);
    this.#coercing.addSchema(this.#document as object, "contract");
  }

  /** Where the JSON schema for a request or response body lives, if it has one. */
  #pointerFor(
    operation: OperationRef,
    where: { status?: string; form?: boolean },
  ): string | undefined {
    const paths = this.#document["paths"];
    const item = isObject(paths) ? paths[operation.path] : undefined;
    const method = operation.method.toLowerCase();
    const op = isObject(item) ? item[method] : undefined;
    if (!isObject(op)) return undefined;

    const base = `/paths/${escapePointer(operation.path)}/${method}`;
    if (where.status === undefined) {
      const body = op["requestBody"];
      const resolved = follow(this.#document, body);
      const content = isObject(resolved) ? resolved["content"] : undefined;
      if (!isObject(content)) return undefined;
      const media = Object.keys(content).find((type) =>
        (where.form ? FORM_MEDIA : JSON_MEDIA).test(type),
      );
      if (!media || !isObject(content[media]) || content[media]["schema"] === undefined) {
        return undefined;
      }
      // A requestBody behind a reference lives at the reference's target.
      const holder =
        isObject(body) && typeof body["$ref"] === "string"
          ? body["$ref"].slice(1)
          : `${base}/requestBody`;
      return `${holder}/content/${escapePointer(media)}/schema`;
    }

    const responses = op["responses"];
    if (!isObject(responses)) return undefined;
    const status =
      where.status in responses
        ? where.status
        : `${where.status[0]}XX` in responses
          ? `${where.status[0]}XX`
          : "default" in responses
            ? "default"
            : undefined;
    if (status === undefined) return undefined;
    const response = responses[status];
    const resolved = follow(this.#document, response);
    const content = isObject(resolved) ? resolved["content"] : undefined;
    if (!isObject(content)) return undefined;
    const media = Object.keys(content).find((type) => JSON_MEDIA.test(type));
    if (!media || !isObject(content[media]) || content[media]["schema"] === undefined) {
      return undefined;
    }
    const holder =
      isObject(response) && typeof response["$ref"] === "string"
        ? response["$ref"].slice(1)
        : `${base}/responses/${escapePointer(status)}`;
    return `${holder}/content/${escapePointer(media)}/schema`;
  }

  #validator(pointer: string, coerce = false): ValidateFunction | undefined {
    const key = `${coerce ? "text" : "json"} ${pointer}`;
    if (!this.#compiled.has(key)) {
      try {
        const ajv = coerce ? this.#coercing : this.#ajv;
        this.#compiled.set(key, ajv.compile({ $ref: `contract#${pointer}` }));
      } catch {
        // A schema Ajv itself cannot compile: reported as unjudgeable by the
        // caller rather than counted as a pass.
        this.#compiled.set(key, undefined);
      }
    }
    return this.#compiled.get(key);
  }

  /**
   * Violations of the request body schema, or undefined when there is no
   * schema to judge against or the oracle cannot compile it. A form body is
   * judged as the fields it decodes to, with text coerced as a server would.
   */
  request(
    operation: OperationRef,
    body: unknown,
    media: "json" | "form" = "json",
  ): OracleViolation[] | undefined {
    const pointer = this.#pointerFor(operation, { form: media === "form" });
    return pointer === undefined
      ? undefined
      : this.#judge(pointer, body, media === "form");
  }

  /**
   * Violations of the operation's declared parameters: a required one missing,
   * or one whose value its schema does not allow. Decoded here, by the
   * rules OpenAPI states for each style, and not by the code under test.
   */
  parameters(operation: OperationRef, parts: RequestParts): OracleViolation[] {
    const violations: OracleViolation[] = [];
    const paths = this.#document["paths"];
    const item = isObject(paths) ? paths[operation.path] : undefined;
    const method = operation.method.toLowerCase();
    const op = isObject(item) ? item[method] : undefined;
    if (!isObject(item) || !isObject(op)) return violations;
    const base = `/paths/${escapePointer(operation.path)}`;
    const entries: { pointer: string; parameter: JsonObject }[] = [];
    const collect = (list: Json | undefined, at: string) => {
      if (!Array.isArray(list)) return;
      list.forEach((entry, index) => {
        const resolved = follow(this.#document, entry);
        if (!isObject(resolved)) return;
        const holder =
          isObject(entry) && typeof entry["$ref"] === "string"
            ? entry["$ref"].slice(1)
            : `${at}/parameters/${index}`;
        const same = (other: { parameter: JsonObject }) =>
          other.parameter["in"] === resolved["in"] &&
          String(other.parameter["name"]).toLowerCase() ===
            String(resolved["name"]).toLowerCase();
        const existing = entries.findIndex(same);
        if (existing !== -1) entries.splice(existing, 1);
        entries.push({ pointer: `${holder}/schema`, parameter: resolved });
      });
    };
    collect(item["parameters"], base);
    collect(op["parameters"], `${base}/${method}`);

    const cookies = new Map<string, string>();
    for (const part of (parts.headers.get("cookie") ?? "").split(";")) {
      const equals = part.indexOf("=");
      if (equals > 0)
        cookies.set(part.slice(0, equals).trim(), part.slice(equals + 1).trim());
    }
    const query = parts.url.searchParams;

    for (const { pointer, parameter } of entries) {
      const name = String(parameter["name"]);
      const location = parameter["in"];
      if (parameter["content"] !== undefined || parameter["schema"] === undefined)
        continue;
      const schema = follow(this.#document, parameter["schema"]);
      const type = isObject(schema) ? schema["type"] : undefined;
      const style = String(
        parameter["style"] ??
          (location === "query" || location === "cookie" ? "form" : "simple"),
      );
      const explode =
        typeof parameter["explode"] === "boolean"
          ? parameter["explode"]
          : style === "form";
      const delimiter =
        style === "spaceDelimited" ? " " : style === "pipeDelimited" ? "|" : ",";
      let value: unknown;
      if (location === "query") {
        if (style === "deepObject") {
          value = (
            qs.parse(parts.url.search.slice(1), { depth: 0 }) as Record<string, unknown>
          )[name];
        } else if (type === "array") {
          const all = query.getAll(name);
          value = all.length === 0 ? undefined : explode ? all : all[0]?.split(delimiter);
        } else {
          value = query.has(name) ? query.get(name) : undefined;
        }
      } else if (location === "header") {
        const text = parts.headers.get(name);
        value =
          text === null
            ? undefined
            : type === "array"
              ? text.split(",").map((entry) => entry.trim())
              : text;
      } else if (location === "cookie") {
        value = cookies.get(name);
      } else if (location === "path") {
        const text = parts.path[name];
        value = text === undefined ? undefined : decodeURIComponent(text);
      } else {
        continue;
      }
      if (value === undefined) {
        if (parameter["required"] === true || location === "path") {
          violations.push({
            pointer: `${location}/${name}`,
            message: "is required and was not sent",
          });
        }
        continue;
      }
      const found = this.#judge(pointer, value, true);
      for (const entry of found ?? []) {
        violations.push({
          pointer: `${location}/${name}${entry.pointer === "/" ? "" : entry.pointer}`,
          message: entry.message,
        });
      }
    }
    return violations;
  }

  response(
    operation: OperationRef,
    status: number,
    body: unknown,
  ): OracleViolation[] | undefined {
    const pointer = this.#pointerFor(operation, { status: String(status) });
    return pointer === undefined ? undefined : this.#judge(pointer, body);
  }

  #judge(pointer: string, body: unknown, coerce = false): OracleViolation[] | undefined {
    const validate = this.#validator(pointer, coerce);
    if (!validate) return undefined;
    if (validate(body)) return [];
    return (validate.errors ?? []).map((error) => ({
      pointer: error.instancePath || "/",
      message: error.message ?? error.keyword,
    }));
  }
}
