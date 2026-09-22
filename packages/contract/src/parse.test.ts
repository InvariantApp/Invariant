import { describe, expect, it } from "vitest";
import {
  DocumentTooLargeError,
  DuplicateKeyError,
  expandedSize,
  parseDocumentText,
} from "./parse.ts";

describe("reading YAML with aliases", () => {
  it("takes one anchor reused hundreds of times, as Langfuse's specification does", () => {
    const uses = Array.from({ length: 500 }, (_, i) => `  field${i}: *text`).join("\n");
    const text = `shared: &text { type: string, nullable: true }\nproperties:\n${uses}\n`;
    const document = parseDocumentText("openapi.yaml", text) as {
      properties: Record<string, unknown>;
    };
    expect(document.properties["field499"]).toEqual({ type: "string", nullable: true });
  });

  it("refuses an expansion attack before anything writes it out", () => {
    // Ten uses at each of nine levels: a billion values written out, from a
    // few hundred bytes. The library's own guard allowed this.
    const levels = ["a: &a [x, x, x, x, x, x, x, x, x, x]"];
    for (let level = 1; level < 9; level += 1) {
      const previous = String.fromCharCode(96 + level);
      const name = String.fromCharCode(97 + level);
      levels.push(`${name}: &${name} [${Array(10).fill(`*${previous}`).join(", ")}]`);
    }
    const started = Date.now();
    expect(() => parseDocumentText("bomb.yaml", levels.join("\n"))).toThrow(
      DocumentTooLargeError,
    );
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("gives each use of an anchor its own copy, so an edit to one is not an edit to all", () => {
    const text = "shared: &body { type: object }\na: *body\nb: *body\n";
    const document = parseDocumentText("openapi.yaml", text) as Record<string, object>;
    expect(document["a"]).toEqual(document["b"]);
    expect(document["a"]).not.toBe(document["b"]);
  });

  it("counts a shared value once for each place it is used", () => {
    const shared = { a: 1, b: [1, 2] };
    // The object, its number, and its list with the list's two numbers.
    expect(expandedSize(shared)).toBe(5);
    expect(expandedSize([shared, shared, shared])).toBe(1 + 3 * 5);
  });

  it("reads a key defined twice when both definitions are the same (Okta's path parameters)", () => {
    const text = [
      "components:",
      "  parameters:",
      "    pathId:",
      "      name: id",
      "      in: path",
      "    pathId:",
      "      name: id",
      "      in: path",
    ].join("\n");
    expect(parseDocumentText("openapi.yaml", text)).toEqual({
      components: { parameters: { pathId: { name: "id", in: "path" } } },
    });
  });

  it("refuses a key defined twice differently, and says where", () => {
    const text = ["a:", "  type: string", "a:", "  type: integer"].join("\n");
    expect(() => parseDocumentText("openapi.yaml", text)).toThrow(DuplicateKeyError);
    expect(() => parseDocumentText("openapi.yaml", text)).toThrow(/`a`.*line 3/);
  });

  it("reads a quoted example closed at the first column, as Mistral publishes one", () => {
    const text = [
      "paths:",
      "  /v1/ocr:",
      "    post:",
      "      description: 'First line",
      "",
      "        second line",
      "",
      "'",
      "      operationId: ocr",
    ].join("\n");
    expect(parseDocumentText("openapi.yaml", text)).toEqual({
      paths: {
        "/v1/ocr": {
          post: { description: "First line\nsecond line\n", operationId: "ocr" },
        },
      },
    });
  });
});
