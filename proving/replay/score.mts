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
}

/**
 * `flagged`: the engine wrote nothing there and reported the place to a
 * person instead, which L8 counts as handled, apart from an edit.
 */
export type Outcome = "identical" | "differs" | "flagged" | "missed";

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
 * Each human region against the engine regions over the same lines. One
 * human region may be covered by several engine ones, which is identical when
 * together they produce the same lines from the base.
 */
export function score(
  base: readonly string[],
  human: readonly Region[],
  engine: readonly Region[],
  /**
   * Base lines (0-based, end exclusive) the engine reported to a person rather
   * than edited: the extent of what it flagged, such as a whole object literal.
   */
  flaggedRanges: readonly (readonly [number, number])[] = [],
): Score & { outcomes: Outcome[] } {
  const result: Score & { outcomes: Outcome[] } = {
    identical: 0,
    differs: 0,
    flagged: 0,
    missed: 0,
    extra: 0,
    outcomes: [],
  };
  const used = new Set<Region>();
  for (const site of human) {
    const covering = engine.filter((region) => overlaps(site, region));
    if (covering.length === 0) {
      const end = Math.max(site.oldEnd, site.oldStart + 1);
      const flagged = flaggedRanges.some(
        ([from, to]) => from < end && site.oldStart < Math.max(to, from + 1),
      );
      result[flagged ? "flagged" : "missed"] += 1;
      result.outcomes.push(flagged ? "flagged" : "missed");
      continue;
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
  }
  result.extra = engine.filter((region) => !used.has(region)).length;
  result.extraFlags = flaggedRanges.filter(
    ([from, to]) =>
      !human.some(
        (site) =>
          from < Math.max(site.oldEnd, site.oldStart + 1) &&
          site.oldStart < Math.max(to, from + 1),
      ),
  ).length;
  return result;
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
