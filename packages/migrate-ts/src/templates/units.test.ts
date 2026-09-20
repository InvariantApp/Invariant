/**
 * The conversion module a migration writes into a consumer.
 *
 * It is tested here, where it lives, rather than trusted because it looked
 * right in a template string. The oracle is exact integer arithmetic on the
 * digits, because the thing being guarded against is precisely that the
 * obvious implementation is wrong.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fromMinorUnits, toMinorUnits } from "./units.ts";

describe("currency unit conversion", () => {
  it("does not inherit the error that multiplying by a hundred has", () => {
    // 19.99 * 100 is 1998.9999999999998 in binary floating point. A price is
    // not allowed to depend on that.
    expect(19.99 * 100).not.toBe(1999);
    expect(toMinorUnits(19.99)).toBe(1999);
    expect(toMinorUnits(0.07)).toBe(7);
    expect(toMinorUnits(1234.56)).toBe(123456);
    expect(toMinorUnits(-4.35)).toBe(-435);
  });

  it("handles whole numbers and zero", () => {
    expect(toMinorUnits(199)).toBe(19900);
    expect(toMinorUnits(0)).toBe(0);
    expect(fromMinorUnits(0)).toBe(0);
  });

  it("converts back", () => {
    expect(fromMinorUnits(1999)).toBe(19.99);
    expect(fromMinorUnits(7)).toBe(0.07);
    expect(fromMinorUnits(19900)).toBe(199);
    expect(fromMinorUnits(-435)).toBe(-4.35);
  });

  it("round trips every amount with two decimal places", () => {
    fc.assert(
      fc.property(fc.integer({ min: -100_000_000, max: 100_000_000 }), (minor) => {
        expect(toMinorUnits(fromMinorUnits(minor))).toBe(minor);
      }),
      { numRuns: 2000 },
    );
  });

  it("agrees with integer arithmetic on the digits", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -99_999_999, max: 99_999_999 }),
        fc.integer({ min: 0, max: 2 }),
        (units, places) => {
          const major = Number(`${units / 10 ** places}`);
          // The oracle: shifting the point is multiplying by a power of ten in
          // exact integer space, which is what the implementation must match.
          expect(toMinorUnits(major, places)).toBe(units);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("refuses a value it cannot represent rather than losing digits", () => {
    expect(() => toMinorUnits(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => toMinorUnits(Number.NaN)).toThrow(RangeError);
    expect(() => toMinorUnits(1e17)).toThrow(/safe integer/);
  });
});
