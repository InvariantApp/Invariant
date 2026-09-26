import { describe, expect, it } from "vitest";
import { appendedEntry, pythonLiteral } from "./supplied.ts";
import { descendantsOfType, parsePython } from "./syntax.ts";

describe("a field supplied where a request is built", () => {
  it("writes each value as Python does", () => {
    expect(
      [null, true, 3, "none", ["a"], { tax: { exempt: false } }].map(pythonLiteral),
    ).toEqual(["None", "True", "3", '"none"', '["a"]', '{"tax": {"exempt": False}}']);
  });

  it("appends to the arguments as they are laid out", async () => {
    const text = [
      'create(email=email, name="x")',
      "create(email=email,)",
      "create()",
      "create(",
      "    email=email,",
      "    name=name,",
      ")",
      "create(",
      "    email=email",
      ")",
      "",
    ].join("\n");
    const tree = await parsePython(text);
    let out = text;
    const edits = descendantsOfType(tree.rootNode, ["argument_list"])
      .map((args) => appendedEntry(text, args, 'tax_exempt="none"'))
      .filter((edit) => edit !== undefined)
      .sort((a, b) => b.start - a.start);
    for (const edit of edits) {
      out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
    }
    tree.delete();
    expect(out).toBe(
      [
        'create(email=email, name="x", tax_exempt="none")',
        'create(email=email, tax_exempt="none")',
        'create(tax_exempt="none")',
        "create(",
        "    email=email,",
        "    name=name,",
        '    tax_exempt="none",',
        ")",
        "create(",
        "    email=email,",
        '    tax_exempt="none"',
        ")",
        "",
      ].join("\n"),
    );
  });
});
