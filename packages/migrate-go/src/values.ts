/**
 * What the Changes do to the values a Go consumer writes, not only to names.
 *
 * The helper reports what the type checker records: which string literals
 * have one of the SDK's named types, which composite literals build one of
 * its structs, and where each field is read, written or given in a literal.
 * Every edit here follows from those types:
 *
 * - A value the contract renamed is rewritten wherever a literal has the
 *   SDK's named type for that field's values, which is where the compiler
 *   converts it to one: compared with the field, sent in a request, listed in
 *   a `[]CustomerStatus`, or compared inside the consumer's own helper that
 *   takes a `CustomerStatus`. A literal of plain `string` is left alone.
 * - An amount now in minor units is read through the SDK's exact conversion
 *   and written through the other one, and a literal is converted on its
 *   digits, so no arithmetic is ever written into the consumer's code.
 * - A field that moved into an object is read through it and written into a
 *   literal of it, `Contact: &sdk.Contact{Phone: mobile}`.
 * - A field a request now requires is written into each literal that builds
 *   one, and a literal that stands in for a response that gained a field is
 *   shown, since what it should hold there is the consumer's to say.
 */
import { type Edit, exactMinorUnits, type ManualSite } from "@invariant-app/migrate-core";
import type { GoImport, GoReference } from "./engine.ts";
import type { GoMigrationPlan, GoMove, GoScale, GoSupply } from "./plan.ts";
import { type GoSymbol, symbolId } from "./surface.ts";

/** A string literal the checker gives one of the SDK's named types (byte offsets). */
export interface GoConstant extends GoSymbol {
  file: string;
  start: number;
  end: number;
  line: number;
  value: string;
}

/** A string key read from a map of untyped JSON (byte offsets). */
export interface GoKey {
  file: string;
  start: number;
  end: number;
  line: number;
  key: string;
  spanStart: number;
  spanEnd: number;
}

/** A composite literal of one of the SDK's struct types (byte offsets). */
export interface GoLiteral extends GoSymbol {
  file: string;
  start: number;
  end: number;
  line: number;
  lbrace: number;
  rbrace: number;
  keys: string[];
  positional?: boolean;
  elements: [number, number][];
}

export interface ValueFacts {
  imports: readonly GoImport[];
  references: readonly GoReference[];
  constants?: readonly GoConstant[];
  literals?: readonly GoLiteral[];
}

/** A site shown to a person, `start` to `end` of `text` as it was read. */
export function siteIn(
  file: string,
  text: string,
  start: number,
  end: number,
  changeId: string,
  reason: string,
  at?: number,
): ManualSite {
  const before = text.slice(0, start);
  return {
    file,
    line: before.split("\n").length,
    column: start - before.lastIndexOf("\n"),
    changeId,
    reason,
    snippet: text.slice(start, Math.min(end, start + 120)),
    offset: start,
    end,
    ...(at !== undefined && at !== start ? { at } : {}),
  };
}

/** A value as a Go literal of a field's type, where it is one. */
export function goLiteral(
  value: unknown,
  type: string,
  underlying?: string,
): string | undefined {
  const basic = underlying ?? type;
  if (basic === "string")
    return typeof value === "string" ? JSON.stringify(value) : undefined;
  if (basic === "bool") return typeof value === "boolean" ? String(value) : undefined;
  if (/^u?int(?:8|16|32|64)?$|^uintptr$|^byte$|^rune$/.test(basic)) {
    return Number.isSafeInteger(value) ? String(value) : undefined;
  }
  if (/^float(?:32|64)$/.test(basic)) {
    return typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : undefined;
  }
  return undefined;
}

/**
 * The edit that writes `entry` last in a composite literal, keeping its
 * layout: after a comma on one line, or on a line of its own at the
 * elements' indent. The closing brace is part of the edit, so an edit of the
 * last element that ends where this one starts stays beside it.
 */
export function appendedElement(
  text: string,
  lbrace: number,
  rbrace: number,
  elements: readonly [number, number][],
  entry: string,
): { start: number; end: number; replacement: string } | undefined {
  const last = elements.at(-1);
  if (!last) return { start: lbrace + 1, end: rbrace + 1, replacement: `${entry}}` };
  const comma = /^\s*,/.exec(text.slice(last[1], rbrace));
  const from = comma ? last[1] + comma[0].length : last[1];
  const between = text.slice(from, rbrace);
  if (!between.includes("\n")) {
    return {
      start: from,
      end: rbrace + 1,
      replacement: `${comma ? " " : ", "}${entry}${between}}`,
    };
  }
  const lineStart = text.lastIndexOf("\n", last[0] - 1) + 1;
  const indent = text.slice(lineStart, last[0]);
  if (!/^[ \t]*$/.test(indent)) return undefined;
  return {
    start: from,
    end: rbrace + 1,
    replacement: `${comma ? "" : ","}\n${indent}${entry},${between}}`,
  };
}

export async function valueEdits(
  facts: ValueFacts,
  plan: GoMigrationPlan,
  textOf: (file: string) => Promise<string>,
  indexOf: (file: string, byte: number) => number,
): Promise<{ edits: Edit[]; manual: ManualSite[] }> {
  const edits: Edit[] = [];
  const manual: ManualSite[] = [];
  const from = plan.symbols.module.path;
  // What each file calls each of the SDK's packages it imports.
  const names = new Map(
    facts.imports.map((imported) => [
      `${imported.file}\u0000${imported.path}`,
      imported.name ?? "",
    ]),
  );
  /** How a file names what a package of the SDK declares: `sdk.`, or nothing through a dot import. */
  const qualifier = (file: string, pkg: string): string | undefined => {
    const name = names.get(`${file}\u0000${pkg === "" ? from : `${from}/${pkg}`}`);
    if (!name || name === "_") return undefined;
    return name === "." ? "" : `${name}.`;
  };
  const codemod = (
    file: string,
    start: number,
    end: number,
    replacement: Edit["replacement"],
    changeId: string,
    reason: string,
  ): Edit => ({ file, start, end, replacement, changeId, author: "codemod", reason });

  // Values of the SDK's named types the contract renamed.
  const renamed = new Map(
    (plan.values ?? []).map((value) => [
      `${symbolId(value.type)}\u0000${value.from}`,
      value,
    ]),
  );
  for (const constant of facts.constants ?? []) {
    const rename = renamed.get(`${symbolId(constant)}\u0000${constant.value}`);
    if (!rename) continue;
    const text = await textOf(constant.file);
    const start = indexOf(constant.file, constant.start);
    const end = indexOf(constant.file, constant.end);
    const raw = text[start] === "`" && !rename.to.includes("`");
    edits.push(
      codemod(
        constant.file,
        start,
        end,
        raw ? `\`${rename.to}\`` : JSON.stringify(rename.to),
        rename.changeId,
        rename.reason,
      ),
    );
  }

  await convertAmounts(facts, plan.scales ?? [], {
    textOf,
    indexOf,
    qualifier,
    codemod,
    edits,
    manual,
  });
  await moveFields(facts, plan.moves ?? [], {
    textOf,
    indexOf,
    qualifier,
    codemod,
    edits,
    manual,
  });
  await supplyFields(facts, plan.supplies ?? [], { textOf, indexOf, edits, manual });
  return { edits, manual };
}

interface Writing {
  textOf: (file: string) => Promise<string>;
  indexOf: (file: string, byte: number) => number;
  qualifier: (file: string, pkg: string) => string | undefined;
  codemod: (
    file: string,
    start: number,
    end: number,
    replacement: Edit["replacement"],
    changeId: string,
    reason: string,
  ) => Edit;
  edits: Edit[];
  manual: ManualSite[];
}

/** Reads and writes of amounts whose unit changed, converted with the SDK's helpers. */
async function convertAmounts(
  facts: ValueFacts,
  scales: readonly GoScale[],
  writing: Writing,
): Promise<void> {
  if (scales.length === 0) return;
  const { textOf, indexOf, qualifier, codemod, edits, manual } = writing;
  const scaled = new Map(scales.map((scale) => [symbolId(scale.field), scale]));
  const at = (file: string, start: number, end: number) => `${file}:${start}:${end}`;
  // A value that is itself a read of an amount now in the same unit is sent
  // on as it is: neither the read nor the write is converted.
  const reads = new Map<string, GoReference>();
  for (const reference of facts.references) {
    if (reference.role === "read" && scaled.has(symbolId(reference))) {
      reads.set(at(reference.file, reference.spanStart, reference.spanEnd), reference);
    }
  }
  const passing = new Set<GoReference>();
  for (const reference of facts.references) {
    const scale = scaled.get(symbolId(reference));
    if (!scale || !reference.value) continue;
    const read = reads.get(at(reference.file, reference.value[0], reference.value[1]));
    if (read && scaled.get(symbolId(read))?.exponent === scale.exponent) {
      passing.add(reference);
      passing.add(read);
    }
  }
  for (const reference of facts.references) {
    const scale = scaled.get(symbolId(reference));
    if (!scale || passing.has(reference)) continue;
    const { file } = reference;
    const text = await textOf(file);
    const reading = scale.exponent > 0 ? scale.fromMinor : scale.toMinor;
    const writingHelper = scale.exponent > 0 ? scale.toMinor : scale.fromMinor;
    const flag = (why: string) =>
      manual.push(
        siteIn(
          file,
          text,
          indexOf(file, reference.spanStart),
          indexOf(file, reference.spanEnd),
          scale.changeId,
          `${scale.reason}; ${why}`,
          indexOf(file, reference.start),
        ),
      );
    const helper = (symbol: GoSymbol) => {
      const qualified = qualifier(file, symbol.package);
      if (qualified === undefined) {
        flag(
          `convert it with the SDK's \`${symbol.key}\`, from a package this file does not import`,
        );
      }
      return qualified === undefined ? undefined : `${qualified}${symbol.key}`;
    };
    if (reference.role === "read") {
      if (reference.nilChecked) {
        flag(
          `this reads it from a value the function checks for nil; decide what the result should be when there is nothing there, then convert it with the SDK's \`${reading.key}\``,
        );
        continue;
      }
      if (reference.addressed) {
        flag(`this takes its address, which a converted value does not have`);
        continue;
      }
      const name = helper(reading);
      if (!name) continue;
      edits.push(
        codemod(
          file,
          indexOf(file, reference.spanStart),
          indexOf(file, reference.spanEnd),
          (inner) => `${name}(${inner})`,
          scale.changeId,
          "converted the amount to the unit the contract now uses",
        ),
      );
      continue;
    }
    if (
      (reference.role === "literal-key" || reference.role === "write") &&
      reference.value
    ) {
      const start = indexOf(file, reference.value[0]);
      const end = indexOf(file, reference.value[1]);
      const exact =
        scale.exponent > 0
          ? exactMinorUnits(text.slice(start, end), scale.exponent)
          : undefined;
      const name = exact === undefined ? helper(writingHelper) : undefined;
      if (exact === undefined && !name) continue;
      edits.push(
        codemod(
          file,
          start,
          end,
          exact ?? ((inner) => `${name}(${inner})`),
          scale.changeId,
          "converted the amount to the unit the contract now uses",
        ),
      );
      continue;
    }
    flag(
      `convert this use of it by hand with the SDK's \`${reading.key}\` and \`${writingHelper.key}\``,
    );
  }
}

/** Fields that moved into an object, read through it and written into a literal of it. */
async function moveFields(
  facts: ValueFacts,
  moves: readonly GoMove[],
  writing: Writing,
): Promise<void> {
  if (moves.length === 0) return;
  const { textOf, indexOf, qualifier, codemod, edits, manual } = writing;
  const moved = new Map(moves.map((move) => [symbolId(move.from), move]));
  /** Writes into one literal's object, held until every move is read (`Nesting` in the Python pack). */
  const claims = new Map<string, { edit: Edit; flag: () => void }[]>();
  for (const reference of facts.references) {
    const move = moved.get(symbolId(reference));
    if (!move) continue;
    const { file } = reference;
    const text = await textOf(file);
    const [head] = move.path as [GoMove["path"][number], ...GoMove["path"]];
    const flag = (why: string) =>
      manual.push(
        siteIn(
          file,
          text,
          indexOf(file, reference.spanStart),
          indexOf(file, reference.spanEnd),
          move.changeId,
          `${move.reason}; ${why}`,
          indexOf(file, reference.start),
        ),
      );
    const through = move.path.map((step) => step.name).join(".");
    // A read goes through the object; so does a write, where nothing on the
    // way is a pointer that could be nil.
    if (
      reference.role === "read" ||
      (reference.role === "write" &&
        move.path.slice(0, -1).every((step) => !step.type.startsWith("*")))
    ) {
      edits.push(
        codemod(
          file,
          indexOf(file, reference.start),
          indexOf(file, reference.end),
          through,
          move.changeId,
          `${move.reason}, and is read through \`${head.name}\``,
        ),
      );
      continue;
    }
    if (reference.role !== "literal-key" || !reference.value) {
      flag(
        reference.role === "write"
          ? `writing it through \`${head.name}\`, which may be nil, is for a person to write`
          : "rewrite this use of it by hand",
      );
      continue;
    }
    const literal = (facts.literals ?? [])
      .filter(
        (each) =>
          each.file === file &&
          each.lbrace < reference.start &&
          reference.end < each.rbrace,
      )
      .sort((a, b) => b.lbrace - a.lbrace)[0];
    const qualified = qualifier(file, move.from.package);
    if (!literal || literal.keys.includes(head.name) || qualified === undefined) {
      flag(
        literal?.keys.includes(head.name)
          ? `\`${head.name}\` is already written in this literal`
          : `write it into a \`${head.name}\` by hand`,
      );
      continue;
    }
    const start = indexOf(file, reference.spanStart);
    const prefix = indexOf(file, reference.value[0]) - start;
    const build = (path: GoMove["path"], value: string): string => {
      const [step, next, ...rest] = path;
      if (!step || !next) return value;
      const named = step.type.replace(/^\*/, "");
      return `${step.type.startsWith("*") ? "&" : ""}${qualified}${named}{${next.name}: ${build([next, ...rest], value)}}`;
    };
    const edit = codemod(
      file,
      start,
      indexOf(file, reference.spanEnd),
      (inner) => `${head.name}: ${build(move.path, inner.slice(prefix))}`,
      move.changeId,
      `${move.reason}, and is written inside \`${head.name}\``,
    );
    const key = `${file}:${literal.start}:${head.name}`;
    claims.set(key, [
      ...(claims.get(key) ?? []),
      {
        edit,
        flag: () =>
          flag(
            `more than one field moves into \`${head.name}\` here; write the one \`${head.name}\` by hand`,
          ),
      },
    ]);
  }
  for (const claimed of claims.values()) {
    if (claimed.length === 1) edits.push((claimed[0] as { edit: Edit }).edit);
    else for (const claim of claimed) claim.flag();
  }
}

/** Fields a struct gained, written into the literals that build one, or shown. */
async function supplyFields(
  facts: ValueFacts,
  supplies: readonly GoSupply[],
  writing: Pick<Writing, "textOf" | "indexOf" | "edits" | "manual">,
): Promise<void> {
  const { textOf, indexOf, edits, manual } = writing;
  for (const supply of supplies) {
    for (const literal of facts.literals ?? []) {
      if (symbolId(literal) !== symbolId(supply.type)) continue;
      if (literal.keys.includes(supply.field)) continue;
      const { file } = literal;
      const text = await textOf(file);
      const start = indexOf(file, literal.start);
      const end = indexOf(file, literal.end);
      const show = (reason: string) =>
        manual.push(siteIn(file, text, start, end, supply.changeId, reason));
      if (supply.value === null) {
        show(
          `this stands for a response that now has \`${supply.field}\` ("${supply.json}"); add the value it should hold`,
        );
        continue;
      }
      const written = goLiteral(supply.value, supply.fieldType, supply.underlying);
      const appended =
        written === undefined || literal.positional
          ? undefined
          : appendedElement(
              text,
              indexOf(file, literal.lbrace),
              indexOf(file, literal.rbrace),
              literal.elements.map(([from, to]) => [
                indexOf(file, from),
                indexOf(file, to),
              ]),
              `${supply.field}: ${written}`,
            );
      if (!appended) {
        show(
          `\`${supply.field}\` ("${supply.json}") must now be sent, and was always ${JSON.stringify(supply.value)} when left out; add it here`,
        );
        continue;
      }
      edits.push({
        file,
        ...appended,
        changeId: supply.changeId,
        author: "codemod",
        reason: "supplied the default this field always had before it became explicit",
      });
    }
  }
}
