/**
 * The types a TypeScript release declares, and the HTTP call each of its
 * methods makes.
 *
 * Declarations come from the release's `.d.ts` files, parsed with the
 * TypeScript compiler's parser and nothing else: no program, no checker, no
 * module resolution, so reading stripe-node's thousand interfaces costs a
 * parse per file. A type is named by its namespaces, leaving out an ambient
 * module's quoted name, the way the TypeScript pack resolves a name
 * (`Stripe.Checkout.Session` inside `declare module 'stripe'`).
 *
 * openapi-typescript writes every schema as a property of one interface,
 * `components["schemas"]["pet"]`, which is the exact record of which type is
 * which schema, and is read as such.
 *
 * Calls come from the compiled JavaScript, where a method's body says what
 * it requests, `this._client.post('/v1/messages', ...)`, or hands it to a
 * function that does (`calls.ts`).
 */
import ts from "typescript";
import { calledNames, callSites, requestsIn, type Unit } from "../calls.ts";
import type { CallSite, Declaration } from "../types.ts";
import { filesUnder, textOf } from "./files.ts";

export interface TypeScriptRelease {
  declarations: Declaration[];
  calls: CallSite[];
  /** Whether a file holds openapi-typescript's `components` interface. */
  openapiTypescript: boolean;
}

const nameOf = (
  name: ts.PropertyName | ts.BindingName | undefined,
): string | undefined => {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
};

/** The single string a type is pinned to, as `'invoice'` or `"message"`. */
function literalOf(type: ts.TypeNode | undefined): string | undefined {
  if (type === undefined) return undefined;
  if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal))
    return type.literal.text;
  if (ts.isParenthesizedTypeNode(type)) return literalOf(type.type);
  return undefined;
}

/** Fields and pinned values of a list of type members. */
function membersOf(members: readonly ts.TypeElement[] | readonly ts.ClassElement[]): {
  fields: string[];
  constants: Record<string, string>;
} {
  const fields: string[] = [];
  const constants: Record<string, string> = {};
  for (const member of members) {
    if (!ts.isPropertySignature(member) && !ts.isPropertyDeclaration(member)) continue;
    const name = nameOf(member.name);
    if (name === undefined) continue;
    if (ts.isPropertyDeclaration(member)) {
      const modifiers = ts.getModifiers(member) ?? [];
      if (
        modifiers.some(
          (modifier) =>
            modifier.kind === ts.SyntaxKind.PrivateKeyword ||
            modifier.kind === ts.SyntaxKind.ProtectedKeyword ||
            modifier.kind === ts.SyntaxKind.StaticKeyword,
        )
      ) {
        continue;
      }
    }
    fields.push(name);
    const literal = literalOf(member.type);
    if (literal !== undefined) constants[name] = literal;
  }
  return { fields, constants };
}

/** The members of an object type written inline, through intersections. */
function literalMembers(type: ts.TypeNode | undefined): ts.TypeElement[] | undefined {
  if (type === undefined) return undefined;
  if (ts.isTypeLiteralNode(type)) return [...type.members];
  if (ts.isParenthesizedTypeNode(type)) return literalMembers(type.type);
  if (ts.isIntersectionTypeNode(type)) {
    const parts = type.types.map(literalMembers);
    if (parts.every((part) => part !== undefined))
      return parts.flat() as ts.TypeElement[];
  }
  return undefined;
}

interface Found extends Declaration {
  /** The namespaces around it, for telling a nested type from a top-level one. */
  container: string;
  /** The types it extends, as written: `Base`, `Stripe.Base`. */
  bases: string[];
  /**
   * A class: its namespace holds what a client or resource declares, as
   * stripe-node's `class Stripe` does every type, and nests none of them.
   */
  isClass: boolean;
  /** The module it is declared in, or `""` for the global scope of an ambient declaration file. */
  scope: string;
  /** For a union of named types, the names as written. */
  union: string[];
}

/** The names a union of type references joins, or none for any other type. */
function unionOf(type: ts.TypeNode): string[] {
  if (ts.isParenthesizedTypeNode(type)) return unionOf(type.type);
  if (!ts.isUnionTypeNode(type)) return [];
  const names: string[] = [];
  for (const member of type.types) {
    if (!ts.isTypeReferenceNode(member) || member.typeArguments) return [];
    names.push(member.typeName.getText());
  }
  return names;
}

/**
 * An intersection of object types and references to others, as
 * `Base & { extra: string }`: its own members and the types it takes the
 * rest from. Undefined for anything else.
 */
function intersectionOf(
  type: ts.TypeNode | undefined,
): { members: ts.TypeElement[]; bases: string[] } | undefined {
  if (type === undefined || !ts.isIntersectionTypeNode(type)) return undefined;
  const members: ts.TypeElement[] = [];
  const bases: string[] = [];
  for (const part of type.types) {
    const literal = literalMembers(part);
    if (literal) members.push(...literal);
    else if (ts.isTypeReferenceNode(part)) bases.push(part.typeName.getText());
    else return undefined;
  }
  return { members, bases };
}

/** Every declaration in one file. */
function declarationsIn(file: string, text: string, out: Found[]): boolean {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const scope = ts.isExternalModule(source) ? file : "";
  let openapiTypescript = false;
  const add = (
    names: string[],
    name: string,
    kind: Declaration["kind"],
    members: ReturnType<typeof membersOf> | undefined,
    bases: string[] = [],
    isClass = false,
    union: string[] = [],
  ) => {
    out.push({
      qualified: [...names, name].join("."),
      name,
      kind,
      ...(members ? { fields: members.fields } : {}),
      ...(members && Object.keys(members.constants).length > 0
        ? { constants: members.constants }
        : {}),
      file,
      container: names.join("."),
      bases,
      isClass,
      scope,
      union,
    });
  };
  const heritage = (clauses: ts.NodeArray<ts.HeritageClause> | undefined): string[] =>
    (clauses ?? []).flatMap((clause) =>
      clause.token === ts.SyntaxKind.ExtendsKeyword
        ? clause.types.map((type) => type.expression.getText())
        : [],
    );
  const visit = (statements: readonly ts.Statement[], names: string[]) => {
    for (const statement of statements) {
      if (ts.isModuleDeclaration(statement)) {
        // `declare module 'stripe'` names a package, not a namespace.
        const inner = ts.isIdentifier(statement.name)
          ? [...names, statement.name.text]
          : names;
        let body = statement.body;
        let path = inner;
        // `namespace A.B {}` is a declaration nested in a declaration.
        while (body && ts.isModuleDeclaration(body)) {
          path = [...path, body.name.text];
          body = body.body;
        }
        if (body && ts.isModuleBlock(body)) visit(body.statements, path);
        continue;
      }
      if (ts.isInterfaceDeclaration(statement)) {
        const name = statement.name.text;
        if (name === "components" && names.length === 0) {
          openapiTypescript =
            components(statement.members, file, scope, out) || openapiTypescript;
        }
        add(
          names,
          name,
          "object",
          membersOf(statement.members),
          heritage(statement.heritageClauses),
        );
        continue;
      }
      if (ts.isTypeAliasDeclaration(statement)) {
        const name = statement.name.text;
        const members = literalMembers(statement.type);
        if (name === "components" && names.length === 0 && members) {
          openapiTypescript = components(members, file, scope, out) || openapiTypescript;
        }
        const intersection = members ? undefined : intersectionOf(statement.type);
        if (members) add(names, name, "object", membersOf(members));
        else if (intersection) {
          add(names, name, "object", membersOf(intersection.members), intersection.bases);
        } else add(names, name, "alias", undefined, [], false, unionOf(statement.type));
        continue;
      }
      if (ts.isClassDeclaration(statement) && statement.name) {
        const members = membersOf(statement.members);
        // A class with no fields is a resource or a client, not a model.
        if (members.fields.length > 0) {
          add(
            names,
            statement.name.text,
            "object",
            members,
            heritage(statement.heritageClauses),
            true,
          );
        }
        continue;
      }
      if (ts.isEnumDeclaration(statement))
        add(names, statement.name.text, "alias", undefined);
    }
  };
  visit(source.statements, []);
  return openapiTypescript;
}

/**
 * openapi-typescript's `components["schemas"]`, one declaration per schema,
 * each recording the schema it is.
 */
function components(
  members: readonly ts.TypeElement[],
  file: string,
  scope: string,
  out: Found[],
): boolean {
  const schemas = members.find(
    (member) => ts.isPropertySignature(member) && nameOf(member.name) === "schemas",
  ) as ts.PropertySignature | undefined;
  const entries = literalMembers(schemas?.type);
  if (!entries) return false;
  for (const entry of entries) {
    if (!ts.isPropertySignature(entry)) continue;
    const schema = nameOf(entry.name);
    if (schema === undefined) continue;
    const fields = literalMembers(entry.type);
    const members = fields ? membersOf(fields) : undefined;
    out.push({
      qualified: `components["schemas"][${JSON.stringify(schema)}]`,
      name: schema,
      kind: members ? "object" : "alias",
      ...(members ? { fields: members.fields } : {}),
      ...(members && Object.keys(members.constants).length > 0
        ? { constants: members.constants }
        : {}),
      schema,
      file,
      container: "",
      bases: [],
      isClass: false,
      scope,
      union: [],
    });
  }
  return true;
}

/**
 * The declaration files to read: `.d.ts`, with a `.d.mts` or `.d.cts` twin
 * of one left out, and the sources themselves for a release that ships no
 * declarations at all.
 */
function declarationFiles(root: string): string[] {
  const all = filesUnder(root, (name) => /\.d\.[cm]?ts$/.test(name));
  const plain = new Set(all.filter((file) => file.endsWith(".d.ts")));
  const chosen = all.filter(
    (file) => file.endsWith(".d.ts") || !plain.has(file.replace(/\.d\.[cm]ts$/, ".d.ts")),
  );
  if (chosen.length > 0) return chosen;
  return filesUnder(root, (name) => /\.tsx?$/.test(name) && !/\.d\.ts$/.test(name));
}

/**
 * The compiled files to read calls from: `.js`, with an `.mjs` or `.cjs`
 * twin of one left out, and the TypeScript sources when nothing is
 * compiled.
 */
function codeFiles(root: string): string[] {
  const all = filesUnder(root, (name) => /\.[cm]?js$/.test(name));
  const plain = new Set(all.filter((file) => file.endsWith(".js")));
  const chosen = all.filter(
    (file) => file.endsWith(".js") || !plain.has(file.replace(/\.[cm]js$/, ".js")),
  );
  if (chosen.length > 0) return chosen;
  return filesUnder(root, (name) => /\.tsx?$/.test(name) && !/\.d\.ts$/.test(name));
}

/** Reads every declaration and every HTTP call of the release unpacked at `root`. */
export function readTypeScript(root: string): TypeScriptRelease {
  const found: Found[] = [];
  let openapiTypescript = false;
  for (const file of declarationFiles(root)) {
    const text = textOf(root, file);
    if (text === undefined) continue;
    openapiTypescript = declarationsIn(file, text, found) || openapiTypescript;
  }
  // Declarations merge within a scope: across the files of an ambient
  // `declare module` (stripe-node before 22 spreads `namespace Stripe` over
  // hundreds), within one file of a module. Two modules' `Session`s are two
  // types; the same module compiled twice (`cjs/` and `esm/`) is one.
  const byName = new Map<string, Found>();
  const keyOf = (each: Found) => `${each.scope}\u0000${each.qualified}`;
  for (const each of found) {
    const known = byName.get(keyOf(each));
    if (!known) {
      byName.set(keyOf(each), { ...each });
      continue;
    }
    if (known.kind === "alias" && each.kind === "object") {
      byName.set(keyOf(each), { ...each });
      continue;
    }
    if (each.fields && known.fields) {
      known.fields = [...new Set([...known.fields, ...each.fields])];
    }
    if (each.constants) known.constants = { ...each.constants, ...known.constants };
    known.bases = [...new Set([...known.bases, ...each.bases])];
  }
  const inScope = new Map<string, Found[]>();
  for (const each of byName.values()) {
    inScope.set(each.qualified, [...(inScope.get(each.qualified) ?? []), each]);
  }
  /** A name as seen from a scope: its own declaration, a global one, or the only one. */
  const lookup = (scope: string, qualified: string): Found | undefined => {
    const all = inScope.get(qualified) ?? [];
    return (
      all.find((each) => each.scope === scope) ??
      all.find((each) => each.scope === "") ??
      (all.length === 1 ? all[0] : undefined)
    );
  };
  // What a type extends is named from where it is declared: `Base` inside
  // `namespace Stripe` is `Stripe.Base` when that exists.
  const baseOf = (each: Found, base: string): Found | undefined => {
    const scopes = each.container === "" ? [] : each.container.split(".");
    for (let at = scopes.length; at >= 0; at -= 1) {
      const found = lookup(each.scope, [...scopes.slice(0, at), base].join("."));
      if (found && found !== each) return found;
    }
    return undefined;
  };
  const withBases = (each: Found, seen = new Set<Found>()): Found => {
    if (each.bases.length === 0 || seen.has(each)) return each;
    seen.add(each);
    const fields = new Set(each.fields ?? []);
    const constants: Record<string, string> = {};
    const extended: string[] = [];
    for (const base of each.bases) {
      const found = baseOf(each, base);
      if (!found) continue;
      extended.push(found.qualified);
      const full = withBases(found, seen);
      for (const field of full.fields ?? []) fields.add(field);
      Object.assign(constants, full.constants);
    }
    each.fields = [...fields];
    each.constants = { ...constants, ...each.constants };
    if (extended.length > 0) each.extends = extended;
    each.bases = [];
    return each;
  };
  for (const each of byName.values()) withBases(each);
  // A union of object types stands for each of them: it has the fields and
  // the pinned values every variant shares.
  for (const each of byName.values()) {
    if (each.kind !== "alias" || each.union.length < 2) continue;
    const variants = each.union.map((name) => baseOf(each, name));
    if (!variants.every((found) => found !== undefined && found.kind === "object"))
      continue;
    const [first, ...rest] = variants as Found[];
    each.variants = [...new Set(variants.map((found) => (found as Found).qualified))];
    each.fields = (first?.fields ?? []).filter((field) =>
      rest.every((other) => other.fields?.includes(field)),
    );
    const shared = Object.entries(first?.constants ?? {}).filter(([property, value]) =>
      rest.every((other) => other.constants?.[property] === value),
    );
    if (shared.length > 0) each.constants = Object.fromEntries(shared);
  }
  // A declaration inside a namespace that merges with a type, as stripe-node's
  // `Subscription.AutomaticTax`, is nested in that type.
  const isType = (each: Found | undefined) =>
    each !== undefined && each.kind === "object" && !each.schema && !each.isClass;
  // The same module compiled twice declares everything twice, identically.
  const seen = new Set<string>();
  const declarations: Declaration[] = [];
  for (const each of byName.values()) {
    const signature = JSON.stringify([
      each.qualified,
      each.kind,
      [...(each.fields ?? [])].sort(),
      each.constants,
      each.container !== "" && isType(lookup(each.scope, each.container)),
    ]);
    if (seen.has(signature)) continue;
    seen.add(signature);
    const {
      container,
      bases: _bases,
      isClass: _isClass,
      scope: _scope,
      union: _union,
      constants,
      ...rest
    } = each;
    declarations.push({
      ...rest,
      ...(constants && Object.keys(constants).length > 0 ? { constants } : {}),
      ...(container !== "" && isType(lookup(each.scope, container))
        ? { parent: container }
        : {}),
    });
  }
  const units: Unit[] = [];
  for (const file of codeFiles(root)) {
    const text = textOf(root, file);
    if (text === undefined) continue;
    units.push(...unitsIn(file, text));
  }
  return { declarations, calls: callSites(units), openapiTypescript };
}

const VERB =
  /(?:[._](get|post|put|patch|delete)(?:APIList|_api_list|List)?\s*[(<]|\bmethod\s*:\s*["'](GET|POST|PUT|PATCH|DELETE|get|post|put|patch|delete)["']|\(\s*["'](GET|POST|PUT|PATCH|DELETE)["']\s*,)/g;
const OPERATION_ID = /\boperationI[dD]\s*:\s*["']([^"']+)["']/g;
const SELF = /^(?:this|_this|self)$/;

/** A string's text with each interpolation as `{}`, or undefined for anything else. */
function pathText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isTemplateExpression(node)) {
    return (
      node.head.text + node.templateSpans.map((span) => `{}${span.literal.text}`).join("")
    );
  }
  return undefined;
}

/**
 * Whether a node is a unit of its own, read separately: a method, a named
 * function, a class, or a function held by a variable or property. A
 * callback passed to a call is not, and is read as part of what passes it,
 * since compiled code wraps a whole body in one: `__awaiter(this, ...,
 * function* () { ... })`.
 */
const isUnit = (node: ts.Node): boolean => {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  ) {
    return true;
  }
  if (!ts.isFunctionExpression(node) && !ts.isArrowFunction(node)) return false;
  const holder = node.parent;
  return (
    (ts.isPropertyAssignment(holder) ||
      ts.isVariableDeclaration(holder) ||
      ts.isPropertyDeclaration(holder)) &&
    holder.initializer === node
  );
};

/** The name of the nearest variable or function a node is inside, for an object's methods. */
function holderOf(node: ts.Node): string | undefined {
  for (let at = node.parent; at !== undefined; at = at.parent) {
    if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name)) return at.name.text;
    if (ts.isFunctionDeclaration(at) && at.name) return at.name.text;
  }
  return undefined;
}

/**
 * Every function-like unit of a compiled file: class methods, functions,
 * and functions held in object literals, each with the requests its own
 * body makes and the names it calls.
 */
function unitsIn(file: string, text: string): Unit[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: Unit[] = [];
  const unit = (
    kind: Unit["kind"],
    owner: string | undefined,
    name: string,
    root: ts.Node,
  ) => {
    const start = root.getStart(source);
    const code = root.getText(source);
    const paths: { at: number; path: string }[] = [];
    // Paths in this unit's own body, not in a function nested in it.
    const visit = (node: ts.Node) => {
      if (node !== root && isUnit(node)) return;
      const path = pathText(node);
      if (path !== undefined) {
        if (path.includes("/") && !/\s/.test(path)) {
          paths.push({ at: node.getStart(source) - start, path });
        }
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
    const verbs = [...code.matchAll(VERB)].map((match) => ({
      at: match.index ?? 0,
      verb: ((match[1] ?? match[2] ?? match[3]) as string).toLowerCase(),
    }));
    const ids = [...code.matchAll(OPERATION_ID)].map((match) => match[1] as string);
    out.push({
      kind,
      ...(owner !== undefined ? { owner } : {}),
      name,
      file,
      requests: requestsIn(paths, verbs, ids),
      ...calledNames(code, SELF),
    });
  };
  const isFunction = (node: ts.Node | undefined): node is ts.Expression =>
    node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
  const visit = (node: ts.Node) => {
    if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name) {
      for (const member of node.members) {
        const name = nameOf(member.name);
        if (name === undefined) continue;
        if (ts.isMethodDeclaration(member) && member.body) {
          unit("class", node.name.text, name, member.body);
        } else if (ts.isPropertyDeclaration(member) && isFunction(member.initializer)) {
          unit("class", node.name.text, name, member.initializer);
        }
      }
    } else if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      unit("function", undefined, node.name.text, node.body);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isFunction(node.initializer)
    ) {
      unit("function", undefined, node.name.text, node.initializer);
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        const name = nameOf(property.name);
        if (name === undefined) continue;
        if (ts.isMethodDeclaration(property) && property.body) {
          unit("object", holderOf(node), name, property.body);
        } else if (
          ts.isPropertyAssignment(property) &&
          isFunction(property.initializer)
        ) {
          unit("object", holderOf(node), name, property.initializer);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}
