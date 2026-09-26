/**
 * The classes a Python release declares, named the way its consumers import
 * them.
 *
 * Generated Python is regular enough to read by indentation: a class runs to
 * the next line at or left of its own margin, and a field is an annotated
 * name at the first margin inside it. Docstrings are blanked first, since a
 * line of prose such as `    Example:` otherwise reads as a field. A class
 * also has the fields of the classes it extends, as a Stainless response
 * model that extends another does.
 *
 * A class is named by the shortest path a consumer can import it by, public
 * names first, through what each package re-exports: stripe-python's
 * `stripe/_customer.py` declares `Customer` and `stripe/__init__.py`
 * re-exports it, so it is `stripe.Customer`; stripe 5's `checkout.Session`
 * lives in `stripe/api_resources/checkout/session.py` and is still
 * `stripe.checkout.Session`, because `stripe` star-imports `api_resources`,
 * which binds `checkout`. An ordinary module importing a class for its own
 * use does not re-export it; a package's `__init__`, a redundant alias
 * (`from .x import A as A`) and `__all__` do, which is the rule type checkers
 * apply to a typed package.
 *
 * Where a release keeps its models in `types` or `models` packages, as
 * Stainless, Speakeasy, Fern and openapi-generator all do, only classes in
 * those are models; a client's page class or a CLI's argument class has
 * fields too, and is no schema's type.
 */
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { calledNames, callSites, requestsIn, type Unit } from "../calls.ts";
import type { CallSite, Declaration } from "../types.ts";
import { filesUnder, textOf } from "./files.ts";

interface ClassSource {
  name: string;
  /** The base classes as written, `BaseModel`, `TypedDict`, `.foo.Bar`. */
  bases: string[];
  indent: number;
  /** Enclosing class, for a nested one. */
  parent?: ClassSource;
  body: string[];
  bodyIndent: number;
}

type Binding =
  | { kind: "class"; id: string }
  | { kind: "module"; module: string; exported: boolean }
  | { kind: "from"; module: string; name: string; exported: boolean };

interface ModuleSource {
  module: string;
  isPackage: boolean;
  /** Names bound at the module's top level. */
  bindings: Map<string, Binding>;
  /** Modules star-imported, in order. */
  stars: string[];
  /** `__all__`, where the module sets it. */
  all?: Set<string>;
}

/** Replaces every triple-quoted string's text with spaces, keeping its line breaks. */
export function blankDocstrings(text: string): string {
  return text.replace(/("""|''')[\s\S]*?\1/g, (match) => match.replace(/[^\n]/g, " "));
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** How many brackets a line opens, less those it closes, outside its strings. */
const depthOf = (line: string): number => {
  const code = line.replace(/(["'])(?:\\.|(?!\1).)*\1/g, "").replace(/#.*$/, "");
  return (code.match(/[([{]/g) ?? []).length - (code.match(/[)\]}]/g) ?? []).length;
};

/**
 * The statement starting at `index`, through its continuation lines and any
 * block it opens: everything up to the next line back at `margin` or left of
 * it, outside brackets, so a signature's closing `) -> Foo:` does not end it.
 */
function statementAt(lines: string[], index: number, margin: number): string {
  const parts = [lines[index] as string];
  let depth = depthOf(lines[index] as string);
  for (let next = index + 1; next < lines.length; next += 1) {
    const line = lines[next] as string;
    if (depth <= 0 && line.trim() !== "" && indentOf(line) <= margin) break;
    parts.push(line);
    depth += depthOf(line);
  }
  return parts.join("\n");
}

function classesIn(lines: string[]): ClassSource[] {
  const found: ClassSource[] = [];
  const open: ClassSource[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = indentOf(line);
    while (open.length > 0 && indent <= (open.at(-1) as ClassSource).indent) open.pop();
    if (!/^\s*class\s/.test(line)) continue;
    // The header, with bases that may run over several lines.
    let last = index;
    for (let depth = depthOf(line); depth > 0 && last + 1 < lines.length; ) {
      last += 1;
      depth += depthOf(lines[last] as string);
    }
    const header = lines.slice(index, last + 1).join(" ");
    const match = /^\s*class\s+(\w+)\s*(?:\(([^)]*)\))?/.exec(header);
    if (!match) continue;
    const parent = open.at(-1);
    // A class inside a function is nobody's to import.
    if (indent > 0 && parent === undefined) continue;
    if (parent && indent !== parent.bodyIndent) continue;
    let end = last + 1;
    let bodyIndent = -1;
    while (end < lines.length) {
      const next = lines[end] as string;
      if (next.trim() !== "" && !next.trimStart().startsWith("#")) {
        const at = indentOf(next);
        if (at <= indent) break;
        if (bodyIndent < 0) bodyIndent = at;
      }
      end += 1;
    }
    const bases = (match[2] ?? "")
      .split(",")
      .map((base) => base.trim().replace(/\[.*$/, ""))
      .filter((base) => base !== "" && !base.includes("="));
    const source: ClassSource = {
      name: match[1] as string,
      bases,
      indent,
      ...(parent ? { parent } : {}),
      body: lines.slice(last + 1, end),
      bodyIndent,
    };
    found.push(source);
    open.push(source);
    // The header's own continuation lines hold no class, and its closing
    // `):` at the margin must not read as the end of the class.
    index = last;
  }
  return found;
}

const STRING = /["']([^"']*)["']/g;

/** Statements that end in a colon at a class's margin and are no field: `else:`, `try:`. */
const KEYWORDS = new Set([
  "if",
  "elif",
  "else",
  "try",
  "except",
  "finally",
  "for",
  "while",
  "with",
  "match",
  "case",
]);

/** The wire names and pinned values a class body records for its own fields. */
function fieldsOf(source: ClassSource): {
  fields: string[];
  constants: Record<string, string>;
} {
  const constants: Record<string, string> = {};
  const margin = source.bodyIndent;
  const body = source.body;
  const annotated: string[] = [];
  let mapped: string[] | undefined;
  for (let index = 0; index < body.length; index += 1) {
    const line = body[index] as string;
    if (line.trim() === "" || indentOf(line) !== margin) continue;
    const statement = statementAt(body, index, margin);
    // Stripe records each class's tag as data, `OBJECT_NAME = "invoice"`.
    const tag = /^\s*OBJECT_NAME\b[^=\n]*=\s*["']([^"']+)["']/.exec(statement);
    if (tag) constants["object"] ??= tag[1] as string;
    // openapi-generator's older Python records each field's wire name in a
    // map, and its pydantic one lists them.
    const map = /^\s*attribute_map\b[^=\n]*=\s*\{([\s\S]*?)\}/.exec(statement);
    if (map) {
      mapped = [...(map[1] as string).matchAll(/:\s*["']([^"']+)["']/g)].map(
        (entry) => entry[1] as string,
      );
      continue;
    }
    const listed = /^\s*__properties\b[^=\n]*=\s*\[([\s\S]*?)\]/.exec(statement);
    if (listed) {
      mapped ??= [...(listed[1] as string).matchAll(STRING)].map(
        (entry) => entry[1] as string,
      );
      continue;
    }
    const field = /^\s*(\w+)\s*:[ \t]*(\S[\s\S]*)$/.exec(statement);
    if (!field) continue;
    const name = field[1] as string;
    const annotation = field[2] as string;
    if (
      KEYWORDS.has(name) ||
      name.startsWith("_") ||
      name === "model_config" ||
      /\bClassVar\b/.test(annotation)
    ) {
      continue;
    }
    // Pydantic's `Field(alias=...)`, Stainless's `FieldInfo(alias=...)` and
    // `PropertyInfo(alias=...)`, Fern's `FieldMetadata(alias=...)`.
    const alias = /\balias\s*=\s*["']([^"']+)["']/.exec(annotation)?.[1];
    const wire = alias ?? name;
    annotated.push(wire);
    const pinned =
      /^(?:(?:Required|NotRequired|ReadOnly)\[\s*)?Literal\[\s*["']([^"']+)["']\s*\]/.exec(
        annotation.trim(),
      );
    if (pinned) constants[wire] = pinned[1] as string;
  }
  return { fields: mapped ?? annotated, constants };
}

/**
 * The unions and other aliases a module names at its margin, as Stainless's
 * `ContentBlock: TypeAlias = Union[...]`.
 */
function aliasesIn(text: string): string[] {
  return [
    ...text.matchAll(
      /^([A-Z]\w*)\s*(?::\s*TypeAlias\s*)?=\s*(?:Union|Annotated|Literal|Optional|List|Dict|TypeAliasType)\b/gm,
    ),
  ].map((match) => match[1] as string);
}

/** Resolves a relative `from` target against the module it appears in. */
function absolute(module: string, isPackage: boolean, target: string): string {
  const dots = /^\.*/.exec(target)?.[0].length ?? 0;
  if (dots === 0) return target;
  const parts = module.split(".");
  // In a package's `__init__`, one dot is the package itself.
  const base = isPackage ? parts : parts.slice(0, -1);
  const up = base.slice(0, base.length - (dots - 1));
  const rest = target.slice(dots);
  return [...up, ...(rest ? [rest] : [])].join(".");
}

function bindingsOf(
  module: string,
  isPackage: boolean,
  text: string,
  classes: ClassSource[],
): Pick<ModuleSource, "bindings" | "stars" | "all"> {
  const bindings = new Map<string, Binding>();
  const stars: string[] = [];
  const listed = /^__all__\s*(?::[^=\n]*)?=\s*[[(]([\s\S]*?)[\])]/m.exec(text);
  const all = listed
    ? new Set([...(listed[1] as string).matchAll(STRING)].map((m) => m[1] as string))
    : undefined;
  const exported = (name: string, alias?: string) =>
    isPackage || alias === name || (all?.has(alias ?? name) ?? false);
  // Only imports at the margin: one under `if TYPE_CHECKING:` binds nothing
  // a consumer can import at run time.
  for (const match of text.matchAll(
    /^from\s+([\w.]+)\s+import\s+(\([^)]*\)|[^\n]*(?:\\\n[^\n]*)*)/gm,
  )) {
    const from = absolute(module, isPackage, match[1] as string);
    const names = (match[2] as string).replace(/[()\\]/g, " ").replace(/#[^\n]*/g, "");
    for (const part of names.split(",")) {
      const words = part.trim().split(/\s+/);
      const name = words[0];
      if (!name) continue;
      if (name === "*") {
        stars.push(from);
        continue;
      }
      const alias = words[1] === "as" ? words[2] : undefined;
      bindings.set(alias ?? name, {
        kind: "from",
        module: from,
        name,
        exported: exported(name, alias),
      });
    }
  }
  for (const match of text.matchAll(/^import\s+([^\n#]+)/gm)) {
    for (const part of (match[1] as string).split(",")) {
      const words = part.trim().split(/\s+/);
      const target = words[0];
      if (!target) continue;
      if (words[1] === "as" && words[2]) {
        bindings.set(words[2], {
          kind: "module",
          module: target,
          exported: exported(target.split(".").at(-1) as string, words[2]),
        });
      } else {
        const head = target.split(".")[0] as string;
        bindings.set(head, { kind: "module", module: head, exported: false });
      }
    }
  }
  // Speakeasy and Fern export lazily: a package's `__init__` maps each name
  // to the module it is imported from on first use, as data.
  const lazy = /^_dynamic_imports\b[^=\n]*=\s*\{([\s\S]*?)^\}/m.exec(text);
  for (const entry of (lazy?.[1] ?? "").matchAll(
    /["'](\w+)["']\s*:\s*["']([\w.]+)["']/g,
  )) {
    const name = entry[1] as string;
    if (bindings.has(name)) continue;
    const target = absolute(module, isPackage, entry[2] as string);
    // `"v2": ".v2"` is the submodule itself.
    bindings.set(
      name,
      entry[2] === `.${name}`
        ? { kind: "module", module: target, exported: true }
        : { kind: "from", module: target, name, exported: true },
    );
  }
  // A module's own classes and aliases, over anything imported by their name.
  for (const each of classes) {
    if (each.parent === undefined) {
      bindings.set(each.name, { kind: "class", id: `${module}:${each.name}` });
    }
  }
  for (const name of aliasesIn(text)) {
    bindings.set(name, { kind: "class", id: `${module}:${name}` });
  }
  return { bindings, stars, ...(all ? { all } : {}) };
}

/** Whether a consumer can import a name through this binding. */
const isPublic = (binding: Binding): boolean =>
  binding.kind === "class" || binding.exported;

class Namespaces {
  private readonly memo = new Map<string, Map<string, Binding>>();
  private readonly children = new Map<string, string[]>();
  private readonly modules: Map<string, ModuleSource>;

  constructor(modules: Map<string, ModuleSource>) {
    this.modules = modules;
    // Every package on the way to a module, namespace packages included.
    const seen = new Set<string>();
    for (const module of modules.keys()) {
      const parts = module.split(".");
      for (let at = parts.length; at >= 2; at -= 1) {
        const child = parts.slice(0, at).join(".");
        if (seen.has(child)) break;
        seen.add(child);
        const parent = parts.slice(0, at - 1).join(".");
        this.children.set(parent, [
          ...(this.children.get(parent) ?? []),
          parts[at - 1] as string,
        ]);
      }
    }
  }

  has(module: string): boolean {
    return this.modules.has(module) || this.children.has(module);
  }

  /**
   * Every name a module's namespace holds: its submodules, what its star
   * imports bring in, what it imports and what it defines.
   */
  of(module: string, active = new Set<string>()): Map<string, Binding> {
    const known = this.memo.get(module);
    if (known) return known;
    const source = this.modules.get(module);
    const names = new Map<string, Binding>();
    // A namespace package, with no `__init__`, still holds its submodules.
    if ((!source && !this.children.has(module)) || active.has(module)) return names;
    active.add(module);
    for (const child of this.children.get(module) ?? []) {
      names.set(child, { kind: "module", module: `${module}.${child}`, exported: true });
    }
    if (!source) {
      active.delete(module);
      this.memo.set(module, names);
      return names;
    }
    for (const star of source.stars) {
      const exported = this.modules.get(star)?.all;
      for (const [name, binding] of this.of(star, active)) {
        if (exported ? !exported.has(name) : name.startsWith("_")) continue;
        // A name a star import brings in is re-exported by the importer.
        names.set(
          name,
          binding.kind === "class" ? binding : { ...binding, exported: true },
        );
      }
    }
    for (const [name, binding] of source.bindings) names.set(name, binding);
    active.delete(module);
    this.memo.set(module, names);
    return names;
  }

  /** What a binding finally names: a class, a module, or nothing in this release. */
  resolve(binding: Binding, hops = 0): Binding | undefined {
    if (hops > 16) return undefined;
    if (binding.kind !== "from") return binding;
    const submodule = `${binding.module}.${binding.name}`;
    if (this.modules.has(submodule))
      return { kind: "module", module: submodule, exported: true };
    const next = this.of(binding.module).get(binding.name);
    return next ? this.resolve(next, hops + 1) : undefined;
  }

  /** The class a name used in a module refers to, as `Base` or `._models.Base`. */
  classOf(module: string, name: string): string | undefined {
    const [head, ...rest] = name.split(".");
    let binding = head ? this.of(module).get(head) : undefined;
    for (const part of rest) {
      const target = binding ? this.resolve(binding) : undefined;
      if (target?.kind !== "module") return undefined;
      binding = this.of(target.module).get(part);
    }
    const target = binding ? this.resolve(binding) : undefined;
    return target?.kind === "class" ? target.id : undefined;
  }
}

export interface PythonRelease {
  declarations: Declaration[];
  calls: CallSite[];
  /** The top-level packages read. */
  packages: string[];
}

/** The top-level packages under a directory: itself, when it is one. */
export function pythonPackages(
  root: string,
  only?: string,
): { dir: string; name: string }[] {
  if (existsSync(join(root, "__init__.py")))
    return [{ dir: root, name: only ?? basename(root) }];
  // A namespace package has no `__init__.py`, and is still the one asked for.
  if (only && existsSync(join(root, only)))
    return [{ dir: join(root, only), name: only }];
  const found = filesUnder(root, (name) => name === "__init__.py")
    .filter((file) => file.split("/").length === 2)
    .map((file) => file.split("/")[0] as string)
    .filter((name) => !only || name === only);
  return found.map((name) => ({ dir: join(root, name), name }));
}

const MODEL_PACKAGES = new Set(["types", "models"]);

/**
 * Reads every class of the release's packages under `root` (a
 * `site-packages`, or one package's own directory), and every method that
 * makes an HTTP call.
 */
export function readPython(root: string, only?: string): PythonRelease {
  const modules = new Map<string, ModuleSource>();
  const parsed = new Map<
    string,
    { classes: ClassSource[]; file: string; lines: string[] }
  >();
  const packages = pythonPackages(root, only);
  for (const pkg of packages) {
    for (const file of filesUnder(pkg.dir, (name) => name.endsWith(".py"))) {
      const text = textOf(pkg.dir, file);
      if (text === undefined) continue;
      const isPackage = file === "__init__.py" || file.endsWith("/__init__.py");
      const path = file.replace(/(^|\/)__init__\.py$/, "").replace(/\.py$/, "");
      const module = [pkg.name, ...(path ? path.split("/") : [])].join(".");
      const blank = blankDocstrings(text);
      const lines = blank.split("\n");
      const classes = classesIn(lines);
      modules.set(module, {
        module,
        isPackage,
        ...bindingsOf(module, isPackage, blank, classes),
      });
      parsed.set(module, { classes, file: `${pkg.name}/${file}`, lines });
    }
  }
  const namespaces = new Namespaces(modules);

  // The shortest public import path to each class, through re-exports only,
  // then through private names for what no public path reaches. A class a
  // package's namespace holds is one the package exports; any other is
  // reached only through the module that defines it.
  const paths = new Map<string, string>();
  const exported = new Set<string>();
  for (const allowPrivate of [false, true]) {
    for (const pkg of packages) {
      const queue: [string, string][] = [[pkg.name, pkg.name]];
      const visited = new Set<string>([pkg.name]);
      while (queue.length > 0) {
        const [module, path] = queue.shift() as [string, string];
        const names = [...namespaces.of(module)].sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        );
        for (const [name, binding] of names) {
          if (!isPublic(binding)) continue;
          if (!allowPrivate && name.startsWith("_")) continue;
          const target = namespaces.resolve(binding);
          if (!target) continue;
          if (target.kind === "class") {
            if (paths.has(target.id)) continue;
            paths.set(target.id, `${path}.${name}`);
            if (modules.get(module)?.isPackage) exported.add(target.id);
          } else if (target.kind === "module" && !visited.has(target.module)) {
            // Only into the release's own modules.
            if (!namespaces.has(target.module)) continue;
            visited.add(target.module);
            queue.push([target.module, `${path}.${name}`]);
          }
        }
      }
    }
  }

  // Each class's own fields, then with those of the classes it extends.
  const own = new Map<string, ReturnType<typeof fieldsOf> & { source: ClassSource }>();
  for (const [module, { classes }] of parsed) {
    for (const each of classes) {
      if (each.parent === undefined)
        own.set(`${module}:${each.name}`, { ...fieldsOf(each), source: each });
    }
  }
  const inherited = new Map<
    string,
    { fields: string[]; constants: Record<string, string> }
  >();
  const withBases = (
    id: string,
    seen = new Set<string>(),
  ): { fields: string[]; constants: Record<string, string> } => {
    const known = inherited.get(id);
    if (known) return known;
    const entry = own.get(id);
    if (!entry || seen.has(id)) return { fields: [], constants: {} };
    seen.add(id);
    const module = id.slice(0, id.indexOf(":"));
    const fields: string[] = [];
    const constants: Record<string, string> = {};
    for (const base of entry.source.bases) {
      const baseId = namespaces.classOf(module, base);
      if (!baseId) continue;
      const found = withBases(baseId, seen);
      fields.push(...found.fields);
      Object.assign(constants, found.constants);
    }
    const out = {
      fields: [...new Set([...fields, ...entry.fields])],
      constants: { ...constants, ...entry.constants },
    };
    inherited.set(id, out);
    return out;
  };

  const modelsOnly = [...parsed.keys()].some((module) =>
    module
      .split(".")
      .slice(1)
      .some((part) => MODEL_PACKAGES.has(part)),
  );
  const isModelModule = (module: string) =>
    !modelsOnly ||
    module
      .split(".")
      .slice(1)
      .some((part) => MODEL_PACKAGES.has(part));

  const declarations: Declaration[] = [];
  const units: Unit[] = [];
  for (const [module, { classes, file, lines }] of parsed) {
    const qualifiedOf = new Map<ClassSource, string>();
    for (const each of classes) {
      const qualified = each.parent
        ? `${qualifiedOf.get(each.parent) ?? ""}.${each.name}`
        : (paths.get(`${module}:${each.name}`) ?? `${module}.${each.name}`);
      qualifiedOf.set(each, qualified);
      units.push(...methodsOf(each.body, each.bodyIndent, "class", qualified, file));
      if (!isModelModule(module)) continue;
      const { fields, constants } = each.parent
        ? fieldsOf(each)
        : withBases(`${module}:${each.name}`);
      const input = each.bases.some((base) => /(?:^|\.)TypedDict$/.test(base));
      const extended = each.parent
        ? []
        : each.bases.flatMap((base) => {
            const id = namespaces.classOf(module, base);
            if (!id) return [];
            const [defined, name] = id.split(":") as [string, string];
            return [paths.get(id) ?? `${defined}.${name}`];
          });
      declarations.push({
        qualified,
        name: each.name,
        kind: "object",
        fields,
        ...(Object.keys(constants).length > 0 ? { constants } : {}),
        ...(each.parent ? { parent: qualifiedOf.get(each.parent) as string } : {}),
        ...(extended.length > 0 ? { extends: extended } : {}),
        ...(input ? { input } : {}),
        ...(exported.has(`${module}:${each.name}`) ? { exported: true } : {}),
        file,
      });
    }
    units.push(...methodsOf(lines, 0, "function", undefined, file));
    if (!isModelModule(module)) continue;
    for (const name of aliasesIn(lines.join("\n"))) {
      declarations.push({
        qualified: paths.get(`${module}:${name}`) ?? `${module}.${name}`,
        name,
        kind: "alias",
        ...(exported.has(`${module}:${name}`) ? { exported: true } : {}),
        file,
      });
    }
  }
  return {
    declarations,
    calls: callSites(units),
    packages: packages.map((pkg) => pkg.name),
  };
}

const VERB =
  /(?:[._](get|post|put|patch|delete)(?:_api_list|_list)?\s*\(|\bmethod\s*=\s*["'](GET|POST|PUT|PATCH|DELETE|get|post|put|patch|delete)["']|\(\s*["'](GET|POST|PUT|PATCH|DELETE|get|post|put|patch|delete)["']\s*,)/g;
/**
 * A string literal with a `/` in it, an f-string's `{...}` interpolations
 * included whatever they call: Fern writes `f"v1/models/{encode_path_param(model)}"`.
 */
const PATH =
  /(?<!\w)(f?)(["'])((?:[A-Za-z0-9_\-.~:?=#]|\{[^}"'\n]*\})*\/(?:[A-Za-z0-9_\-.~/:?=#]|\{[^}"'\n]*\})*)\2/g;
const OPERATION_ID = /\boperation_id\s*=\s*["']([^"']+)["']/g;
const SELF = /^(?:self|cls)$/;

/**
 * Every function defined at `margin` in `lines`: a class's methods, or a
 * module's functions, each with the requests it makes and the names it
 * calls.
 */
function methodsOf(
  lines: string[],
  margin: number,
  kind: Unit["kind"],
  owner: string | undefined,
  file: string,
): Unit[] {
  const out: Unit[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (indentOf(line) !== margin) continue;
    const def = /^\s*(?:async\s+)?def\s+(\w+)\s*\(/.exec(line);
    if (!def) continue;
    const text = statementAt(lines, index, margin);
    const verbs = [...text.matchAll(VERB)].map((match) => ({
      at: match.index ?? 0,
      verb: ((match[1] ?? match[2] ?? match[3]) as string).toLowerCase(),
    }));
    const paths: { at: number; path: string }[] = [];
    for (const match of text.matchAll(PATH)) {
      const raw = match[3] as string;
      // A path names at least one segment, and is not a file or a media type.
      if (!/[A-Za-z{]/.test(raw) || /\.(py|json|ya?ml|txt)$/.test(raw)) continue;
      paths.push({
        at: match.index ?? 0,
        path: match[1] === "f" ? raw.replace(/\{[^}]*\}/g, "{}") : raw,
      });
    }
    const ids = [...text.matchAll(OPERATION_ID)].map((match) => match[1] as string);
    out.push({
      kind,
      ...(owner !== undefined ? { owner } : {}),
      name: def[1] as string,
      file,
      requests: requestsIn(paths, verbs, ids),
      ...calledNames(text, SELF),
    });
  }
  return out;
}
