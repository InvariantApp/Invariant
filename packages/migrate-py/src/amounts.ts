/**
 * Amounts whose unit changed, converted with the SDK's own exact helpers.
 *
 * A field that is now in minor units is read through the helper that turns
 * minor units back into the amount the consumer's code already means, and
 * written through the one that goes the other way. No arithmetic is ever
 * inlined: `balance * 100` is a rounding bug waiting for the first amount
 * that is not a whole number of cents. A literal is the one exception,
 * converted here on its digits (`Decimal("12.50")` becomes `1250`), where
 * the result is exact.
 *
 * The helpers are the SDK's, so a file names them the way it already names
 * the SDK: through `import acme` as `acme.to_minor_units`, or through an
 * existing `from acme import ...`, which is extended. A helper the SDK does
 * not export, or a name the file already uses for something else, and the
 * site is shown to a person instead.
 */
import { type Edit, exactMinorUnits } from "@invariant-app/migrate-core";
import type { Sources } from "./engine.ts";
import { isSpan, type ReferenceProvider } from "./references.ts";
import { descendantsOfType, type Node, stringValue, type Tree } from "./syntax.ts";

export interface HelperNames {
  toMinor: string;
  fromMinor: string;
  /** The module that exports them, where it is not the SDK's own. */
  from?: string;
}

/** How one file reaches the SDK's module, read once. */
interface Reach {
  /** `acme.` or `a.` for `import acme as a`, where the file imports the module whole. */
  qualifier: string | undefined;
  /** The `from acme import ...` statement a helper can be added to. */
  fromImport: Node | undefined;
  /** Every name the file binds or uses, so an added one collides with none. */
  names: Set<string>;
  /** Helpers imported by name already, to the name the file uses. */
  imported: Map<string, string>;
  /** Helpers this migration adds to the file's imports. */
  added: string[];
  /** Where the file's last top-level import ends. */
  afterImports: number;
}

export class Helpers {
  private readonly references: ReferenceProvider;
  private readonly sources: Sources;
  private readonly names: HelperNames;
  private readonly module: string;
  private exported: Promise<boolean> | undefined;
  private readonly reaches = new Map<string, Reach>();

  constructor(
    references: ReferenceProvider,
    sources: Sources,
    names: HelperNames,
    /** The SDK's top module, where `from` does not say otherwise. */
    module: string,
  ) {
    this.references = references;
    this.sources = sources;
    this.names = names;
    this.module = names.from ?? module;
  }

  /** The helper that reads a rescaled value back in the unit the code means. */
  reading(exponent: number): string {
    return exponent > 0 ? this.names.fromMinor : this.names.toMinor;
  }

  /** The helper that converts a value the code writes into the unit sent now. */
  writing(exponent: number): string {
    return exponent > 0 ? this.names.toMinor : this.names.fromMinor;
  }

  /**
   * Whether the SDK exports both helpers, asked of the checker: a symbol
   * map written for another language's SDK may name ones this one lacks.
   */
  available(): Promise<boolean> {
    this.exported ??= (async () => {
      for (const name of [this.names.toMinor, this.names.fromMinor]) {
        if (!/^[A-Za-z_]\w*$/.test(name)) return false;
        if (!(await this.references.moduleAttribute(this.module, name))) return false;
      }
      return true;
    })();
    return this.exported;
  }

  /**
   * The expression that names `helper` in `file`, recording any import it
   * needs, or nothing where the file cannot name it without a collision.
   */
  async nameIn(file: string, helper: string): Promise<string | undefined> {
    const reach = await this.reachOf(file);
    if (!reach) return undefined;
    if (reach.qualifier) return `${reach.qualifier}${helper}`;
    const imported = reach.imported.get(helper);
    if (imported) return imported;
    if (reach.names.has(helper) && !reach.added.includes(helper)) return undefined;
    if (!reach.added.includes(helper)) reach.added.push(helper);
    return helper;
  }

  /** The imports the helpers written into each file need. */
  importEdits(changeId: string): Edit[] {
    const edits: Edit[] = [];
    for (const [file, reach] of this.reaches) {
      if (reach.added.length === 0) continue;
      const names = [...reach.added].sort();
      const base = {
        file,
        changeId,
        author: "codemod" as const,
        reason: "imported the SDK's exact conversion helpers",
      };
      const last = reach.fromImport
        ?.childrenForFieldName("name")
        .filter((name): name is Node => name !== null)
        .at(-1);
      if (last) {
        edits.push({
          ...base,
          start: last.endIndex,
          end: last.endIndex,
          replacement: names.map((name) => `, ${name}`).join(""),
        });
        continue;
      }
      // A statement of its own, after the file's last import.
      edits.push({
        ...base,
        start: reach.afterImports,
        end: reach.afterImports,
        replacement: `\nfrom ${this.module} import ${names.join(", ")}`,
      });
    }
    return edits;
  }

  private async reachOf(file: string): Promise<Reach | undefined> {
    const known = this.reaches.get(file);
    if (known) return known;
    const tree = await this.sources.tree(file);
    if (!tree) return undefined;
    const reach = readReach(tree, this.module, [
      this.names.toMinor,
      this.names.fromMinor,
    ]);
    // A file with no import at all has no place an import plainly goes.
    if (!reach) return undefined;
    this.reaches.set(file, reach);
    return reach;
  }
}

/** How a file's top-level imports reach `module`, and the names it already uses. */
function readReach(
  tree: Tree,
  module: string,
  helpers: readonly string[],
): Reach | undefined {
  const imports = tree.rootNode.namedChildren.filter(
    (node): node is Node =>
      node?.type === "import_statement" ||
      node?.type === "import_from_statement" ||
      node?.type === "future_import_statement",
  );
  const last = imports.at(-1);
  if (!last) return undefined;
  const reach: Reach = {
    afterImports: last.endIndex,
    qualifier: undefined,
    fromImport: undefined,
    names: new Set(descendantsOfType(tree.rootNode, ["identifier"]).map((id) => id.text)),
    imported: new Map(),
    added: [],
  };
  for (const statement of imports) {
    if (statement.type === "import_statement") {
      for (const name of statement.childrenForFieldName("name")) {
        if (!name) continue;
        const dotted =
          name.type === "aliased_import" ? name.childForFieldName("name") : name;
        if (dotted?.text !== module) continue;
        const alias =
          name.type === "aliased_import" ? name.childForFieldName("alias")?.text : module;
        reach.qualifier ??= alias ? `${alias}.` : undefined;
      }
    } else if (statement.type === "import_from_statement") {
      if (statement.childForFieldName("module_name")?.text !== module) continue;
      // `from acme import *` names the helpers already, but nothing says so.
      if (descendantsOfType(statement, ["wildcard_import"]).length > 0) continue;
      reach.fromImport ??= statement;
      for (const name of statement.childrenForFieldName("name")) {
        if (!name) continue;
        const imported =
          name.type === "aliased_import" ? name.childForFieldName("name") : name;
        const local =
          name.type === "aliased_import" ? name.childForFieldName("alias") : name;
        if (imported && local && helpers.includes(imported.text)) {
          reach.imported.set(imported.text, local.text);
        }
      }
    }
  }
  return reach;
}

/**
 * The exact number of minor units a literal amount is, where it is one:
 * a number written as digits, or `Decimal("12.50")` with the standard
 * library's `Decimal`, which the checker resolves.
 */
export async function exactLiteral(
  references: ReferenceProvider,
  file: string,
  value: Node,
  exponent: number,
): Promise<string | undefined> {
  // Only whole minor units are written as a literal. Going the other way
  // would write a fraction, which Python reads as a float.
  if (exponent <= 0) return undefined;
  if (["integer", "float", "unary_operator"].includes(value.type)) {
    return exactMinorUnits(value.text, exponent);
  }
  if (value.type !== "call") return undefined;
  const callee = value.childForFieldName("function");
  const name =
    callee?.type === "attribute" ? callee.childForFieldName("attribute") : callee;
  const args = (value.childForFieldName("arguments")?.namedChildren ?? []).filter(
    (arg): arg is Node => arg !== null && arg.type !== "comment",
  );
  const only = args.length === 1 ? args[0] : undefined;
  if (!name || !only) return undefined;
  const digits =
    only.type === "string"
      ? stringValue(only)
      : ["integer", "unary_operator"].includes(only.type)
        ? only.text
        : undefined;
  if (digits === undefined) return undefined;
  const points = await references.definitionAt(file, name.startIndex);
  const decimal =
    points.length > 0 &&
    points.every(
      (point) => !isSpan(point) && /(?:^|\/)_?(?:py)?decimal\.pyi$/.test(point.file),
    );
  return decimal ? exactMinorUnits(digits, exponent) : undefined;
}
