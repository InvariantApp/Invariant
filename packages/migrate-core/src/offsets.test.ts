import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Offsets } from "./offsets.ts";

describe("Offsets", () => {
  it("is the identity on ASCII", () => {
    const offsets = new Offsets("client.Actions.DeleteEnvSecret(ctx)");
    expect(offsets.toIndex(7)).toBe(7);
    expect(offsets.toByte(7)).toBe(7);
    expect(offsets.byteLength).toBe(35);
  });

  it("counts two, three and four bytes where UTF-8 does", () => {
    // é is two bytes, 名 three, and 🙂 four bytes in two code units.
    const text = "é名🙂x";
    const offsets = new Offsets(text);
    expect(offsets.byteLength).toBe(Buffer.byteLength(text));
    expect(offsets.toByte(text.indexOf("名"))).toBe(2);
    expect(offsets.toByte(text.indexOf("🙂"))).toBe(5);
    expect(offsets.toByte(text.indexOf("x"))).toBe(9);
    expect(offsets.toIndex(9)).toBe(text.indexOf("x"));
    expect(offsets.toIndex(5)).toBe(text.indexOf("🙂"));
  });

  it("puts a byte inside a character at the character's start", () => {
    const offsets = new Offsets("a🙂b");
    expect(offsets.toIndex(2)).toBe(1);
    expect(offsets.toIndex(4)).toBe(1);
    expect(offsets.toIndex(5)).toBe(3);
  });

  it("refuses offsets outside the text", () => {
    const offsets = new Offsets("名");
    expect(() => offsets.toIndex(4)).toThrow(RangeError);
    expect(() => offsets.toByte(2)).toThrow(RangeError);
  });

  it("agrees with Buffer at every character boundary", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), (text) => {
        const offsets = new Offsets(text);
        for (let index = 0; index <= text.length; index += 1) {
          const unit = text.charCodeAt(index - 1);
          // Skip the middle of a surrogate pair, which is not a boundary.
          if (unit >= 0xd800 && unit <= 0xdbff) continue;
          const byte = Buffer.byteLength(text.slice(0, index));
          expect(offsets.toByte(index)).toBe(byte);
          expect(offsets.toIndex(byte)).toBe(index);
        }
      }),
    );
  });
});
