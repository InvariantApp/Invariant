/**
 * The independent oracle: is this body what the contract says?
 *
 * Rig C's verdicts come from here, so it deliberately shares nothing with the
 * code under test. It does not use `@invariant/contract`'s resolver or the
 * verifier's validator; it uses Ajv, which follows `$ref` and merges `allOf` by
 * its own reading of JSON Schema. If the product and this oracle disagree about
 * what a schema means, a traffic run fails and says so, which is the point. A
 * rig graded by the code it is testing can only ever agree with itself.
 */
import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import formats from "ajv-formats";

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
    if (typeof out["type"] === "string") out["type"] = [out["type"], "null"];
    if (Array.isArray(out["enum"]) && !out["enum"].includes(null)) {
      out["enum"] = [...out["enum"], null];
    }
    if (out["type"] === undefined && out["$ref"] !== undefined) {
      // A nullable reference: either the thing referred to, or null.
      const ref = out["$ref"];
      delete out["$ref"];
      out["anyOf"] = [{ $ref: ref }, { type: "null" }];
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

export interface OperationRef {
  method: string;
  path: string;
}

export class Oracle {
  readonly #document: JsonObject;
  readonly #ajv: Ajv | Ajv2020;
  readonly #compiled = new Map<string, ValidateFunction | undefined>();

  constructor(document: JsonObject) {
    const openapi = String(document["openapi"] ?? "");
    const is31 = openapi.startsWith("3.1");
    this.#document = (is31 ? document : fromOpenApi30(document)) as JsonObject;
    this.#ajv = is31
      ? new Ajv2020({ strict: false, allErrors: true, validateFormats: true })
      : new Ajv({ strict: false, allErrors: true, validateFormats: true });
    addFormats(this.#ajv as Ajv);
    // The whole document is one schema resource, so every `$ref` in it is
    // resolved by Ajv, in Ajv's own way.
    this.#ajv.addSchema(this.#document as object, "contract");
  }

  /** Where the JSON schema for a request or response body lives, if it has one. */
  #pointerFor(operation: OperationRef, where: { status?: string }): string | undefined {
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
      const media = Object.keys(content).find((type) => JSON_MEDIA.test(type));
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

  #validator(pointer: string): ValidateFunction | undefined {
    if (!this.#compiled.has(pointer)) {
      try {
        this.#compiled.set(pointer, this.#ajv.compile({ $ref: `contract#${pointer}` }));
      } catch {
        // A schema Ajv itself cannot compile: reported as unjudgeable by the
        // caller rather than counted as a pass.
        this.#compiled.set(pointer, undefined);
      }
    }
    return this.#compiled.get(pointer);
  }

  /**
   * Violations of the request body schema, or undefined when there is no
   * schema to judge against or the oracle cannot compile it.
   */
  request(operation: OperationRef, body: unknown): OracleViolation[] | undefined {
    const pointer = this.#pointerFor(operation, {});
    return pointer === undefined ? undefined : this.#judge(pointer, body);
  }

  response(
    operation: OperationRef,
    status: number,
    body: unknown,
  ): OracleViolation[] | undefined {
    const pointer = this.#pointerFor(operation, { status: String(status) });
    return pointer === undefined ? undefined : this.#judge(pointer, body);
  }

  #judge(pointer: string, body: unknown): OracleViolation[] | undefined {
    const validate = this.#validator(pointer);
    if (!validate) return undefined;
    if (validate(body)) return [];
    return (validate.errors ?? []).map((error) => ({
      pointer: error.instancePath || "/",
      message: error.message ?? error.keyword,
    }));
  }
}
