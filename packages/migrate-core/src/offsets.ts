/**
 * Byte offsets and string offsets into the same text.
 *
 * Compilers other than TypeScript's count in bytes of UTF-8: `go/token`
 * reports `Offset` in bytes, and so does tree-sitter. JavaScript strings are
 * indexed in UTF-16 code units, and every edit here is applied to a string.
 * The two agree only while a file is ASCII, which is why a mistake between
 * them survives every test written in English and then moves an edit two
 * characters to the left in the first file with a Japanese comment above the
 * call site. So the conversion is done once, here, and tested on text that is
 * not ASCII.
 */
export class Offsets {
  readonly #text: string;
  /** Byte offset at each code unit, and at the end; absent while the text is ASCII. */
  readonly #bytes: Uint32Array | undefined;

  constructor(text: string) {
    this.#text = text;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the test is for anything outside ASCII.
    this.#bytes = /[^\u0000-\u007f]/.test(text) ? byteTable(text) : undefined;
  }

  /** The text's length in bytes of UTF-8. */
  get byteLength(): number {
    return this.#bytes ? (this.#bytes[this.#text.length] as number) : this.#text.length;
  }

  /** The string index a byte offset falls at; inside a character, the character's start. */
  toIndex(byte: number): number {
    if (byte < 0 || byte > this.byteLength) {
      throw new RangeError(
        `byte offset ${byte} is outside a ${this.byteLength}-byte text`,
      );
    }
    const bytes = this.#bytes;
    if (!bytes) return byte;
    // The last index whose byte offset is at most `byte`.
    let low = 0;
    let high = this.#text.length;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((bytes[middle] as number) <= byte) low = middle;
      else high = middle - 1;
    }
    // The second half of a surrogate pair shares its pair's byte offset.
    while (low > 0 && bytes[low - 1] === bytes[low]) low -= 1;
    return low;
  }

  /** The byte offset of a string index. */
  toByte(index: number): number {
    if (index < 0 || index > this.#text.length) {
      throw new RangeError(
        `index ${index} is outside a text of ${this.#text.length} code units`,
      );
    }
    return this.#bytes ? (this.#bytes[index] as number) : index;
  }
}

function byteTable(text: string): Uint32Array {
  const bytes = new Uint32Array(text.length + 1);
  let at = 0;
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = at;
    const unit = text.charCodeAt(index);
    if (unit < 0x80) at += 1;
    else if (unit < 0x800) at += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        // A pair is one character of four bytes, and both halves start it.
        bytes[index + 1] = at;
        at += 4;
        index += 1;
        continue;
      }
      at += 3;
    } else at += 3;
  }
  bytes[text.length] = at;
  return bytes;
}
