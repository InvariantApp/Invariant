/**
 * Where a place in a file is, in the three ways the tools here count.
 *
 * A JavaScript string, tree-sitter's web build and the Language Server
 * Protocol all count UTF-16 code units: `"é😀"` is three of them, since the
 * emoji is a surrogate pair. Edits are offsets into the string, pyright takes
 * a line and a character, and both come from the same count, so converting is
 * only a matter of finding where each line starts.
 *
 * Python's own tools count differently: `ast` reports columns in UTF-8 bytes,
 * where the same text is six. Nothing here reads them, but a position that
 * arrives that way converts through `byteColumnToCharacter` rather than being
 * taken for a character offset, which is right only for ASCII.
 */
import type { Position } from "./pyright.ts";

export class LineIndex {
  private readonly starts: number[] = [0];

  private readonly text: string;

  constructor(text: string) {
    this.text = text;
    for (let at = 0; at < text.length; at += 1) {
      if (text.charCodeAt(at) === 10) this.starts.push(at + 1);
    }
  }

  /** The line and character of an offset into the text. */
  positionAt(offset: number): Position {
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((this.starts[middle] as number) <= clamped) low = middle;
      else high = middle - 1;
    }
    return { line: low, character: clamped - (this.starts[low] as number) };
  }

  /** The offset into the text of a line and character, clamped to the line. */
  offsetAt(position: Position): number {
    if (position.line >= this.starts.length) return this.text.length;
    const start = this.starts[Math.max(0, position.line)] as number;
    const next = this.starts[position.line + 1] ?? this.text.length + 1;
    return Math.min(start + Math.max(0, position.character), next - 1);
  }

  /** How many lines the text has. */
  get lines(): number {
    return this.starts.length;
  }
}

/** A UTF-8 byte column on a line, as Python's `ast` reports it, as a UTF-16 character offset. */
export function byteColumnToCharacter(line: string, byteColumn: number): number {
  let bytes = 0;
  let at = 0;
  while (at < line.length && bytes < byteColumn) {
    const code = line.codePointAt(at) as number;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    at += code > 0xffff ? 2 : 1;
  }
  return at;
}
