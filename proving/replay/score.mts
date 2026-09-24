/**
 * Rig E, the score: the engine's edits laid over the humans'.
 *
 * Both are read the same way, as the regions of a file that changed between
 * the base commit and a result, so neither side is favoured by how its diff
 * was drawn. A human region the engine rewrote to the same lines is
 * identical; one it rewrote to other lines differs, and is left for a person
 * to judge equivalent or wrong; one it did not touch is missed. What the
 * engine changed where no human did is counted too, since an edit nobody
 * asked for is either more work done or a mistake, and either is worth
 * seeing.
 */

/** Lines `oldStart` to `oldEnd` (0-based, end exclusive) of the base became `lines`. */
export interface Region {
  oldStart: number;
  oldEnd: number;
  lines: string[];
}

/**
 * The regions where `after` differs from `before`, by the shortest edit
 * script (Myers). Changes that touch are one region.
 */
export function changedRegions(
  before: readonly string[],
  after: readonly string[],
): Region[] {
  // Only the middle can differ, and the trace below grows with it.
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }
  const middle = shortestEdit(
    before.slice(head, before.length - tail),
    after.slice(head, after.length - tail),
  );
  return middle.map((region) => ({
    ...region,
    oldStart: region.oldStart + head,
    oldEnd: region.oldEnd + head,
  }));
}

/**
 * The most trace the search may keep, in frontier entries (80 MB). A file
 * that needs more was rewritten rather than edited, and one region says so.
 */
const MAX_TRACE = 20_000_000;

function shortestEdit(before: readonly string[], after: readonly string[]): Region[] {
  const n = before.length;
  const m = after.length;
  if (n + m === 0) return [];
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d += 1) {
    if ((d + 1) * v.length > MAX_TRACE)
      return [{ oldStart: 0, oldEnd: n, lines: [...after] }];
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d ||
        (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number))
          ? (v[offset + k + 1] as number)
          : (v[offset + k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && before[x] === after[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  // Walk back through the trace, recording which lines were kept.
  const kept: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const row = trace[d] as Int32Array;
    const k = x - y;
    const previous =
      k === -d ||
      (k !== d && (row[offset + k - 1] as number) < (row[offset + k + 1] as number))
        ? k + 1
        : k - 1;
    const px = row[offset + previous] as number;
    const py = px - previous;
    while (x > px && y > py) {
      x -= 1;
      y -= 1;
      kept.push([x, y]);
    }
    if (d > 0) {
      x = px;
      y = py;
    }
  }
  kept.reverse();

  const regions: Region[] = [];
  let oldAt = 0;
  let newAt = 0;
  for (const [keptOld, keptNew] of [...kept, [n, m] as [number, number]]) {
    if (keptOld > oldAt || keptNew > newAt) {
      regions.push({
        oldStart: oldAt,
        oldEnd: keptOld,
        lines: after.slice(newAt, keptNew),
      });
    }
    oldAt = keptOld + 1;
    newAt = keptNew + 1;
  }
  return regions;
}

export interface Score {
  identical: number;
  differs: number;
  flagged: number;
  missed: number;
  /** Engine regions that overlap no human one. */
  extra: number;
  /** Places the engine flagged where no human changed anything: a reviewer's time spent for nothing. */
  extraFlags?: number;
  /**
   * Human regions that are new code: lines with nothing before them that
   * they replace, a new file or a new helper. Not sites of a contract
   * change, so neither handled nor missed; counted apart.
   */
  newCode?: number;
}

/**
 * `flagged`: the engine wrote nothing there and reported the place to a
 * person instead, which L8 counts as handled, apart from an edit. `new`: new
 * code the humans wrote (`newCode`), which is no site of a contract change.
 */
export type Outcome = "identical" | "differs" | "flagged" | "missed" | "new";

/**
 * A place the engine reported to a person: base lines `from` to `to`
 * (0-based, end exclusive) are what it showed, such as a whole statement,
 * and `at` the line where the changed element it points at is written.
 */
export interface Flag {
  from: number;
  to: number;
  at: number;
}

/** Whitespace is layout, and a formatter the repository runs would settle it. */
const normal = (lines: readonly string[]) =>
  lines.map((line) => line.trim()).filter((line) => line !== "");

function overlaps(a: Region, b: Region): boolean {
  // An insertion is a region of no lines, which overlaps what it touches.
  const aEnd = Math.max(a.oldEnd, a.oldStart + 1);
  const bEnd = Math.max(b.oldEnd, b.oldStart + 1);
  return a.oldStart < bEnd && b.oldStart < aEnd;
}

/**
 * Unchanged lines around a change in a unified diff, as git draws it: two
 * changes this close or closer share their context and are one hunk.
 */
const CONTEXT = 3;

/**
 * The human regions in hunks, as git would draw the diff: regions whose gap
 * of unchanged base lines is at most twice the context are one hunk. Each
 * hunk is the indexes of its regions, in `human`'s order.
 */
export function hunksOf(human: readonly Region[]): number[][] {
  const order = human
    .map((region, at) => ({ region, at }))
    .sort((a, b) => a.region.oldStart - b.region.oldStart);
  const hunks: number[][] = [];
  let end = Number.NEGATIVE_INFINITY;
  for (const { region, at } of order) {
    const current = hunks.at(-1);
    if (current && region.oldStart - end <= 2 * CONTEXT) current.push(at);
    else hunks.push([at]);
    end = Math.max(end, region.oldEnd);
  }
  return hunks;
}

/**
 * Each human region against the engine regions over the same lines. One
 * human region may be covered by several engine ones, which is identical when
 * together they produce the same lines from the base.
 *
 * A region the engine neither edited nor flagged is still flagged where the
 * humans rewrote code around a changed element: when a flag's element is on a
 * line the humans replaced in the same hunk, the hunk is the rewrite of what
 * the engine pointed at, and each of its regions counts as flagged. A flag
 * whose extent only reaches into the hunk, with its element outside every
 * line the humans replaced, does not carry the rest of the hunk.
 */
export function score(
  base: readonly string[],
  human: readonly Region[],
  engine: readonly Region[],
  /** What the engine reported to a person rather than edited. */
  flags: readonly Flag[] = [],
  /** Whether a human region is new code (`newCodeIn`). */
  isNew: (region: Region) => boolean = () => false,
): Score & { outcomes: Outcome[] } {
  const result: Score & { outcomes: Outcome[] } = {
    identical: 0,
    differs: 0,
    flagged: 0,
    missed: 0,
    extra: 0,
    newCode: 0,
    outcomes: [],
  };
  const reaches = (flag: Flag, site: Region) =>
    flag.from < Math.max(site.oldEnd, site.oldStart + 1) &&
    site.oldStart < Math.max(flag.to, flag.from + 1);
  // The hunks whose replaced lines hold a flagged element.
  const pointed = new Set<number>();
  for (const hunk of hunksOf(human)) {
    const replaced = hunk.some((index) => {
      const region = human[index] as Region;
      return flags.some((flag) => flag.at >= region.oldStart && flag.at < region.oldEnd);
    });
    if (replaced) for (const index of hunk) pointed.add(index);
  }
  const used = new Set<Region>();
  human.forEach((site, index) => {
    if (isNew(site)) {
      result.newCode = (result.newCode ?? 0) + 1;
      result.outcomes.push("new");
      return;
    }
    const covering = engine.filter((region) => overlaps(site, region));
    if (covering.length === 0) {
      const flagged = flags.some((flag) => reaches(flag, site)) || pointed.has(index);
      result[flagged ? "flagged" : "missed"] += 1;
      result.outcomes.push(flagged ? "flagged" : "missed");
      return;
    }
    for (const region of covering) used.add(region);
    const inside = covering.every(
      (region) => region.oldStart >= site.oldStart && region.oldEnd <= site.oldEnd,
    );
    const same =
      inside &&
      normal(applied(base, site, covering)).join("\n") === normal(site.lines).join("\n");
    if (same) result.identical += 1;
    else result.differs += 1;
    result.outcomes.push(same ? "identical" : "differs");
  });
  result.extra = engine.filter((region) => !used.has(region)).length;
  result.extraFlags = flags.filter(
    (flag) => !human.some((site) => reaches(flag, site)),
  ).length;
  return result;
}

/** The languages a region is read as new code in. */
export type CodeLanguage = "typescript" | "javascript" | "python" | "go";

const DEFINITION: Record<CodeLanguage, RegExp> = {
  python: /^(async\s+def|def|class)\s+\w/,
  go: /^(func|type)\s/,
  typescript:
    /^(export\s+)?(default\s+)?(declare\s+)?(async\s+function|function\*?|abstract\s+class|class|interface|enum|type\s+\w+(\s*<[^>]*>)?\s*=|(const|let)\s+\w+(\s*:[^=]+)?\s*=\s*(async\s+)?(function\b|(\([^)]*\)|\w+)\s*(:\s*[^=]+)?=>))/,
  javascript:
    /^(export\s+)?(default\s+)?(async\s+function|function\*?|class|(const|let|var)\s+\w+\s*=\s*(async\s+)?(function\b|(\([^)]*\)|\w+)\s*=>))/,
};

/** A line that says nothing about what code it is part of. */
const QUIET: Record<CodeLanguage, RegExp> = {
  python: /^\s*($|#)/,
  go: /^\s*($|\/\/)/,
  typescript: /^\s*($|\/\/|\/\*|\*)/,
  javascript: /^\s*($|\/\/|\/\*|\*)/,
};

/**
 * Whether a human region is new code: in a file the base did not have (or
 * held nothing in), or lines inserted where none were replaced that are
 * whole definitions and nothing else, a new function or class with its body.
 * Lines added inside an existing statement, a keyword argument or a key in a
 * dictionary, are not: they change what was there.
 */
export function newCodeIn(
  base: readonly string[],
  region: Region,
  language: CodeLanguage,
): boolean {
  if (base.every((line) => line.trim() === "")) return region.lines.length > 0;
  if (region.oldEnd > region.oldStart) return false;
  const quiet = QUIET[language];
  const lines = region.lines.filter((line) => !quiet.test(line));
  if (lines.length === 0) return false;
  const indent = (line: string) => /^\s*/.exec(line)?.[0].length ?? 0;
  if (language === "python") {
    // Decorators, then a definition; everything after it deeper than it,
    // or another decorated definition at its depth.
    const depth = indent(lines[0] as string);
    let header = false;
    for (const line of lines) {
      const text = line.trim();
      if (indent(line) > depth) {
        if (!header) return false;
        continue;
      }
      if (indent(line) < depth) return false;
      if (text.startsWith("@")) {
        header = false;
        continue;
      }
      if (!DEFINITION.python.test(text)) return false;
      header = true;
    }
    return header;
  }
  // Brace languages: each piece at the depth the insertion starts at is a
  // definition, and the braces close where the insertion ends.
  let depth = 0;
  for (const line of lines) {
    const text = line.trim();
    if (depth === 0 && !text.startsWith("@") && !DEFINITION[language].test(text))
      return false;
    for (const char of text.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "")) {
      if (char === "{" || char === "(") depth += 1;
      else if (char === "}" || char === ")") depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/** The base's lines over `site`, with `regions` (all inside it, in order) applied. */
function applied(
  base: readonly string[],
  site: Region,
  regions: readonly Region[],
): string[] {
  const lines: string[] = [];
  let at = site.oldStart;
  for (const region of [...regions].sort((a, b) => a.oldStart - b.oldStart)) {
    lines.push(...base.slice(at, region.oldStart), ...region.lines);
    at = region.oldEnd;
  }
  lines.push(...base.slice(at, site.oldEnd));
  return lines;
}
