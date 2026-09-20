/**
 * Declarations for JSON source-text access and raw JSON values.
 *
 * These are shipped in V8 and available from Node 22, but the TypeScript 6
 * standard library does not describe them yet. They are declared here rather
 * than worked around, because reading the number the caller actually wrote is
 * the whole reason this runtime can promise exact money.
 */

interface JsonRawValue {
  readonly rawJSON: string;
}

interface JsonParseContext {
  /** The exact source text of the value being revived. */
  readonly source?: string;
}

interface JSON {
  parse(
    text: string,
    reviver: (
      this: unknown,
      key: string,
      value: unknown,
      context: JsonParseContext,
    ) => unknown,
  ): unknown;

  /**
   * Wraps already-valid JSON text so that `stringify` emits it verbatim,
   * without the value passing through a double.
   */
  rawJSON(text: string): JsonRawValue;

  isRawJSON(value: unknown): value is JsonRawValue;
}
