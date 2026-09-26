/**
 * Rig E: which contract sites the upgrade forced.
 *
 * A site classed as following from a contract change can still be a choice:
 * the humans adopting a new tool version, a new endpoint or a new flow while
 * their old code went on working. L8 asks how much of the work an upgrade
 * forces the engine handles, so a site counts as forced only where the lines
 * the humans removed or wrote name an element the pinned differ reports
 * broken between the two contracts, by the release gate's own policy: the
 * property, parameter, value or schema an entry is about, or the path of an
 * operation that went away.
 *
 * The judgement reads the differ and the humans' text, never what the engine
 * did, so the engine cannot grade itself. Names are compared without case or
 * underscores, so `amount_refunded` is found in Go's `AmountRefunded` and in
 * TypeScript's `amountRefunded`. A case without both specifications is not
 * judged, and is counted as such rather than as either.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { OpenApiDocument } from "@invariant-app/contract";
import { breakingEntries, type DiffEntry, diffDocuments } from "@invariant-app/diff";

/** Words the differ's sentences quote that name structure, not an element. */
const STRUCTURAL = new Set(
  [
    "items",
    "properties",
    "oneof",
    "anyof",
    "allof",
    "components",
    "schemas",
    "application",
    "json",
    "default",
    "subschema",
    // A type's name, or a word every language spells as a keyword, is written
    // everywhere and names no element of the API: `None` is not the enum
    // value `none`.
    "string",
    "number",
    "integer",
    "boolean",
    "array",
    "object",
    "list",
    "dict",
    "none",
    "null",
    "true",
    "false",
  ].map((word) => word.toLowerCase()),
);

/**
 * How many schemas may declare a property of one name before the name alone
 * no longer says which of them a site touches: `type` is a property of 463 of
 * openai's schemas and `content` of 35, while `function_call` is of 4 and
 * `amount_refunded` of 2 of Stripe's. Ten is about the ninetieth percentile
 * of the three.
 */
export const MAX_SHARED = 10;

/** How many schemas of a document declare each property name, normalised. */
export function propertyCounts(document: OpenApiDocument): Map<string, number> {
  const counts = new Map<string, number>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const each of value) walk(each);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const properties = (value as { properties?: unknown }).properties;
    if (
      typeof properties === "object" &&
      properties !== null &&
      !Array.isArray(properties)
    ) {
      for (const name of Object.keys(properties)) {
        counts.set(normalName(name), (counts.get(normalName(name)) ?? 0) + 1);
      }
    }
    for (const each of Object.values(value)) walk(each);
  };
  walk(document);
  return counts;
}

/** A name as it is compared: without case or underscores. */
export const normalName = (name: string): string => name.replace(/_/g, "").toLowerCase();

const tokens = (text: string): string[] =>
  text.split(/[^A-Za-z0-9_]+/).filter((token) => token !== "");

/** Short or numeric tokens (`v1`, `200`) name nothing a site could be found by. */
const naming = (token: string): boolean =>
  normalName(token).length >= 4 &&
  !/^\d/.test(token) &&
  !STRUCTURAL.has(normalName(token));

/**
 * The names the breaking entries of a diff touch, normalised. Each entry
 * quotes what it is about in backticks; an operation's path is only a name
 * when the operation itself went away, since every other entry on
 * `/v1/messages` would otherwise make `messages` a broken name.
 */
export function breakingNames(
  entries: readonly DiffEntry[],
  /** Names too many schemas declare to say which one a site touches. */
  ambiguous: ReadonlySet<string> = new Set(),
): string[] {
  const names = new Set<string>();
  for (const entry of breakingEntries(entries)) {
    // An entry that names a schema is about that schema: a variant added to
    // `content` is about the variant, not every `content` in a consumer.
    // Otherwise a quoted path names its last element: `data/items/amount_refunded`
    // is about `amount_refunded`, not every `data`.
    const quoted = [...entry.text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
    const schemas = quoted.filter((text) => text.startsWith("#/components/schemas/"));
    for (const text of schemas.length > 0 ? schemas : quoted) {
      const last = tokens(text).filter(naming).at(-1);
      if (last) names.add(normalName(last));
    }
    if (entry.id.startsWith("api-")) {
      for (const token of tokens(entry.path))
        if (naming(token)) names.add(normalName(token));
    }
  }
  return [...names].filter((name) => !ambiguous.has(name)).sort();
}

/**
 * The names a line writes where an element of an API can be named: inside a
 * string (a key, a value, `"amount_refunded"`), read as a member
 * (`.amount_refunded`, Go's `.AmountRefunded`), as a keyword or an object's
 * key (`expand=`, `amountRefunded:`), or as a type (`PaymentIntent`). A bare
 * lowercase name is the consumer's own variable, whatever the API calls its
 * fields: `result` in `"content": result` is not the property `result`.
 */
export function namesWritten(line: string): string[] {
  const found: string[] = [];
  for (const match of line.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    found.push(...tokens(match[2] ?? ""));
  }
  const bare = line.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, " ");
  for (const pattern of [
    /\.\s*([A-Za-z_]\w*)/g,
    // An object's key or a struct's field, wherever a key can start.
    /(?:^|[(,{])\s*([A-Za-z_]\w*)\s*:(?![=:])/g,
    // A keyword argument: after `(` or `,`, or alone on its line written
    // without spaces, which an assignment to a local is not.
    /[(,]\s*([A-Za-z_]\w*)\s*=(?!=)/g,
    /^\s*([A-Za-z_]\w*)=(?!=)/g,
    /\b([A-Z][a-z0-9]+[A-Z]\w*)\b/g,
  ]) {
    for (const match of bare.matchAll(pattern)) found.push(match[1] as string);
  }
  return [...new Set(found)];
}

/** The first broken name a site's lines write, or undefined when the site is a choice. */
export function forcedBy(
  lines: readonly string[],
  names: ReadonlySet<string>,
): string | undefined {
  for (const line of lines) {
    for (const token of namesWritten(line)) {
      if (naming(token) && names.has(normalName(token))) return token;
    }
  }
  return undefined;
}

/**
 * The broken names between two specifications, kept in `cache` so each pair
 * of releases is diffed once. Undefined when the differ cannot say, which
 * leaves the case not judged.
 */
export async function breakingBetween(
  before: OpenApiDocument,
  after: OpenApiDocument,
  cache: string,
): Promise<string[] | undefined> {
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8")) as string[];
  try {
    // Only the breaking entries are needed, and the full changelog between
    // releases years apart is too large to hold.
    const counts = [propertyCounts(before), propertyCounts(after)];
    const ambiguous = new Set(
      counts.flatMap((each) =>
        [...each].filter(([, count]) => count > MAX_SHARED).map(([name]) => name),
      ),
    );
    const names = breakingNames(
      await diffDocuments(before, after, { mode: "breaking" }),
      ambiguous,
    );
    await mkdir(dirname(cache), { recursive: true });
    await writeFile(cache, `${JSON.stringify(names)}\n`);
    return names;
  } catch (error) {
    process.stderr.write(
      `no breaking names for ${cache}: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}\n`,
    );
    return undefined;
  }
}
