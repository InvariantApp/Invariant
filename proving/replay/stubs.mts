/**
 * Rig E, types for a stripe-python release that ships none.
 *
 * stripe-python before 7 declares no field: `Subscription` is a dictionary
 * whose keys come back as attributes at runtime, so the type checker finds
 * no declaration of `current_period_end` to follow references from, and a
 * Change to it reaches only what is read by name. The release was generated
 * from one OpenAPI specification all the same (`OPENAPI_VERSION` at its
 * tag), and that specification says what each of its classes holds.
 *
 * So a copy of the release is made with each class's fields declared from
 * that specification, the way stripe-python 7 declares them: a field a
 * schema lists becomes an annotation in the class that schema generated,
 * `current_period_end: int`. Nothing else changes, and the copy is only ever
 * read by the checker, never run. Methods, and any name the class already
 * defines, are left as the release wrote them.
 */
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenApiDocument } from "@invariant-app/contract";

/** A class stripe-python generated from a schema, and what its fields are. */
export interface ClassFields {
  /** The module the class is in, under the package: `api_resources/subscription.py`. */
  module: string;
  className: string;
  /** Field name to its annotation. */
  fields: Record<string, string>;
}

type Schema = {
  type?: string;
  nullable?: boolean;
  $ref?: string;
  anyOf?: Schema[];
  items?: Schema;
  properties?: Record<string, Schema>;
};

const KEYWORDS = new Set(
  (
    "False None True and as assert async await break class continue def del elif else except " +
    "finally for from global if import in is lambda nonlocal not or pass raise return try while with yield"
  ).split(" "),
);

const refName = (ref: string | undefined) =>
  ref?.startsWith("#/components/schemas/")
    ? ref.slice("#/components/schemas/".length)
    : undefined;

/** The annotation stripe-python 7 would write for a property, near enough for the checker. */
export function annotationOf(property: Schema, types: Record<string, string>): string {
  const classOf = (schema: Schema): string | undefined => {
    const name = refName(schema.$ref);
    return name && types[name] ? `"${types[name]}"` : undefined;
  };
  let inner: string;
  const choices = property.anyOf ?? [];
  if (property.$ref) {
    inner = classOf(property) ?? "Any";
  } else if (choices.length > 0) {
    // An expandable field is its id or the object: `anyOf: [string, $ref]`.
    const classes = choices.flatMap((choice) => {
      const found = classOf(choice);
      return found ? [found] : [];
    });
    const string = choices.some((choice) => choice.type === "string");
    inner =
      classes.length === 1 && choices.length === (string ? 2 : 1)
        ? string
          ? `Union[str, ${classes[0]}]`
          : (classes[0] as string)
        : "Any";
  } else {
    inner =
      property.type === "string"
        ? "str"
        : property.type === "integer"
          ? "int"
          : property.type === "boolean"
            ? "bool"
            : property.type === "number"
              ? "float"
              : property.type === "array"
                ? `List[${property.items ? annotationOf(property.items, types) : "Any"}]`
                : "Any";
  }
  return property.nullable && inner !== "Any" ? `Optional[${inner}]` : inner;
}

/**
 * Each class a specification's schemas generated in a stripe-python release
 * before 7, where `types` names it (`subscription` is `stripe.Subscription`,
 * in `api_resources/subscription.py`), with its fields' annotations.
 */
export function classFields(
  document: OpenApiDocument,
  types: Record<string, string>,
): ClassFields[] {
  const schemas =
    (
      (document as Record<string, unknown>)["components"] as
        | { schemas?: Record<string, Schema> }
        | undefined
    )?.schemas ?? {};
  // Only a class of its own: a nested one (`stripe.Subscription.AutomaticTax`)
  // is not in a release before 7 at all.
  const own = Object.fromEntries(
    Object.entries(types).filter(
      ([schema, type]) => type.split(".").length === schema.split(".").length + 1,
    ),
  );
  const found: ClassFields[] = [];
  for (const [schema, definition] of Object.entries(schemas)) {
    const type = own[schema];
    if (!type) continue;
    const fields: Record<string, string> = {};
    for (const [name, property] of Object.entries(definition.properties ?? {})) {
      if (!/^[A-Za-z_]\w*$/.test(name) || KEYWORDS.has(name)) continue;
      fields[name] = annotationOf(property, own);
    }
    if (Object.keys(fields).length === 0) continue;
    found.push({
      module: `api_resources/${schema.replaceAll(".", "/")}.py`,
      className: type.split(".").at(-1) as string,
      fields,
    });
  }
  return found;
}

/**
 * The class body of `className` in `text`, with `fields` declared at its top,
 * past any name the class already defines; the text unchanged where the
 * class is not there.
 */
export function withFields(
  text: string,
  className: string,
  fields: Record<string, string>,
): string {
  const header = new RegExp(
    `^class ${className}\\b[^:]*(?:\\([^)]*\\))?\\s*:[ \\t]*\\n`,
    "m",
  ).exec(text);
  if (!header) return text;
  // What a class body already defines, methods and attributes, at its own
  // indentation.
  const defined = new Set(
    [...text.matchAll(/^ {4}(?:async )?def\s+(\w+)|^ {4}(\w+)\s*[:=]/gm)].map(
      (match) => (match[1] ?? match[2]) as string,
    ),
  );
  const lines = Object.entries(fields)
    .filter(([name]) => !defined.has(name))
    .map(([name, annotation]) => `    ${name}: ${annotation}\n`);
  if (lines.length === 0) return text;
  const at = header.index + header[0].length;
  const body = `${text.slice(0, at)}${lines.join("")}${text.slice(at)}`;
  // The names the annotations use, after any `from __future__` import, which
  // has to come first.
  const imports = "import stripe\nfrom typing import Any, List, Optional, Union\n";
  const future = [...body.matchAll(/^from __future__ import [^\n]*\n/gm)].at(-1);
  const after = future ? (future.index ?? 0) + future[0].length : 0;
  return `${body.slice(0, after)}${imports}${body.slice(after)}`;
}

/**
 * A copy of the release in `site` with each class's fields declared, made
 * once into `into` and reused; `into` is then the release's directory for
 * the checker, in place of `site`.
 */
export function typedCopy(
  site: string,
  classes: readonly ClassFields[],
  into: string,
): string {
  const marker = join(into, ".invariant-typed");
  if (existsSync(marker)) return into;
  cpSync(join(site, "stripe"), join(into, "stripe"), { recursive: true });
  for (const { module, className, fields } of classes) {
    const path = join(into, "stripe", module);
    if (!existsSync(path)) continue;
    writeFileSync(path, withFields(readFileSync(path, "utf8"), className, fields));
  }
  writeFileSync(marker, "");
  return into;
}
