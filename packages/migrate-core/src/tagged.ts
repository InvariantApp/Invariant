/**
 * Objects written out by hand that say which of the API's schemas they are.
 *
 * Some APIs tag every object they send with its own type: a Stripe invoice
 * carries `"object": "invoice"`, a line item `"object": "line_item"`. A test
 * fixture or a recorded webhook copies that tag with everything else, so a
 * literal nothing types, a JSON string in a Go test or a Python dictionary,
 * still names its schema exactly. Where the upgrade removed or moved a field
 * of that schema and the literal still holds it, the literal is shaped by an
 * API version the upgraded SDK no longer speaks, and that is certain from the
 * tag alone. Each such entry is shown to a person; none is edited, since what
 * a fixture should hold instead is the API's answer to a request, not a
 * rewrite of the old one.
 *
 * The text is read the same way whatever the language, as JSON-like entries
 * inside braces: `"key": value`, `'key': value` or `key: value`. Strings are
 * skipped only within a line, so a Go raw string or a Python triple-quoted
 * one holding JSON is read as the JSON it holds.
 */
import type { Change } from "@invariant-app/ir";
import type { ManualSite } from "./sites.ts";

/** How a contract's objects name their own schema. */
export interface WireTags {
  /** The property every object carries its schema's tag in: Stripe's `object`. */
  property: string;
  /** Each tag to the schema it names: `invoice` to `invoice`, `line_item` to `line_item`. */
  schemas: Record<string, string>;
  /**
   * Where an object records the API version it was shaped by, as a Stripe
   * event's `api_version`, the version the consumer's SDK speaks today
   * (`from`) and the one the upgraded SDK speaks (`label`). Only a fixture
   * recording `from` followed the SDK and is moved by the upgrade; one
   * recording a version older still was left behind long before it.
   */
  version?: {
    schema: string;
    property: string;
    from: string;
    label: string;
    sdk?: string;
  };
}

/** What the upgrade did to one field of a schema, as a path from the object. */
interface Gone {
  path: string[];
  changeId: string;
  reason: string;
}

const SCHEMA_PREFIX = "#/components/schemas/";

const segmentsOf = (pointer: string) =>
  pointer
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));

/** Every field each schema lost or moved in the Changes, by schema name. */
export function goneFields(changes: readonly Change[]): Map<string, Gone[]> {
  const gone = new Map<string, Gone[]>();
  for (const change of changes) {
    for (const op of change.ops) {
      if (op.op !== "remove" && op.op !== "move") continue;
      const path = segmentsOf(op.op === "move" ? op.from : op.path);
      if (path.length === 0) continue;
      const reason =
        op.op === "move"
          ? `\`${path.join(".")}\` moved to \`${segmentsOf(op.to).join(".")}\``
          : `\`${path.join(".")}\` is no longer in the API`;
      for (const scope of change.scopes ?? []) {
        if (!("schema" in scope) || !scope.schema.startsWith(SCHEMA_PREFIX)) continue;
        const schema = scope.schema.slice(SCHEMA_PREFIX.length);
        gone.set(schema, [
          ...(gone.get(schema) ?? []),
          { path, changeId: change.id, reason },
        ]);
      }
    }
  }
  return gone;
}

/** The structure of a text: its brackets, commas and colons outside strings, and its strings. */
interface Structure {
  /** Index of each bracket's partner, for brackets that have one. */
  partner: Map<number, number>;
  /** Openings of braces, in order, with their closings. */
  braces: [number, number][];
  /** String literals, start to end (end exclusive, quotes included). */
  strings: Map<number, number>;
}

const OPEN = "{[(";
const CLOSE = "}])";

function structureOf(text: string): Structure {
  const partner = new Map<number, number>();
  const braces: [number, number][] = [];
  const strings = new Map<number, number>();
  const stack: number[] = [];
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] as string;
    if (char === '"' || char === "'") {
      // A string ends on its line; a quote with no partner there is some
      // other syntax (a Python triple quote's third, an apostrophe in a
      // comment) and is read past.
      let end = at + 1;
      while (end < text.length && text[end] !== char && text[end] !== "\n") {
        end += text[end] === "\\" ? 2 : 1;
      }
      if (end < text.length && text[end] === char) {
        strings.set(at, end + 1);
        at = end;
      }
      continue;
    }
    if (OPEN.includes(char)) {
      stack.push(at);
      continue;
    }
    const closing = CLOSE.indexOf(char);
    if (closing === -1) continue;
    // Unwind to the opening this closes, dropping any left unclosed.
    for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
      const opening = stack[depth] as number;
      if (text[opening] !== OPEN[closing]) continue;
      stack.length = depth;
      partner.set(opening, at);
      partner.set(at, opening);
      if (char === "}") braces.push([opening, at]);
      break;
    }
  }
  braces.sort((a, b) => a[0] - b[0]);
  return { partner, braces, strings };
}

/** One `key: value` of an object literal. */
interface Entry {
  key: string;
  /** Where the entry starts (its key) and its value ends. */
  start: number;
  end: number;
  valueStart: number;
}

const KEY =
  /^(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|([A-Za-z_$][\w$]*))\s*:(?!:)/;

/** The entries of the object whose braces are at `open` and `close`. */
function entriesOf(
  text: string,
  structure: Structure,
  open: number,
  close: number,
): Entry[] {
  const entries: Entry[] = [];
  let at = open + 1;
  while (at < close) {
    // The next entry starts at the first character that is not layout.
    while (at < close && /[\s,]/.test(text[at] as string)) at += 1;
    if (at >= close) break;
    const start = at;
    // Its end is the next comma outside strings and brackets, or the close.
    let end = at;
    while (end < close && text[end] !== ",") {
      const skip = structure.strings.get(end) ?? structure.partner.get(end);
      end =
        skip !== undefined && skip > end
          ? skip + (structure.strings.has(end) ? 0 : 1)
          : end + 1;
    }
    const match = KEY.exec(text.slice(start, Math.min(end, start + 400)));
    if (match) {
      let valueEnd = end;
      while (valueEnd > start && /\s/.test(text[valueEnd - 1] as string)) valueEnd -= 1;
      entries.push({
        key: (match[1] ?? match[2] ?? match[3]) as string,
        start,
        end: valueEnd,
        valueStart: start + match[0].length,
      });
    }
    at = end + 1;
  }
  return entries;
}

/** The string a value is, where it is one quoted string and nothing else. */
function stringValue(text: string, entry: Entry): string | undefined {
  const value = text.slice(entry.valueStart, entry.end).trim();
  const match = /^(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)')$/.exec(value);
  return match ? (match[1] ?? match[2]) : undefined;
}

/** The object literal a value opens, where it is one. */
function objectAt(
  text: string,
  structure: Structure,
  entry: Entry,
): [number, number] | undefined {
  let at = entry.valueStart;
  while (at < entry.end && /\s/.test(text[at] as string)) at += 1;
  const close = text[at] === "{" ? structure.partner.get(at) : undefined;
  return close === undefined ? undefined : [at, close];
}

/** The object literals a list value holds, where it is one. */
function itemsAt(text: string, structure: Structure, entry: Entry): [number, number][] {
  let at = entry.valueStart;
  while (at < entry.end && /\s/.test(text[at] as string)) at += 1;
  const close = text[at] === "[" ? structure.partner.get(at) : undefined;
  if (close === undefined) return [];
  return structure.braces.filter(
    ([open, end]) =>
      open > at &&
      end < close &&
      // Only the list's own items, not objects inside them.
      !structure.braces.some(
        ([outer, outerEnd]) => outer > at && outer < open && outerEnd > end,
      ),
  );
}

/** The entry at `path` inside the object at `[open, close]`, through nested objects and lists. */
function entriesAtPath(
  text: string,
  structure: Structure,
  object: [number, number],
  path: readonly string[],
): Entry[] {
  const [head, ...rest] = path;
  if (head === undefined) return [];
  const entry = entriesOf(text, structure, object[0], object[1]).find(
    (each) => each.key === head,
  );
  if (!entry) return [];
  if (rest.length === 0) return [entry];
  if (rest[0] === "*") {
    return itemsAt(text, structure, entry).flatMap((item) =>
      entriesAtPath(text, structure, item, rest.slice(1)),
    );
  }
  const inner = objectAt(text, structure, entry);
  return inner ? entriesAtPath(text, structure, inner, rest) : [];
}

function siteOf(
  file: string,
  text: string,
  entry: Entry,
  changeId: string,
  reason: string,
): ManualSite {
  const before = text.slice(0, entry.start);
  const lineStart = before.lastIndexOf("\n") + 1;
  const lineEnd = text.indexOf("\n", entry.start);
  return {
    file,
    line: before.split("\n").length,
    column: entry.start - lineStart + 1,
    changeId,
    reason,
    snippet: text
      .slice(lineStart, lineEnd === -1 ? text.length : lineEnd)
      .trim()
      .slice(0, 120),
    offset: entry.start,
    end: entry.end,
  };
}

/**
 * Every entry of a tagged object literal in `text` that the Changes removed
 * or moved from the schema its tag names, and every recorded API version
 * other than the one the upgraded SDK speaks, as sites for a person.
 */
export function taggedObjectSites(
  file: string,
  text: string,
  changes: readonly Change[],
  tags: WireTags,
  gone: Map<string, Gone[]> = goneFields(changes),
): ManualSite[] {
  if (!text.includes(tags.property)) return [];
  const tagPattern = new RegExp(
    `(?<![\\w$.])(["']?)${tags.property.replace(/[^\w]/g, "\\$&")}\\1\\s*:`,
    "g",
  );
  const tagsAt = [...text.matchAll(tagPattern)].map((match) => match.index);
  if (tagsAt.length === 0) return [];
  const structure = structureOf(text);
  // Only the braces a tag is written directly inside: a minified bundle has
  // tens of thousands of others.
  const tagged = new Set<[number, number]>();
  for (const at of tagsAt) {
    let inner: [number, number] | undefined;
    for (const brace of structure.braces) {
      if (brace[0] > at) break;
      if (brace[1] > at) inner = brace;
    }
    if (inner) tagged.add(inner);
  }
  const sites: ManualSite[] = [];
  const seen = new Set<string>();
  for (const [open, close] of tagged) {
    const entries = entriesOf(text, structure, open, close);
    const tag = entries.find((entry) => entry.key === tags.property);
    const value = tag && stringValue(text, tag);
    const schema = value === undefined ? undefined : tags.schemas[value];
    if (!schema) continue;
    for (const field of gone.get(schema) ?? []) {
      for (const entry of entriesAtPath(text, structure, [open, close], field.path)) {
        const key = `${entry.start}:${field.changeId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        sites.push(
          siteOf(
            file,
            text,
            entry,
            field.changeId,
            `${field.reason} on \`${schema}\`, and this object is one by its \`${tags.property}\` tag, so it is shaped by an API version before the one the upgraded SDK speaks`,
          ),
        );
      }
    }
    const version = tags.version;
    if (version && schema === version.schema) {
      const entry = entries.find((each) => each.key === version.property);
      const recorded = entry && stringValue(text, entry);
      if (entry && recorded === version.from && recorded !== version.label) {
        sites.push(
          siteOf(
            file,
            text,
            entry,
            "api-version",
            `this \`${schema}\` records API version ${recorded}; ${version.sdk ?? "the upgraded SDK"} speaks ${version.label}, and the objects it carries are shaped by the version it records`,
          ),
        );
      }
    }
  }
  return sites.sort((a, b) => a.offset - b.offset);
}
