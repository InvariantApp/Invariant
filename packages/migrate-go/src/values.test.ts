import { describe, expect, it } from "vitest";
import { appendedElement, goLiteral } from "./values.ts";

describe("a field supplied where a struct is built", () => {
  it("writes a value only as a literal of the field's type", () => {
    expect(goLiteral("none", "string")).toBe('"none"');
    expect(goLiteral("none", "TaxExempt", "string")).toBe('"none"');
    expect(goLiteral(3, "int64")).toBe("3");
    expect(goLiteral(2.5, "float64")).toBe("2.5");
    expect(goLiteral(true, "bool")).toBe("true");
    expect(goLiteral(2.5, "int64")).toBeUndefined();
    expect(goLiteral("none", "*string")).toBeUndefined();
    expect(goLiteral({ a: 1 }, "Settings")).toBeUndefined();
  });

  it("appends to the literal as it is laid out", () => {
    const apply = (text: string) => {
      const lbrace = text.indexOf("{");
      const rbrace = text.lastIndexOf("}");
      const elements = [...text.slice(lbrace + 1, rbrace).matchAll(/\w+: \w+/g)].map(
        (match): [number, number] => [
          lbrace + 1 + match.index,
          lbrace + 1 + match.index + match[0].length,
        ],
      );
      const edit = appendedElement(text, lbrace, rbrace, elements, 'TaxExempt: "none"');
      return edit
        ? text.slice(0, edit.start) + edit.replacement + text.slice(edit.end)
        : undefined;
    };
    expect(apply("sdk.Params{Email: email}")).toBe(
      'sdk.Params{Email: email, TaxExempt: "none"}',
    );
    expect(apply("sdk.Params{}")).toBe('sdk.Params{TaxExempt: "none"}');
    expect(apply("sdk.Params{\n\tEmail: email,\n}")).toBe(
      'sdk.Params{\n\tEmail: email,\n\tTaxExempt: "none",\n}',
    );
  });
});
