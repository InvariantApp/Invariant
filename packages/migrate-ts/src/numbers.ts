import { isIntegerText, numberToDecimalText, shiftDecimal } from "@invariant-app/decimal";

/**
 * Rewrites a literal amount into minor units, exactly.
 *
 * The migration never emits float arithmetic into a consumer's source, and it
 * never writes a literal it could not compute exactly. `49.99` becomes `4999`
 * here, at build time, on the digit string. Anything that is not a plain
 * numeric literal, or that does not land on a whole minor unit, returns
 * undefined so the caller falls back to wrapping the expression in the SDK's
 * conversion helper.
 */
export function exactMinorUnits(literal: string, exponent: number): string | undefined {
  const text = literal.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return undefined;

  try {
    const shifted = shiftDecimal(text, exponent);
    if (exponent > 0 && !isIntegerText(shifted)) return undefined;
    return shifted;
  } catch {
    return undefined;
  }
}

export { numberToDecimalText };
