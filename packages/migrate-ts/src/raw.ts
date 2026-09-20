/**
 * Call sites with no types behind them.
 *
 * Everywhere else the type checker does the work: ask it for references to a
 * property declared in an SDK and it returns every site, through aliases and
 * helpers, with no heuristics. A consumer calling `fetch` with a hand-built
 * object has no such declaration. The body is an object literal whose keys are
 * strings, the response is `Record<string, unknown>`, and nothing connects
 * either to the provider's schema.
 *
 * So this works by name, and being honest about what that means is the whole
 * design. A property called `amount` inside the body of a request to a URL that
 * matches `/v1/payments` is *probably* the field the Change is about. Probably
 * is not good enough to apply silently, so every edit made here is reported for
 * review, and a site whose URL cannot be matched to an operation is reported
 * without being touched at all.
 *
 * The matching itself is deterministic. A model is only worth asking where
 * code genuinely cannot decide, and a literal path is not one of those places.
 */
import { Node, type Project, SyntaxKind } from "ts-morph";
import type { Edit } from "./edits.ts";
import type { EditScope, ManualSite } from "./engine.ts";
import { editable } from "./engine.ts";
import { exactMinorUnits } from "./numbers.ts";
import type { MigrationPlan } from "./plan.ts";

export interface RawOptions {
  /**
   * Path templates in the contract, with the schema each one's request body
   * uses.
   *
   * The schema is what keeps a rewrite in its lane. Without it a field that a
   * Change adds to one object gets added to every request that happened to
   * match a URL, which is how `capture_method` ended up in a refund.
   */
  operations: {
    method: string;
    path: string;
    operationId: string;
    requestSchema?: string;
  }[];
  /** Header a caller uses to declare its contract, and what to move it to. */
  contractHeader?: { name: string; from: string; to: string };
}

export interface RawResult {
  edits: Edit[];
  manual: ManualSite[];
  /** Call sites found, whether or not anything was changed. */
  sites: { file: string; line: number; url: string; operationId: string | undefined }[];
}

/**
 * A URL expression as a list of path segments.
 *
 * `${config.baseUrl}/v1/payments/${id}` is a template with no literal tail at
 * all, so taking the text after the last interpolation finds nothing and the
 * call site is skipped. Every retrieve-by-id in a raw client looks like that,
 * which made it the wrong way round: what matters is the shape of the path,
 * with each interpolation standing in for one segment.
 *
 * `undefined` in the result means a segment whose value is not known here,
 * which lines up with a parameter in the contract's template.
 */
function pathSegments(node: Node): (string | undefined)[] | undefined {
  let text: string;

  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    text = node.getLiteralText();
  } else if (Node.isTemplateExpression(node)) {
    // A single character nothing may appear in a URL stands in for each
    // interpolation, so the segment structure survives the join.
    text = node
      .getTemplateSpans()
      .reduce(
        (accumulated, span) =>
          `${accumulated}\u0000${span.getLiteral().getLiteralText()}`,
        node.getHead().getLiteralText(),
      );
  } else {
    return undefined;
  }

  const start = text.indexOf("/");
  if (start === -1) return undefined;

  // Everything before the first slash is the base URL, however it was built.
  return text
    .slice(start)
    .split("?")[0]
    ?.split("/")
    .map((segment) => (segment.includes("\u0000") ? undefined : segment));
}

/** Whether a path's segments match a template, ignoring parameter values. */
function matchesTemplate(template: string, segments: (string | undefined)[]): boolean {
  const left = template.split("/");
  if (left.length !== segments.length) return false;
  return left.every((segment, index) => {
    const actual = segments[index];
    // A parameter in the template matches anything; a variable in the caller's
    // path matches a parameter but not a fixed segment, because a fixed one
    // would be a different endpoint.
    if (segment.startsWith("{") && segment.endsWith("}")) return true;
    return actual === segment;
  });
}

/** The readable form of a path, for a report a person reads. */
function describePath(segments: (string | undefined)[]): string {
  return segments.map((segment) => segment ?? "{...}").join("/");
}

function methodOf(options: Node | undefined): string {
  if (!options || !Node.isObjectLiteralExpression(options)) return "get";
  const method = options.getProperty("method");
  if (!method || !Node.isPropertyAssignment(method)) return "get";
  const value = method.getInitializer();
  return Node.isStringLiteral(value) ? value.getLiteralValue().toLowerCase() : "get";
}

function bodyLiteral(options: Node | undefined): Node | undefined {
  if (!options || !Node.isObjectLiteralExpression(options)) return undefined;
  const body = options.getProperty("body");
  if (!body || !Node.isPropertyAssignment(body)) return undefined;

  const value = body.getInitializer();
  // `body: JSON.stringify({ ... })` is how a raw caller writes one.
  if (Node.isCallExpression(value)) {
    const argument = value.getArguments()[0];
    if (argument && Node.isObjectLiteralExpression(argument)) return argument;
  }
  return Node.isObjectLiteralExpression(value) ? value : undefined;
}

function siteFrom(node: Node, url: string, operationId: string | undefined) {
  const source = node.getSourceFile();
  return {
    file: source.getFilePath(),
    line: source.getLineAndColumnAtPos(node.getStart()).line,
    url,
    operationId,
  };
}

function manual(node: Node, changeId: string, reason: string): ManualSite {
  const source = node.getSourceFile();
  const { line, column } = source.getLineAndColumnAtPos(node.getStart());
  return {
    file: source.getFilePath(),
    line,
    column,
    changeId,
    reason,
    snippet: node.getText().slice(0, 120),
    offset: node.getStart(),
  };
}

/**
 * Rewrites what it can in raw call sites, and reports all of it.
 *
 * Nothing here is applied quietly. Every edit is paired with a manual entry, so
 * the pull request says "this was changed and nobody could check it" rather
 * than letting an untyped guess look like the type-checked work elsewhere in
 * the same diff.
 */
export function migrateRawCallSites(
  project: Project,
  plan: MigrationPlan,
  scope: EditScope,
  options: RawOptions,
): RawResult {
  const result: RawResult = { edits: [], manual: [], sites: [] };

  // One rename and one conversion per field name, taken from the ops rather
  // than from any type. This is the part that is name-based and therefore
  // reviewable rather than proven.
  const renames = new Map<string, string>();
  const scales = new Map<string, number>();
  const enums = new Map<string, Record<string, string>>();
  /** Field to add, and the schemas its Change actually scopes to. */
  const added = new Map<string, { value: unknown; schemas: Set<string> }>();

  for (const change of plan.changes) {
    const schemas = new Set(
      (change.scopes ?? []).flatMap((scope) =>
        "schema" in scope ? [scope.schema.slice(scope.schema.lastIndexOf("/") + 1)] : [],
      ),
    );
    for (const op of change.ops) {
      if (op.op === "move") {
        renames.set(leaf(op.from), leaf(op.to));
      } else if (op.op === "convert" && op.codec.kind === "scale10") {
        scales.set(leaf(op.path), op.codec.exponent);
      } else if (op.op === "convert" && op.codec.kind === "enumMap") {
        enums.set(leaf(op.path), Object.fromEntries(op.codec.pairs));
      } else if (op.op === "add") {
        added.set(leaf(op.path), { value: op.value, schemas });
      }
    }
  }

  const helpers = plan.symbols.helpers;

  for (const source of project.getSourceFiles()) {
    if (!editable(source, scope)) continue;

    for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const [urlArgument, optionsArgument] = call.getArguments();
      if (!urlArgument) continue;

      const segments = pathSegments(urlArgument);
      if (segments?.[0] !== "") continue;

      const method = methodOf(optionsArgument);
      const operation = options.operations.find(
        (entry) => entry.method === method && matchesTemplate(entry.path, segments),
      );

      const path = describePath(segments);
      result.sites.push(siteFrom(call, path, operation?.operationId));

      if (!operation) {
        // A call that looks like it reaches the API but cannot be tied to an
        // operation is exactly the thing not to guess at.
        result.manual.push(
          manual(
            call,
            "",
            `this calls ${method.toUpperCase()} ${path}, which does not match any ` +
              "operation in the contract. Check it by hand.",
          ),
        );
        continue;
      }

      rewriteBody(bodyLiteral(optionsArgument), result, {
        renames,
        scales,
        enums,
        added,
        helpers,
        operationId: operation.operationId,
        ...(operation.requestSchema === undefined
          ? {}
          : { requestSchema: operation.requestSchema }),
      });

      if (options.contractHeader)
        bumpHeader(optionsArgument, options.contractHeader, result);
    }

    rewriteReads(source, result, { renames, scales, enums, helpers });
  }

  return result;
}

function leaf(pointer: string): string {
  const segments = pointer.split("/").filter((segment) => segment !== "");
  return segments[segments.length - 1] ?? pointer;
}

interface Rewrites {
  renames: Map<string, string>;
  scales: Map<string, number>;
  enums: Map<string, Record<string, string>>;
  added: Map<string, { value: unknown; schemas: Set<string> }>;
  helpers: { toMinor: string; fromMinor: string; from?: string } | undefined;
  operationId: string;
  /** Schema this operation's request body uses, when the contract names one. */
  requestSchema?: string;
}

function rewriteBody(
  literal: Node | undefined,
  result: RawResult,
  rewrites: Rewrites,
): void {
  if (!literal || !Node.isObjectLiteralExpression(literal)) return;

  const present = new Set<string>();

  for (const property of literal.getProperties()) {
    const name = Node.isPropertyAssignment(property)
      ? property.getName()
      : Node.isShorthandPropertyAssignment(property)
        ? property.getName()
        : undefined;
    if (name === undefined) continue;
    present.add(name);

    const renamed = rewrites.renames.get(name);
    const exponent = rewrites.scales.get(renamed ?? name);
    if (renamed === undefined && exponent === undefined) continue;

    const key = renamed ?? name;
    const value = Node.isPropertyAssignment(property)
      ? (property.getInitializer()?.getText() ?? name)
      : name;

    let written = value;
    if (exponent !== undefined) {
      const exact = Node.isPropertyAssignment(property)
        ? exactOf(property.getInitializer(), exponent)
        : undefined;
      written =
        exact ??
        (rewrites.helpers
          ? `${exponent > 0 ? rewrites.helpers.toMinor : rewrites.helpers.fromMinor}(${value})`
          : value);
    }

    result.edits.push({
      file: literal.getSourceFile().getFilePath(),
      start: property.getStart(),
      end: property.getEnd(),
      replacement: `${key}: ${written}`,
      changeId: "raw-http",
      author: "codemod",
      reason: `matched by name inside a request to ${rewrites.operationId}`,
    });
    result.manual.push(
      manual(
        property,
        "raw-http",
        `changed \`${name}\` to \`${key}\` in an untyped request body. Nothing ` +
          "checks this against the provider's schema, so confirm it is the " +
          "field the contract means.",
      ),
    );
  }

  // A newly required field has no existing property to anchor to, so it is
  // added to a body that already looks like the right one.
  for (const [name, entry] of rewrites.added) {
    if (present.has(name)) continue;
    // Only where the Change said it applies. A URL match alone would put a
    // payment's field into a refund.
    if (
      rewrites.requestSchema === undefined ||
      !entry.schemas.has(rewrites.requestSchema)
    ) {
      continue;
    }
    const value = entry.value;
    const first = literal.getProperties()[0];
    if (!first) continue;

    // Anchored after the opening brace, not at the first property. A zero
    // width insert at a property's start sits inside the span of the edit that
    // rewrites that property, and one of the two is then dropped. This is the
    // second time that has happened in this engine.
    const open = literal.getStart() + 1;
    result.edits.push({
      file: literal.getSourceFile().getFilePath(),
      start: open,
      end: open,
      replacement: `\n      ${name}: ${JSON.stringify(value)},`,
      changeId: "raw-http",
      author: "codemod",
      reason: `newly required by ${rewrites.operationId}`,
    });
    result.manual.push(
      manual(
        first,
        "raw-http",
        `added \`${name}\`, which the contract now requires. The default came ` +
          "from the provider's Change, not from this codebase.",
      ),
    );
  }
}

function exactOf(node: Node | undefined, exponent: number): string | undefined {
  if (!node || !Node.isNumericLiteral(node)) return undefined;
  return exactMinorUnits(node.getText(), exponent);
}

/**
 * Reads of a decoded response, which look like `payload["amount"]`.
 *
 * Only index access with a string literal is touched. A dynamic key is exactly
 * the case where a name-based rewrite would be wrong, so it is left alone.
 */
function rewriteReads(
  source: Node,
  result: RawResult,
  rewrites: Omit<Rewrites, "added" | "operationId">,
): void {
  for (const access of source.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
    const argument = access.getArgumentExpression();
    if (!argument || !Node.isStringLiteral(argument)) continue;

    const name = argument.getLiteralValue();
    const renamed = rewrites.renames.get(name);
    const exponent = rewrites.scales.get(renamed ?? name);
    if (renamed === undefined && exponent === undefined) continue;

    const object = access.getExpression().getText();
    let text = `${object}[${JSON.stringify(renamed ?? name)}]`;

    // A read is usually asserted straight away: `payload["amount"] as number`.
    // The conversion has to wrap the assertion, not sit inside it.
    const parent = access.getParent();
    const outer = parent && Node.isAsExpression(parent) ? parent : access;
    if (Node.isAsExpression(outer))
      text = `${text} as ${outer.getTypeNode()?.getText() ?? "number"}`;

    if (exponent !== undefined && rewrites.helpers) {
      text = `${exponent > 0 ? rewrites.helpers.fromMinor : rewrites.helpers.toMinor}(${text})`;
    }

    result.edits.push({
      file: access.getSourceFile().getFilePath(),
      start: outer.getStart(),
      end: outer.getEnd(),
      replacement: text,
      changeId: "raw-http",
      author: "codemod",
      reason: "matched by name in an untyped response",
    });
    result.manual.push(
      manual(
        access,
        "raw-http",
        `changed the read of \`${name}\` in an untyped response. Nothing checks ` +
          "this against the provider's schema.",
      ),
    );
  }

  // Comparisons against a value whose vocabulary changed.
  for (const literal of source.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
    const value = literal.getLiteralValue();
    for (const map of rewrites.enums.values()) {
      const mapped = map[value];
      if (mapped === undefined || mapped === value) continue;
      result.edits.push({
        file: literal.getSourceFile().getFilePath(),
        start: literal.getStart(),
        end: literal.getEnd(),
        replacement: JSON.stringify(mapped),
        changeId: "raw-http",
        author: "codemod",
        reason: `the contract now calls "${value}" "${mapped}"`,
      });
      result.manual.push(
        manual(
          literal,
          "raw-http",
          `replaced the text "${value}" with "${mapped}". This matched a value ` +
            "the contract renamed, but nothing proves this string was that value.",
        ),
      );
      break;
    }
  }
}

function bumpHeader(
  options: Node | undefined,
  header: { name: string; from: string; to: string },
  result: RawResult,
): void {
  if (!options || !Node.isObjectLiteralExpression(options)) return;
  const headers = options.getProperty("headers");
  if (!headers || !Node.isPropertyAssignment(headers)) return;

  const value = headers.getInitializer();
  if (!value || !Node.isObjectLiteralExpression(value)) return;

  for (const property of value.getProperties()) {
    if (!Node.isPropertyAssignment(property)) continue;
    const name = property.getName().replace(/^["']|["']$/g, "");
    if (name.toLowerCase() !== header.name.toLowerCase()) continue;

    const initializer = property.getInitializer();
    if (!initializer || !Node.isStringLiteral(initializer)) continue;
    if (initializer.getLiteralValue() !== header.from) continue;

    result.edits.push({
      file: property.getSourceFile().getFilePath(),
      start: initializer.getStart(),
      end: initializer.getEnd(),
      replacement: JSON.stringify(header.to),
      changeId: "raw-http",
      author: "codemod",
      reason: "this caller now speaks the newer contract",
    });
  }
}
