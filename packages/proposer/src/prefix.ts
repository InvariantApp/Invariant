/**
 * Recognising that an entire API moved to a new URL prefix.
 *
 * This exists because of what real specifications turned out to look like.
 * Running sixty consecutive version pairs from real companies through the gate
 * produced one overwhelming category of unexplained change: whole endpoints
 * vanishing. 1572 of them, far ahead of anything else.
 *
 * They had not vanished. AWS publishes `/2017-10-30/distribution` and then
 * `/2018-06-18/distribution`. Google publishes `/v1/apps` and then
 * `/v1alpha/apps`. The version is *in the path*, so bumping it moves every
 * endpoint at once, and a diff with no notion of that reports each one as a
 * removal and an unrelated addition.
 *
 * Versioning by URL prefix is probably the most common way an API version is
 * expressed anywhere, and the `route` op has always been able to express it.
 * Nothing proposed it, so the commonest real change in the world came out as a
 * wall of unexplained deltas. That is the gap this closes.
 *
 * It is deliberately conservative. A prefix move is only claimed when one
 * substitution explains most of what went missing, because "several endpoints
 * were reorganised" and "the whole API moved" deserve different answers, and
 * guessing the second when it was the first would paper over real removals.
 */
import { type HttpMethod, type OpenApiDocument, operationsOf } from "@invariant/contract";
import type { Change, Op } from "@invariant/ir";

/** How much of the disappearance one substitution has to explain to be believed. */
export const PREFIX_CONFIDENCE = 0.6;

/** At least this many endpoints, or it is a coincidence rather than a pattern. */
const MINIMUM_MOVED = 3;

interface Moved {
  method: HttpMethod;
  from: string;
  to: string;
  operationId?: { from: string; to: string };
}

const declaredId = (operation: {
  operation: Record<string, unknown>;
}): string | undefined =>
  typeof operation.operation["operationId"] === "string"
    ? (operation.operation["operationId"] as string)
    : undefined;

export interface PrefixMove {
  /**
   * The leading segment as it was, without slashes. Empty when the paths had
   * no prefix and gained one, as AWS App Mesh's did when every path moved
   * under `/v20190125`.
   */
  from: string;
  /** Empty when the prefix was dropped rather than replaced. */
  to: string;
  /**
   * Endpoints this substitution accounts for, with their declared
   * operationIds, which versioned APIs often rename along with the path.
   */
  moved: Moved[];
  /** Endpoints that disappeared and this does not explain. */
  unexplained: number;
  /** Share of the disappearance this accounts for. */
  confidence: number;
}

function firstSegment(path: string): string | undefined {
  const parts = path.split("/").filter((part) => part !== "");
  return parts[0];
}

function withFirstSegment(path: string, segment: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  if (parts.length === 0) return path;
  return `/${[segment, ...parts.slice(1)].join("/")}`;
}

/**
 * Looks for a single leading-segment substitution that explains the endpoints
 * present in the old document and absent from the new one.
 *
 * Returns nothing when no substitution explains enough of them, which is the
 * common and correct answer: most releases do not move the whole API.
 */
export function detectPrefixMove(
  before: OpenApiDocument,
  after: OpenApiDocument,
): PrefixMove | undefined {
  const oldOps = operationsOf(before);
  const newOps = operationsOf(after);
  const newKeys = new Set(
    newOps.map((operation) => `${operation.method} ${operation.path}`),
  );

  const gone = oldOps.filter(
    (operation) => !newKeys.has(`${operation.method} ${operation.path}`),
  );
  if (gone.length < MINIMUM_MOVED) return undefined;

  // Where each method's new paths live, so the search below is a lookup rather
  // than a scan over every operation for every operation.
  const byMethod = new Map<HttpMethod, Set<string>>();
  const idAt = new Map<string, string | undefined>();
  for (const operation of newOps) {
    const found = byMethod.get(operation.method) ?? new Set<string>();
    found.add(operation.path);
    byMethod.set(operation.method, found);
    idAt.set(`${operation.method} ${operation.path}`, declaredId(operation));
  }

  // One tally per candidate substitution, counting the endpoints it lands on.
  // A substitution replaces the first segment, adds one in front, or takes
  // the first one away.
  const candidates = new Map<string, Moved[]>();
  for (const operation of gone) {
    const segment = firstSegment(operation.path);
    if (segment === undefined) continue;

    for (const path of byMethod.get(operation.method) ?? []) {
      const first = firstSegment(path);
      if (first === undefined) continue;
      let from: string;
      let replacement: string;
      if (first !== segment && withFirstSegment(operation.path, first) === path) {
        from = segment;
        replacement = first;
      } else if (path === `/${first}${operation.path}`) {
        from = "";
        replacement = first;
      } else if (operation.path === `/${segment}${path}`) {
        from = segment;
        replacement = "";
      } else {
        continue;
      }

      const key = `${from}\u0000${replacement}`;
      const found = candidates.get(key) ?? [];
      const before = declaredId(operation);
      const after = idAt.get(`${operation.method} ${path}`);
      found.push({
        method: operation.method,
        from: operation.path,
        to: path,
        ...(before !== undefined && after !== undefined && before !== after
          ? { operationId: { from: before, to: after } }
          : {}),
      });
      candidates.set(key, found);
    }
  }

  let best: PrefixMove | undefined;
  for (const [key, moved] of candidates) {
    const [from, to] = key.split("\u0000") as [string, string];
    const confidence = moved.length / gone.length;
    if (moved.length < MINIMUM_MOVED || confidence < PREFIX_CONFIDENCE) continue;
    if (best && best.moved.length >= moved.length) continue;
    best = {
      from,
      to,
      moved: moved.sort((a, b) => a.from.localeCompare(b.from)),
      unexplained: gone.length - moved.length,
      confidence,
    };
  }

  return best;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Turns a detected move into one Change carrying a `route` op per endpoint.
 *
 * One Change rather than one per endpoint, because it was one decision. A
 * reviewer reading sixty separate Changes that all say the same thing learns
 * less than one that says it once and lists what it touched, and retiring them
 * individually would make no sense either.
 */
export function prefixChange(move: PrefixMove): Change {
  const ops: Op[] = move.moved.map((endpoint) => ({
    op: "route",
    from: { method: endpoint.method, path: endpoint.from },
    to: { method: endpoint.method, path: endpoint.to },
    ...(endpoint.operationId ? { operationId: endpoint.operationId } : {}),
  }));

  return {
    irVersion: 1,
    id:
      move.to === ""
        ? `chg_moved_out_of_${slug(move.from)}`
        : `chg_moved_to_${slug(move.to)}`,
    summary: `${describePrefixMove(move)} ${move.moved.length} operations.`,
    ops,
    provenance: {
      proposed_by: { judge: "rules", confidence: move.confidence },
    },
  };
}

/** The move in words, including a prefix that appeared or was dropped. */
export function describePrefixMove(move: Pick<PrefixMove, "from" | "to">): string {
  if (move.from === "") return `Every endpoint moved under \`/${move.to}\`.`;
  if (move.to === "") return `Every endpoint moved out from under \`/${move.from}\`.`;
  return `Every endpoint moved from \`/${move.from}\` to \`/${move.to}\`.`;
}
