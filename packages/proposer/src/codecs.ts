/**
 * Recognising the value codecs from two shapes of one field.
 *
 * Each recogniser answers from the declared shapes alone and says nothing
 * when they do not settle it. A draft that guesses a codec is worse than no
 * draft, because the codec runs on every value and the guess is invisible
 * once merged; where the shapes leave something open, such as whether a
 * count is of seconds or milliseconds, the note says which way the draft
 * went and why.
 */
import type { Codec, StringCase, TimeFormat } from "@invariant/ir";
import { convertCase } from "@invariant/runtime";
import type { FieldShape } from "./candidates.ts";

/** What the recognisers read, which a body field and a parameter both have. */
export type Shape = Pick<FieldShape, "name" | "type" | "format" | "ref" | "items"> & {
  description?: string | undefined;
};

export interface Recognised {
  codec: Codec;
  note: string;
}

const COUNTS = new Set(["integer", "number"]);

/** Whether a field's own words say its count is of milliseconds. */
function inMilliseconds(field: Shape): boolean {
  const words = `${field.name} ${field.description ?? ""}`;
  return /(^|[._\s])(ms|millis)$|Ms$|_ms\b|millisecond/i.test(words);
}

function isDateTime(field: Shape): boolean {
  return field.type === "string" && field.format === "date-time";
}

function isCount(field: Shape): boolean {
  return (
    field.type !== undefined && COUNTS.has(field.type) && field.format !== "date-time"
  );
}

/**
 * An instant that changed how it is written: a count since the epoch that
 * became `date-time` text, or the reverse.
 */
export function timeCodec(removed: Shape, successor: Shape): Recognised | undefined {
  const epoch = (field: Shape): TimeFormat =>
    inMilliseconds(field) ? "epoch-ms" : "epoch-s";
  const unit = (format: TimeFormat) =>
    format === "epoch-ms" ? "milliseconds" : "seconds";
  if (isCount(removed) && isDateTime(successor)) {
    const from = epoch(removed);
    return {
      codec: { kind: "dateFormat", from, to: "rfc3339" },
      note:
        `\`${removed.name}\` was a count and is now date-time text, which this draft reads as ` +
        `${unit(from)} since 1970. Check the unit, and whether the new side can carry ` +
        "fractions of a second an old caller cannot: the gate will say.",
    };
  }
  if (isDateTime(removed) && isCount(successor)) {
    const to = epoch(successor);
    return {
      codec: { kind: "dateFormat", from: "rfc3339", to },
      note:
        `\`${removed.name}\` was date-time text and is now a count, which this draft reads as ` +
        `${unit(to)} since 1970. Check the unit.`,
    };
  }
  // A count that changed unit is left to `scale10`: `timeout_ms` becoming
  // `timeout_seconds` is a duration, and calling it an instant would be wrong
  // even where the arithmetic agrees.
  return undefined;
}

/** Whether a list holds what the single value was: the same named schema, or the same type. */
function holds(list: Shape, single: Shape): boolean {
  const items = list.items;
  if (list.type !== "array" || items === undefined) return false;
  if (items.ref !== undefined || single.ref !== undefined)
    return items.ref === single.ref;
  return items.type !== undefined && items.type === single.type;
}

/** One value that became a list of the same thing, or a list that became one. */
export function listCodec(removed: Shape, successor: Shape): Recognised | undefined {
  if (holds(successor, removed)) {
    return {
      codec: { kind: "wrapArray" },
      note:
        `\`${removed.name}\` became a list of what it was. Old callers are shown its one item ` +
        "and refused a list of any other length; if the list can hold more, decide whether " +
        "the first item stands for it (`pick: first`), which the gate records as a loss.",
    };
  }
  if (holds(removed, successor)) {
    return {
      codec: { kind: "unwrapSingle" },
      note:
        `\`${removed.name}\` was a list and is now one value. An old caller's list of one is ` +
        "sent as its item, and any other length refused unless the first item is declared to " +
        "stand for it (`pick: first`).",
    };
  }
  return undefined;
}

const CASES: StringCase[] = ["snake", "screaming", "kebab", "camel", "pascal"];

/**
 * A vocabulary rewritten in another case, value for value: `in_progress`
 * and `done` becoming `IN_PROGRESS` and `DONE`. Only when every old value
 * lands on a new one and the new set is exactly those, so a case change and
 * a new value arriving at once is left to the enum map and its decisions.
 */
export function caseCodec(before: string[], after: string[]): Recognised | undefined {
  const target = new Set(after);
  if (before.length === 0 || target.size !== before.length) return undefined;
  for (const from of CASES) {
    for (const to of CASES) {
      if (from === to) continue;
      const mapped: string[] = [];
      for (const value of before) {
        try {
          mapped.push(convertCase(value, from, to) as string);
        } catch {
          break;
        }
      }
      if (mapped.length !== before.length) continue;
      if (
        new Set(mapped).size === target.size &&
        mapped.every((value) => target.has(value))
      ) {
        // A value with no case to change, such as `v2`, reads the same in
        // several conventions; any of them that fits is the same mapping.
        return {
          codec: { kind: "stringCase", from, to },
          note: `every value was rewritten from ${from} case to ${to} case.`,
        };
      }
    }
  }
  return undefined;
}
