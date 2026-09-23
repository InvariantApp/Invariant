import { describe, expect, it } from "vitest";
import { byteColumnToCharacter, LineIndex } from "./offsets.ts";

describe("positions and offsets", () => {
  it("round-trips every offset of a text with surrogate pairs and CRLF", () => {
    const text = 'x = "é😀"\r\ny.z = 1\n\nlast';
    const index = new LineIndex(text);
    for (let offset = 0; offset <= text.length; offset += 1) {
      expect(index.offsetAt(index.positionAt(offset))).toBe(offset);
    }
    expect(index.positionAt(text.indexOf("y.z"))).toEqual({ line: 1, character: 0 });
    expect(index.positionAt(text.indexOf("last"))).toEqual({ line: 3, character: 0 });
    expect(index.lines).toBe(4);
  });

  it("counts the emoji as the two code units LSP and tree-sitter count", () => {
    const index = new LineIndex('s = "😀"; t = 1');
    expect(index.positionAt('s = "😀"; t'.length - 1)).toEqual({
      line: 0,
      character: 10,
    });
  });

  it("clamps a character past the end of its line to the line", () => {
    const index = new LineIndex("ab\ncd");
    expect(index.offsetAt({ line: 0, character: 99 })).toBe(2);
    expect(index.offsetAt({ line: 9, character: 0 })).toBe(5);
  });

  it("converts Python's UTF-8 byte columns", () => {
    const line = 'x = "é😀" + name';
    // `ast` puts `name` at byte 15: é is two bytes, the emoji four.
    expect(byteColumnToCharacter(line, 15)).toBe(line.indexOf("name"));
    expect(byteColumnToCharacter("plain", 3)).toBe(3);
  });
});
