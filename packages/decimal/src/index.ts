/**
 * Exact decimal arithmetic on the text of a number.
 *
 * Money is the one place a compatibility transform cannot afford to be
 * approximately right, and `49.99 * 100` is not 4999 in binary floating point.
 * Everything here works on the digit string, so scaling is a decimal-point
 * shift and is exact by construction, in both directions and at any magnitude.
 *
 * This package has no dependencies on purpose: the request-path runtime links
 * it, and nothing on that path is allowed to pull in third-party code.
 */

export class DecimalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecimalError";
  }
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

export interface Decimal {
  negative: boolean;
  /** All significant digits, decimal point removed. */
  digits: string;
  /** How many of those digits sit after the decimal point. */
  scale: number;
}

/**
 * Parses the textual form of a JSON number. Exponential notation is refused
 * rather than normalized, because a transform should not quietly reinterpret a
 * representation the caller chose.
 */
export function parseDecimal(text: string): Decimal {
  const trimmed = text.trim();
  const match = DECIMAL.exec(trimmed);
  if (!match) {
    throw new DecimalError(`Not a plain decimal number: ${text}`);
  }
  const [, sign = "", whole = "0", fraction = ""] = match;
  return {
    negative: sign === "-",
    digits: `${whole}${fraction}`,
    scale: fraction.length,
  };
}

function stripLeadingZeros(digits: string): string {
  const stripped = digits.replace(/^0+/, "");
  return stripped === "" ? "0" : stripped;
}

export function formatDecimal(value: Decimal): string {
  const { digits, scale } = value;
  let whole: string;
  let fraction: string;

  if (scale === 0) {
    whole = digits;
    fraction = "";
  } else if (digits.length > scale) {
    whole = digits.slice(0, digits.length - scale);
    fraction = digits.slice(digits.length - scale);
  } else {
    whole = "0";
    fraction = digits.padStart(scale, "0");
  }

  whole = stripLeadingZeros(whole);
  fraction = fraction.replace(/0+$/, "");

  const magnitude = fraction === "" ? whole : `${whole}.${fraction}`;
  // Negative zero is not a distinct JSON number.
  if (magnitude === "0") return "0";
  return `${value.negative ? "-" : ""}${magnitude}`;
}

/**
 * Multiplies by 10^exponent exactly, by moving the decimal point.
 * A negative exponent divides, and is the exact inverse of the positive one.
 */
export function shiftDecimal(text: string, exponent: number): string {
  const value = parseDecimal(text);
  const scale = value.scale - exponent;

  if (scale <= 0) {
    return formatDecimal({
      negative: value.negative,
      digits: `${value.digits}${"0".repeat(-scale)}`,
      scale: 0,
    });
  }
  return formatDecimal({
    negative: value.negative,
    digits: value.digits.padStart(scale + 1, "0"),
    scale,
  });
}

export function isIntegerText(text: string): boolean {
  const value = parseDecimal(text);
  return formatDecimal(value).indexOf(".") === -1;
}

/** Digits after the decimal point, once trailing zeros are dropped. */
export function fractionDigits(text: string): number {
  const formatted = formatDecimal(parseDecimal(text));
  const dot = formatted.indexOf(".");
  return dot === -1 ? 0 : formatted.length - dot - 1;
}

export function compareDecimal(a: string, b: string): number {
  const left = parseDecimal(a);
  const right = parseDecimal(b);
  if (left.negative !== right.negative) return left.negative ? -1 : 1;

  const scale = Math.max(left.scale, right.scale);
  const leftDigits = BigInt(left.digits) * 10n ** BigInt(scale - left.scale);
  const rightDigits = BigInt(right.digits) * 10n ** BigInt(scale - right.scale);
  const sign = left.negative ? -1n : 1n;
  const diff = (leftDigits - rightDigits) * sign;
  return diff === 0n ? 0 : diff > 0n ? 1 : -1;
}

/**
 * True when a value is exactly representable as a JavaScript number, which is
 * what `JSON.parse` would have produced for it.
 */
export function fitsSafeInteger(text: string): boolean {
  if (!isIntegerText(text)) return false;
  const value = BigInt(formatDecimal(parseDecimal(text)));
  return (
    value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
  );
}

/** Converts a JavaScript number to decimal text, refusing exponential forms. */
export function numberToDecimalText(value: number): string {
  if (!Number.isFinite(value)) {
    throw new DecimalError(`Not a finite number: ${value}`);
  }
  const text = String(value);
  if (text.includes("e") || text.includes("E")) {
    throw new DecimalError(`Exponential notation is not supported: ${text}`);
  }
  return text;
}
