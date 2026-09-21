import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  compareDecimal,
  fitsSafeInteger,
  fractionDigits,
  isIntegerText,
  numberToDecimalText,
  parseDecimal,
  shiftDecimal,
} from "./index.ts";

describe("shiftDecimal", () => {
  it("scales money into minor units exactly", () => {
    expect(shiftDecimal("49.99", 2)).toBe("4999");
    expect(shiftDecimal("0.01", 2)).toBe("1");
    expect(shiftDecimal("249.0", 2)).toBe("24900");
    expect(shiftDecimal("1234567890123456.78", 2)).toBe("123456789012345678");
  });

  it("scales back out of minor units exactly", () => {
    expect(shiftDecimal("4999", -2)).toBe("49.99");
    expect(shiftDecimal("1", -2)).toBe("0.01");
    expect(shiftDecimal("24900", -2)).toBe("249");
    expect(shiftDecimal("0", -2)).toBe("0");
  });

  it("keeps a fractional remainder visible rather than rounding it away", () => {
    expect(shiftDecimal("49.999", 2)).toBe("4999.9");
    expect(shiftDecimal("0.01", 1)).toBe("0.1");
  });

  it("handles negatives and normalizes negative zero", () => {
    expect(shiftDecimal("-49.99", 2)).toBe("-4999");
    expect(shiftDecimal("-0.001", 2)).toBe("-0.1");
    expect(shiftDecimal("-0.00", 2)).toBe("0");
  });

  it("does not lose precision where floating point would", () => {
    // The whole reason this package exists. Scaling the double is wrong for
    // these amounts; scaling the text the caller actually sent is not.
    expect(4.35 * 100).toBe(434.99999999999994);
    expect(shiftDecimal("4.35", 2)).toBe("435");

    expect(1.005 * 100).toBe(100.49999999999999);
    expect(shiftDecimal("1.005", 2)).toBe("100.5");

    expect(shiftDecimal("1234567890123456789.01", 2)).toBe("123456789012345678901");
  });

  it("refuses exponential notation instead of guessing", () => {
    expect(() => shiftDecimal("1e3", 2)).toThrow(/plain decimal/);
    expect(() => numberToDecimalText(1e21)).toThrow(/Exponential/);
  });
});

describe("decimal predicates", () => {
  it("recognizes integers after normalization", () => {
    expect(isIntegerText("4999")).toBe(true);
    expect(isIntegerText("49.00")).toBe(true);
    expect(isIntegerText("49.01")).toBe(false);
  });

  it("counts significant fraction digits", () => {
    expect(fractionDigits("49.99")).toBe(2);
    expect(fractionDigits("49.90")).toBe(1);
    expect(fractionDigits("49")).toBe(0);
  });

  it("compares without floating point", () => {
    expect(compareDecimal("0.1", "0.10")).toBe(0);
    expect(compareDecimal("2", "10")).toBe(-1);
    expect(compareDecimal("-2", "-10")).toBe(1);
  });

  it("knows what survives a round trip through a JavaScript number", () => {
    expect(fitsSafeInteger("9007199254740991")).toBe(true);
    expect(fitsSafeInteger("9007199254740993")).toBe(false);
    expect(fitsSafeInteger("49.99")).toBe(false);
  });
});

const decimalText = fc
  .tuple(
    fc.boolean(),
    fc.bigInt({ min: 0n, max: 10n ** 24n }),
    fc.integer({ min: 0, max: 8 }),
  )
  .map(([negative, digits, scale]) => {
    const text = digits.toString().padStart(scale + 1, "0");
    const whole = text.slice(0, text.length - scale);
    const fraction = scale === 0 ? "" : `.${text.slice(text.length - scale)}`;
    return `${negative ? "-" : ""}${whole}${fraction}`;
  });

describe("decimal laws", () => {
  it("shifting by e and then by -e is the identity", () => {
    fc.assert(
      fc.property(decimalText, fc.integer({ min: -9, max: 9 }), (text, exponent) => {
        const there = shiftDecimal(text, exponent);
        const back = shiftDecimal(there, -exponent);
        expect(back).toBe(shiftDecimal(text, 0));
      }),
      { numRuns: 2000 },
    );
  });

  it("agrees with exact integer arithmetic on whole numbers", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 20n), max: 10n ** 20n }),
        fc.integer({ min: 0, max: 6 }),
        (value, exponent) => {
          const expected = (value * 10n ** BigInt(exponent)).toString();
          expect(shiftDecimal(value.toString(), exponent)).toBe(expected);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("preserves ordering under a positive shift", () => {
    fc.assert(
      fc.property(
        decimalText,
        decimalText,
        fc.integer({ min: 1, max: 6 }),
        (a, b, exponent) => {
          expect(
            compareDecimal(shiftDecimal(a, exponent), shiftDecimal(b, exponent)),
          ).toBe(compareDecimal(a, b));
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("round-trips every parseable decimal through parse and format", () => {
    fc.assert(
      fc.property(decimalText, (text) => {
        const once = shiftDecimal(text, 0);
        expect(shiftDecimal(once, 0)).toBe(once);
        expect(() => parseDecimal(once)).not.toThrow();
      }),
      { numRuns: 1000 },
    );
  });
});

describe("comparing zero", () => {
  // -0 is valid JSON and the same number as 0. Comparing signs first put it
  // below 0, which a property test found with the seed 2030732703.
  it("treats a negative zero as zero, at any scale", () => {
    expect(compareDecimal("0", "-0")).toBe(0);
    expect(compareDecimal("-0.00", "0")).toBe(0);
    expect(compareDecimal("-0", "0.1")).toBe(-1);
    expect(compareDecimal("-0", "-0.1")).toBe(1);
    expect(compareDecimal("-1.5", "-1.50")).toBe(0);
    expect(compareDecimal("-2", "-10")).toBe(1);
  });
});
