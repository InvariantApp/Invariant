/**
 * Exact conversion between major and minor currency units.
 *
 * Written into a consumer's repository by Invariant during a migration, and
 * type-checked and tested where it lives in Invariant rather than assembled
 * from a string. Safe to edit.
 *
 * The arithmetic is done by moving a decimal point through a string of digits,
 * never by multiplying, which is the whole reason the file exists: `19.99 *
 * 100` is `1998.9999999999998`, and a price is not allowed to depend on that.
 *
 * `String(value)` is what makes it work. JavaScript prints the shortest decimal
 * that reads back as the same double, so for every amount a caller could have
 * written, it hands back the digits they wrote. Asking for more places than
 * that, with `toFixed`, returns the binary expansion instead and reintroduces
 * exactly the error being avoided.
 */

/** Moves the decimal point right by `exponent` places. */
export function toMinorUnits(value: number, exponent = 2): number {
  return shift(value, exponent);
}

/** Moves the decimal point left by `exponent` places. */
export function fromMinorUnits(value: number, exponent = 2): number {
  return shift(value, -exponent);
}

interface Decimal {
  negative: boolean;
  /** Significant digits, no point. */
  digits: string;
  /** Places the point sits from the right, so the value is digits / 10^scale. */
  scale: number;
}

function parse(value: number): Decimal {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Cannot convert ${value} between currency units`);
  }

  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) throw new RangeError(`Cannot read ${value} as a decimal`);

  const fraction = match[3] ?? "";
  const exponent = match[4] === undefined ? 0 : Number(match[4]);

  return {
    negative: match[1] === "-",
    digits: `${match[2] ?? "0"}${fraction}`,
    // A negative exponent pushes the point further right through the digits.
    scale: fraction.length - exponent,
  };
}

function format(value: Decimal): number {
  const sign = value.negative ? "-" : "";

  if (value.scale <= 0) {
    return Number(`${sign}${value.digits}${"0".repeat(-value.scale)}`);
  }

  // Pad first, so an amount smaller than one still has a leading zero.
  const padded = value.digits.padStart(value.scale + 1, "0");
  const cut = padded.length - value.scale;
  return Number(`${sign}${padded.slice(0, cut)}.${padded.slice(cut)}`);
}

function shift(value: number, places: number): number {
  const decimal = parse(value);
  const out = format({ ...decimal, scale: decimal.scale - places });

  if (Number.isInteger(out) && !Number.isSafeInteger(out)) {
    throw new RangeError(`${value} does not fit in a safe integer after conversion`);
  }
  return out;
}
