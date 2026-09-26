/**
 * The symbol maps the replay made before `@invariant-app/symbols` existed,
 * kept verbatim as the baseline `symbols.mts` compares the package against.
 * Nothing else imports this: the replay itself asks the package.
 *
 * - stripe-node: a schema is `Stripe.` and its name with each dot a
 *   namespace, wherever an interface with its last name is declared.
 * - stripe-python: `stripe.` and the name with each dot a module, wherever
 *   a top-level class with its last name is declared, then classes nested
 *   in those under a property's name.
 * - Stainless Python: a class by the schema's name, with `Param`, loosely,
 *   then the one class sharing at least 80% of its fields.
 * - stripe-go: the root package's type the name spells, where its wire names
 *   share at least 80% with the schema's properties.
 * - stripe-node's operations, from its resource files.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { OpenApiDocument } from "@invariant-app/contract";

type Schemas = Record<string, { properties?: Record<string, unknown> }>;

const schemasOf = (document: OpenApiDocument): Schemas =>
  ((
    (document as Record<string, unknown>)["components"] as
      | { schemas?: Schemas }
      | undefined
  )?.schemas ?? {}) as Schemas;

const pascal = (name: string) =>
  name
    .split("_")
    .filter(Boolean)
    .map((part) => (part[0] ?? "").toUpperCase() + part.slice(1))
    .join("");

const typeNameOf = (schema: string) => schema.split(".").map(pascal).join(".");

function declaredInterfaces(
  dir: string,
  found = new Set<string>(),
  depth = 0,
): Set<string> {
  if (depth > 4) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") {
      declaredInterfaces(path, found, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith(".d.ts")) {
      for (const match of readFileSync(path, "utf8").matchAll(/\binterface (\w+)/g)) {
        found.add(match[1] as string);
      }
    }
  }
  return found;
}

/** stripe-node's operations, from its resource files. */
export function legacyStripeNodeOperations(
  sdk: string,
  namespaced: boolean,
): Record<string, { type: string; method: string }> {
  const operations: Record<string, { type: string; method: string }> = {};
  const root = ["cjs/resources", "lib/resources", "esm/resources"]
    .map((dir) => join(sdk, dir))
    .find((dir) => existsSync(dir));
  if (!root) return operations;
  const walk = (dir: string, namespaces: string[]) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), [...namespaces, entry.name]);
        continue;
      }
      if (!entry.name.endsWith(".js")) continue;
      const resource = `${entry.name.slice(0, -3)}Resource`;
      const type = [...(namespaced ? ["Stripe"] : []), ...namespaces, resource].join(".");
      const text = readFileSync(join(dir, entry.name), "utf8");
      const pattern =
        /(\w+):\s*stripeMethod\(\{\s*method:\s*'(\w+)',\s*fullPath:\s*'([^']+)'/g;
      for (const match of text.matchAll(pattern)) {
        const key = `${(match[2] as string).toLowerCase()} ${match[3] as string}`;
        operations[key] ??= { type, method: match[1] as string };
      }
    }
  };
  walk(root, []);
  return operations;
}

/** stripe-node's types. */
export function legacyStripeNodeTypes(
  document: OpenApiDocument,
  sdk: string,
  namespaced: boolean,
): Record<string, string> {
  const types: Record<string, string> = {};
  const declared = declaredInterfaces(sdk);
  for (const schema of Object.keys(schemasOf(document))) {
    const name = typeNameOf(schema);
    if (declared.has(name.split(".").at(-1) ?? name)) {
      types[schema] = namespaced ? `Stripe.${name}` : name;
    }
  }
  return types;
}

function declaredClasses(
  dir: string,
  found = { top: new Set<string>(), nested: new Set<string>() },
  depth = 0,
): { top: Set<string>; nested: Set<string> } {
  if (depth > 4) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) declaredClasses(path, found, depth + 1);
    else if (entry.isFile() && entry.name.endsWith(".py")) {
      for (const match of readFileSync(path, "utf8").matchAll(/^( *)class (\w+)\b/gm)) {
        (match[1] === "" ? found.top : found.nested).add(match[2] as string);
      }
    }
  }
  return found;
}

function refOf(property: unknown): string | undefined {
  if (typeof property !== "object" || property === null) return undefined;
  const value = property as { $ref?: string; anyOf?: unknown[]; allOf?: unknown[] };
  if (value.$ref?.startsWith("#/components/schemas/")) {
    return value.$ref.slice("#/components/schemas/".length);
  }
  const choices = (value.anyOf ?? value.allOf ?? [])
    .map(refOf)
    .filter((ref) => ref !== undefined);
  return choices.length === 1 ? choices[0] : undefined;
}

const pythonTypeOf = (schema: string) => {
  const parts = schema.split(".");
  return ["stripe", ...parts.slice(0, -1), pascal(parts.at(-1) ?? "")].join(".");
};

/** stripe-python's types; `site` holds the `stripe` package. */
export function legacyStripePythonTypes(
  document: OpenApiDocument,
  site: string,
): Record<string, string> {
  const types: Record<string, string> = {};
  const components = schemasOf(document);
  const classes = declaredClasses(join(site, "stripe"));
  for (const schema of Object.keys(components)) {
    const name = pythonTypeOf(schema);
    if (classes.top.has(name.split(".").at(-1) ?? name)) types[schema] = name;
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const [parent, schema] of Object.entries(components)) {
      const holder = types[parent];
      if (!holder) continue;
      for (const [property, value] of Object.entries(schema.properties ?? {})) {
        const target = refOf(value);
        const nested = pascal(property);
        if (!target || types[target] || !classes.nested.has(nested)) continue;
        types[target] = `${holder}.${nested}`;
        grew = true;
      }
    }
  }
  return types;
}

interface PythonClass {
  name: string;
  qualified: string;
  fields: Set<string>;
}

function stainlessClasses(site: string, pkg: string): PythonClass[] {
  const found: PythonClass[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    const exported = existsSync(join(dir, "__init__.py"))
      ? readFileSync(join(dir, "__init__.py"), "utf8")
      : "";
    const packagePath = relative(site, dir).split("/").join(".");
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith(".py")) continue;
      const text = readFileSync(path, "utf8");
      const module =
        entry.name === "__init__.py"
          ? packagePath
          : `${packagePath}.${entry.name.slice(0, -3)}`;
      for (const match of text.matchAll(
        /^class (\w+)\b[^\n]*:\n((?:[ \t]+[^\n]*\n|\n)*)/gm,
      )) {
        const name = match[1] as string;
        const fields = new Set(
          [...(match[2] ?? "").matchAll(/^ {4}(\w+)\s*:/gm)].map(
            (field) => field[1] as string,
          ),
        );
        const reexported = new RegExp(`\\b${name}\\b`).test(exported);
        found.push({
          name,
          qualified: `${reexported ? packagePath : module}.${name}`,
          fields,
        });
      }
    }
  };
  walk(join(site, pkg, "types"));
  return found;
}

/** A Stainless Python release's types; `site` holds the package `pkg`. */
export function legacyStainlessTypes(
  document: OpenApiDocument,
  site: string,
  pkg: string,
): Record<string, string> {
  const classes = stainlessClasses(site, pkg);
  const byName = new Map<string, PythonClass>();
  for (const each of classes) if (!byName.has(each.name)) byName.set(each.name, each);
  const loose = (name: string) => name.replace(/_/g, "").toLowerCase();
  const byLoose = new Map<string, PythonClass[]>();
  for (const each of classes) {
    byLoose.set(loose(each.name), [...(byLoose.get(loose(each.name)) ?? []), each]);
  }
  const types: Record<string, string> = {};
  for (const [schema, definition] of Object.entries(schemasOf(document))) {
    const named =
      byName.get(schema) ??
      byName.get(`${schema}Param`) ??
      (byLoose.get(loose(schema))?.length === 1
        ? byLoose.get(loose(schema))?.[0]
        : undefined);
    if (named) {
      types[schema] = named.qualified;
      continue;
    }
    const properties = Object.keys(definition.properties ?? {});
    if (properties.length < 2) continue;
    let best: { share: number; classes: PythonClass[] } = { share: 0, classes: [] };
    for (const each of classes) {
      const shared = properties.filter((property) => each.fields.has(property)).length;
      const share = shared / new Set([...properties, ...each.fields]).size;
      if (share > best.share) best = { share, classes: [each] };
      else if (share === best.share) best.classes.push(each);
    }
    if (best.share >= 0.8 && best.classes.length === 1) {
      types[schema] = (best.classes[0] as PythonClass).qualified;
    }
  }
  return types;
}

/**
 * stripe-go's types, from each root-package struct's wire names (the
 * surface's fields with a `json` tag, keyed `Holder.Field`).
 */
export function legacyStripeGoTypes(
  document: OpenApiDocument,
  fields: Map<string, Set<string>>,
): Record<string, string> {
  const types: Record<string, string> = {};
  for (const [schema, definition] of Object.entries(schemasOf(document))) {
    const name = schema.split(".").map(pascal).join("");
    const declared = fields.get(name);
    const properties = Object.keys(definition.properties ?? {});
    if (!declared || properties.length === 0) continue;
    const shared = properties.filter((property) => declared.has(property)).length;
    if (shared / new Set([...properties, ...declared]).size >= 0.8) types[schema] = name;
  }
  return types;
}
