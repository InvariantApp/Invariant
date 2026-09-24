/**
 * False closure on Rig D: whether an adapted answer means what the old
 * server's answer meant.
 *
 * The gate proves structure: every breaking delta is explained, the lens laws
 * hold and the differential agrees. None of that can tell a Change that
 * renames `size` back to `bytes` from one that should have converted
 * kilobytes, since both produce a document of the right shape. The old server
 * can. It is ground truth for what an old caller should be told, and Rig D
 * already runs it.
 *
 * So every call the adapter changed in arm c (the answer it sent differs from
 * the answer the new server gave it) is set beside the same call in arm a,
 * made by the same test against the old server, and every place the adapter
 * wrote is compared with what the old server sent there:
 *
 * - present where the old server had nothing, or missing where it had
 *   something, is wrong;
 * - a different kind of value (text for a number, a list for an object) is
 *   wrong;
 * - a different value is wrong where the old server gave the same value on
 *   both of its runs. Where its own two runs disagree (an id, a timestamp) the
 *   value is chance, and only its kind is compared.
 *
 * A status the adapter chose that differs from the old server's is wrong. A
 * status the adapter passed through that differs is the release answering
 * differently in a way no Change claims to serve; it is counted as not
 * comparable rather than charged to a Change.
 *
 * Calls are paired by method, path with its ids set aside, and how many
 * calls to that route came before, since the suite makes them in the same
 * order against either server. A call with no counterpart, or whose old
 * answer was too large or not JSON enough to record, is counted and not
 * judged. Only answers are judged here: an adapted request is judged by what
 * the new server answers to it, which the suite's own outcome already says.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** One call as a recorder saw it. */
export interface Exchange {
  id: number;
  method: string;
  path: string;
  status: number;
  /** The query string as sent, `?` included, for naming a call in a finding. */
  query?: string;
  /** The parsed body, for a JSON answer small enough to record. */
  body?: Json;
}

/** A place the adapter wrote whose value the old server contradicts. */
export interface Finding {
  /** Method, route and pointer, with ids and list positions set aside. */
  site: string;
  why: string;
}

export interface ClosureResult {
  /** Calls the adapter changed the answer to. */
  adapted: number;
  /** Of those, set beside the old server's answer to the same call. */
  compared: number;
  /** Adapted calls with no counterpart in arm a, or whose status the release changed. */
  notComparable: number;
  /** Distinct places the adapter wrote that were compared. */
  sites: string[];
  /** Places where the adapter's answer is not what the old server said, one per site. */
  wrong: Finding[];
}

const ID_SEGMENT =
  /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,}|(?=.*\d)[A-Za-z0-9_-]{16,})$/i;

/** A path with the segments that name one record set aside. */
export function route(method: string, path: string): string {
  return `${method.toUpperCase()} ${path
    .split("/")
    .map((segment) => (ID_SEGMENT.test(segment) ? "{id}" : segment))
    .join("/")}`;
}

const kindOf = (value: Json | undefined): string =>
  value === undefined
    ? "absent"
    : value === null
      ? "null"
      : Array.isArray(value)
        ? "array"
        : typeof value;

/** Every leaf of a document, by pointer: scalars, and empty lists and objects. */
function leaves(
  value: Json | undefined,
  at = "",
  out = new Map<string, Json>(),
): Map<string, Json> {
  if (value === undefined) return out;
  if (value !== null && typeof value === "object") {
    const entries = Array.isArray(value)
      ? value.map((item, index) => [String(index), item] as const)
      : Object.entries(value);
    if (entries.length === 0) out.set(at, value);
    for (const [key, item] of entries) {
      leaves(item, `${at}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`, out);
    }
    return out;
  }
  out.set(at, value);
  return out;
}

/** The value at a pointer, or undefined where the document has none. */
function at(value: Json | undefined, pointer: string): Json | undefined {
  let here = value;
  for (const segment of pointer.split("/").slice(1)) {
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (here === null || typeof here !== "object") return undefined;
    here = Array.isArray(here) ? here[Number(key)] : here[key];
    if (here === undefined) return undefined;
  }
  return here;
}

/**
 * What the old server sent around a place it left empty: the nearest
 * enclosing value it did send, so a finding says whether the field alone was
 * missing or everything that held it was.
 */
function around(body: Json | undefined, pointer: string): string {
  const segments = pointer.split("/");
  for (let length = segments.length - 1; length >= 1; length -= 1) {
    const parent = segments.slice(0, length).join("/");
    const value = at(body, parent);
    if (value === undefined) continue;
    const shown =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? `an object holding ${Object.keys(value).sort().join(", ") || "nothing"}`
        : kindOf(value);
    return `at ${parent || "/"} it sent ${shown}`;
  }
  return "it sent no body";
}

const same = (a: Json | undefined, b: Json | undefined) =>
  JSON.stringify(a) === JSON.stringify(b);

/** The places whose value the adapter changed, and those it took away. */
export function written(
  given: Json | undefined,
  sent: Json | undefined,
): { changed: string[]; removed: string[] } {
  const before = leaves(given);
  const after = leaves(sent);
  const changed = [...after]
    .filter(
      ([pointer, value]) => !before.has(pointer) || !same(before.get(pointer), value),
    )
    .map(([pointer]) => pointer);
  const removed = [...before.keys()].filter((pointer) => !after.has(pointer));
  return { changed, removed };
}

function occurrences(exchanges: readonly Exchange[]): Map<number, string> {
  const seen = new Map<string, number>();
  const keys = new Map<number, string>();
  for (const exchange of [...exchanges].sort((a, b) => a.id - b.id)) {
    const key = route(exchange.method, exchange.path);
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    keys.set(exchange.id, `${key}#${count}`);
  }
  return keys;
}

function byOccurrence(exchanges: readonly Exchange[]): Map<string, Exchange> {
  const keys = occurrences(exchanges);
  return new Map(
    exchanges.map((exchange) => [keys.get(exchange.id) as string, exchange]),
  );
}

const statusClass = (status: number) => Math.floor(status / 100);

/**
 * Judges arm c's adapted answers against arm a's.
 *
 * `adapter` holds each run of arm c as the answers the suite received
 * (`sent`) and the answers the new server gave the proxy (`given`). `old`
 * holds each run of arm a.
 */
export function judgeClosure(
  adapter: readonly { sent: readonly Exchange[]; given: readonly Exchange[] }[],
  old: readonly (readonly Exchange[])[],
): ClosureResult {
  const oldRuns = old.map(byOccurrence);
  const sites = new Set<string>();
  const wrong = new Map<string, Finding>();
  let adapted = 0;
  let compared = 0;
  let notComparable = 0;

  for (const run of adapter) {
    const keys = occurrences(run.sent);
    const given = new Map(run.given.map((exchange) => [exchange.id, exchange]));
    for (const sent of run.sent) {
      const before = given.get(sent.id);
      if (!before) continue;
      const statusChanged = before.status !== sent.status;
      const { changed, removed } = written(before.body, sent.body);
      if (!statusChanged && changed.length === 0 && removed.length === 0) continue;
      adapted += 1;

      const key = keys.get(sent.id) as string;
      const counterparts = oldRuns
        .map((runOf) => runOf.get(key))
        .filter((exchange): exchange is Exchange => exchange !== undefined);
      const truth = counterparts[0];
      // An old answer whose body was not recorded (too large, or not JSON)
      // says nothing about any place in it. Read as an empty document it
      // made every value the adapter wrote look invented and every value it
      // took away look right.
      const unread =
        sent.body !== undefined &&
        counterparts.some((exchange) => exchange.body === undefined);
      if (
        !truth ||
        unread ||
        (!statusChanged && statusClass(truth.status) !== statusClass(sent.status))
      ) {
        notComparable += 1;
        continue;
      }
      compared += 1;
      const where = route(sent.method, sent.path);
      const flag = (pointer: string, why: string) => {
        const site = `${where} ${pointer.replace(/\/\d+(?=\/|$)/g, "/*") || "/"}`;
        sites.add(site);
        if (!wrong.has(site)) wrong.set(site, { site, why });
      };
      const fine = (pointer: string) => {
        sites.add(`${where} ${pointer.replace(/\/\d+(?=\/|$)/g, "/*") || "/"}`);
      };

      if (statusChanged) {
        if (statusClass(truth.status) !== statusClass(sent.status)) {
          flag(
            "",
            `the adapter answered ${sent.status} where the old server answered ${truth.status}`,
          );
        } else {
          fine("");
        }
      }
      const oldLeaves = counterparts.map((exchange) => leaves(exchange.body));
      const [first] = oldLeaves;
      if (!first) continue;
      const sentLeaves = leaves(sent.body);
      for (const pointer of changed) {
        const value = sentLeaves.get(pointer);
        const truths = oldLeaves.map((leavesOf) => leavesOf.get(pointer));
        const expected = truths[0];
        if (expected === undefined) {
          // A value the old server never sent at this place: only wrong if no
          // run of it did, since a list can be one longer on another run.
          if (truths.every((truthValue) => truthValue === undefined)) {
            flag(
              pointer,
              `the adapter sent ${JSON.stringify(value)} where the old server sent nothing` +
                ` (${around(counterparts[0]?.body, pointer)}, ${sent.method.toUpperCase()} ${sent.path}${sent.query ?? ""})`,
            );
          } else {
            fine(pointer);
          }
          continue;
        }
        if (kindOf(value) !== kindOf(expected)) {
          flag(
            pointer,
            `the adapter sent ${kindOf(value)} ${JSON.stringify(value)} where the old server sent ${kindOf(expected)} ${JSON.stringify(expected)}`,
          );
          continue;
        }
        const stable =
          truths.length > 1 && truths.every((truthValue) => same(truthValue, expected));
        if (stable && !same(value, expected)) {
          flag(
            pointer,
            `the adapter sent ${JSON.stringify(value)} where the old server sent ${JSON.stringify(expected)} on every run`,
          );
          continue;
        }
        fine(pointer);
      }
      for (const pointer of removed) {
        if (oldLeaves.every((leavesOf) => leavesOf.has(pointer))) {
          flag(pointer, "the adapter took away a value the old server sent on every run");
        } else {
          fine(pointer);
        }
      }
    }
  }

  return {
    adapted,
    compared,
    notComparable,
    sites: [...sites].sort(),
    wrong: [...wrong.values()],
  };
}
