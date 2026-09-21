/**
 * The value codecs that are not arithmetic: instants written three ways, and
 * identifiers written in five cases.
 *
 * Every one is exact or refuses. A value either converts to one the other
 * side can read and converts back to the same meaning, or it is refused with a
 * reason, never approximated. That rule is what lets a single declaration
 * serve both directions: the same function runs forward on a request and
 * backward on a response, and the lens laws hold because nothing in between
 * guesses.
 *
 * Both are pure functions of their input with no dependence on the host's
 * clock, time zone or locale, so an engine in another language can match them
 * byte for byte from the vectors alone.
 */
import { isNumberLike, numberTextOf } from "./json.ts";

/** Seconds or milliseconds since 1970-01-01T00:00:00Z, or RFC 3339 text. */
export type TimeFormat = "epoch-s" | "epoch-ms" | "rfc3339";

/** Why a value was refused, in words that name the value. */
export class CodecRefusal extends Error {}

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

/** An instant as whole milliseconds since the epoch, with any finer digits kept apart. */
interface Instant {
  ms: bigint;
  /** Digits below a millisecond, which only RFC 3339 can carry. */
  finer: string;
}

/**
 * Days since 1970-01-01 of a proleptic Gregorian date. Written out rather than
 * taken from `Date.UTC`, which reads years 0 to 99 as 1900 to 1999.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(days: number): [number, number, number] {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) /
      365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (month <= 2 ? 1 : 0), month, day];
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

const MS_PER_DAY = 86_400_000n;
/** 0000-01-01T00:00:00Z and the last millisecond of 9999, the years RFC 3339 can write. */
const EARLIEST = BigInt(daysFromCivil(0, 1, 1)) * MS_PER_DAY;
const LATEST = BigInt(daysFromCivil(10000, 1, 1)) * MS_PER_DAY - 1n;

function parseRfc3339(text: string): Instant {
  const match = RFC3339.exec(text);
  if (match === null) throw new CodecRefusal(`"${text}" is not an RFC 3339 date-time`);
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map((part) => Number(part)) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new CodecRefusal(`"${text}" names a day that does not exist`);
  }
  if (hour > 23 || minute > 59)
    throw new CodecRefusal(`"${text}" names a time that does not exist`);
  // A leap second has no place on a timeline that counts seconds since 1970,
  // and folding it into the next one would be a guess.
  if (second > 59)
    throw new CodecRefusal(`"${text}" is a leap second, which the epoch cannot count`);
  let offsetMinutes = 0;
  if (match[8] === undefined) {
    const offsetHours = Number(match[10]);
    const offsetRest = Number(match[11]);
    if (offsetHours > 23 || offsetRest > 59) {
      throw new CodecRefusal(`"${text}" has an offset that does not exist`);
    }
    offsetMinutes = (offsetHours * 60 + offsetRest) * (match[9] === "-" ? -1 : 1);
  }
  const fraction = match[7] ?? "";
  const millis = BigInt((fraction.slice(0, 3) || "0").padEnd(3, "0"));
  const ms =
    BigInt(daysFromCivil(year, month, day)) * MS_PER_DAY +
    BigInt(((hour * 60 + minute - offsetMinutes) * 60 + second) * 1000) +
    millis;
  return { ms, finer: fraction.slice(3).replace(/0+$/, "") };
}

function formatRfc3339(ms: bigint): string {
  if (ms < EARLIEST || ms > LATEST) {
    throw new CodecRefusal(
      `${ms} ms since the epoch is outside the years RFC 3339 can write`,
    );
  }
  const days = ms >= 0n ? ms / MS_PER_DAY : (ms - MS_PER_DAY + 1n) / MS_PER_DAY;
  const rest = Number(ms - days * MS_PER_DAY);
  const [year, month, day] = civilFromDays(Number(days));
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const clock =
    `${pad(Math.floor(rest / 3_600_000))}:${pad(Math.floor(rest / 60_000) % 60)}:` +
    pad(Math.floor(rest / 1000) % 60);
  const millis = rest % 1000;
  return (
    `${pad(year, 4)}-${pad(month)}-${pad(day)}T${clock}` +
    `${millis === 0 ? "" : `.${pad(millis, 3)}`}Z`
  );
}

function epochOf(value: unknown, format: "epoch-s" | "epoch-ms"): bigint {
  if (!isNumberLike(value)) {
    throw new CodecRefusal(
      `expected a number of ${format === "epoch-s" ? "seconds" : "milliseconds"}, found ${
        value === null ? "null" : typeof value
      }`,
    );
  }
  const text = numberTextOf(value);
  if (!/^-?\d+$/.test(text)) throw new CodecRefusal(`${text} is not a whole number`);
  return format === "epoch-s" ? BigInt(text) * 1000n : BigInt(text);
}

function epochValue(ms: bigint): unknown {
  // Beyond 2^53 a JavaScript number would change the value, so it stays text.
  const safe =
    ms >= BigInt(Number.MIN_SAFE_INTEGER) && ms <= BigInt(Number.MAX_SAFE_INTEGER);
  return safe ? Number(ms) : JSON.rawJSON(String(ms));
}

/**
 * One instant, re-encoded. Refuses a value the target cannot hold exactly: a
 * fraction of a second going to whole seconds, more than millisecond
 * precision going to milliseconds, a year outside 0000 to 9999 going to text.
 *
 * With `truncate`, precision the target cannot hold is dropped instead,
 * always toward the earlier instant: -0.5 seconds is -1, as the epoch counts.
 *
 * RFC 3339 is always written in UTC with the fraction left out when it is
 * zero, so an offset a caller wrote is not preserved through the epoch. The
 * instant is; the compiler declares the offset as the loss.
 */
export function convertTime(
  value: unknown,
  from: TimeFormat,
  to: TimeFormat,
  truncate = false,
): unknown {
  if (from === to) return value;
  let instant: Instant;
  if (from === "rfc3339") {
    if (typeof value !== "string") {
      throw new CodecRefusal(
        `expected RFC 3339 text, found ${value === null ? "null" : typeof value}`,
      );
    }
    instant = parseRfc3339(value);
  } else {
    instant = { ms: epochOf(value, from), finer: "" };
  }
  // Digits below a millisecond only ever sit after the ones kept, so dropping
  // them moves the instant toward the earlier one, as the epoch counts.
  if (instant.finer !== "" && !truncate) {
    throw new CodecRefusal("the value is more precise than a millisecond");
  }
  switch (to) {
    case "rfc3339":
      return formatRfc3339(instant.ms);
    case "epoch-ms":
      return epochValue(instant.ms);
    case "epoch-s": {
      // BigInt division rounds toward zero; the epoch rounds toward the past.
      const remainder = ((instant.ms % 1000n) + 1000n) % 1000n;
      if (remainder !== 0n && !truncate) {
        throw new CodecRefusal(
          "the value has a fraction of a second, which whole seconds cannot hold",
        );
      }
      return epochValue((instant.ms - remainder) / 1000n);
    }
  }
}

/** How an identifier made of words is written. */
export type StringCase = "snake" | "screaming" | "kebab" | "camel" | "pascal";

const LOWER_WORD = /^[a-z0-9]+$/;
const UPPER_WORD = /^[A-Z0-9]+$/;

function split(text: string, separator: string, word: RegExp): string[] | undefined {
  const words = text.split(separator);
  return words.every((part) => word.test(part))
    ? words.map((part) => part.toLowerCase())
    : undefined;
}

function wordsOf(text: string, style: StringCase): string[] | undefined {
  switch (style) {
    case "snake":
      return split(text, "_", LOWER_WORD);
    case "screaming":
      return split(text, "_", UPPER_WORD);
    case "kebab":
      return split(text, "-", LOWER_WORD);
    case "camel":
    case "pascal":
      // Two capitals together are an acronym, and `userID` could be `user_id`
      // or `user_i_d`. Neither is a guess worth making for someone.
      if (/[A-Z]{2}/.test(text)) return undefined;
      if (
        !(
          style === "camel" ? /^[a-z0-9]+(?:[A-Z][a-z0-9]*)*$/ : /^(?:[A-Z][a-z0-9]*)+$/
        ).test(text)
      ) {
        return undefined;
      }
      return text.split(/(?=[A-Z])/).map((part) => part.toLowerCase());
  }
}

function written(words: string[], style: StringCase): string {
  const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
  switch (style) {
    case "snake":
      return words.join("_");
    case "screaming":
      return words.join("_").toUpperCase();
    case "kebab":
      return words.join("-");
    case "camel":
      return words.map((word, i) => (i === 0 ? word : capital(word))).join("");
    case "pascal":
      return words.map(capital).join("");
  }
}

/**
 * One identifier, rewritten in another case. Words are runs of lowercase
 * letters and digits; in camel and pascal case a capital starts a new one.
 *
 * Refuses text that is not written in `from`, an acronym in camel or pascal
 * case (`userID` could be `user_id` or `user_i_d`), and text whose words the
 * target cannot keep apart: `v2_beta` is `v2Beta` in camel case, but `a_1b`
 * would be `a1b`, which reads back as one word. The check is the round trip
 * itself, so no case of this is missed by a rule that forgot it.
 */
export function convertCase(value: unknown, from: StringCase, to: StringCase): unknown {
  if (typeof value !== "string") {
    throw new CodecRefusal(
      `expected text to recase, found ${value === null ? "null" : typeof value}`,
    );
  }
  if (from === to) return value;
  const words = wordsOf(value, from);
  if (words === undefined)
    throw new CodecRefusal(`"${value}" is not written in ${from} case`);
  const out = written(words, to);
  const back = wordsOf(out, to);
  if (back === undefined || written(back, from) !== value) {
    throw new CodecRefusal(`"${value}" cannot be written in ${to} case and read back`);
  }
  return out;
}
