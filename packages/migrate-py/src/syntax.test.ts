import { describe, expect, it } from "vitest";
import {
  importedModules,
  nodeAt,
  parsePython,
  roleOf,
  statementAround,
  stringValue,
  withStringValue,
} from "./syntax.ts";

describe("the statement a reviewer is shown", () => {
  it("is the whole call around an argument, and not the block around a condition", async () => {
    const text = [
      "if client.old_flag:",
      "    client.indices.create(",
      "        index=name,",
      "        body={'mappings': m},",
      "    )",
    ].join("\n");
    const tree = await parsePython(text);
    const body = text.indexOf("body=");
    const call = statementAround(tree, body, body + 4);
    expect(text.slice(call.start, call.end)).toBe(
      "client.indices.create(\n        index=name,\n        body={'mappings': m},\n    )",
    );
    const flag = text.indexOf("old_flag");
    expect(statementAround(tree, flag, flag + 8)).toEqual({ start: flag, end: flag + 8 });
  });
});

const at = async (text: string, needle: string, from = 0) => {
  const tree = await parsePython(text);
  const start = text.indexOf(needle, from);
  return nodeAt(tree, start, start + needle.length);
};

describe("roles", () => {
  it("tells a read from a write, a keyword, a key and a subscript", async () => {
    const text = [
      "end = sub.current_period_end",
      "sub.current_period_end = 1",
      "del sub.current_period_end",
      "stripe.Subscription.create(current_period_end=1)",
      'params = {"current_period_end": 1}',
      'raw = sub["current_period_end"]',
      'print("current_period_end")',
    ].join("\n");
    const roles = [];
    let from = 0;
    for (let line = 0; line < 7; line += 1) {
      from = text.indexOf("current_period_end", from);
      const quoted = text[from - 1] === '"';
      const node = await at(
        text,
        quoted ? '"current_period_end"' : "current_period_end",
        quoted ? from - 1 : from,
      );
      roles.push(node && roleOf(node));
      from += 1;
    }
    expect(roles).toEqual([
      "attribute-read",
      "attribute-write",
      "attribute-write",
      "keyword",
      "dict-key",
      "subscript",
      "unknown",
    ]);
  });

  it("does not take the object of an attribute for its field", async () => {
    const node = await at("current_period_end.x", "current_period_end");
    expect(node && roleOf(node)).toBe("unknown");
  });
});

describe("string literals", () => {
  it("reads plain literals and refuses the ones that are not one value", async () => {
    const values = await Promise.all(
      [`"a"`, `'b'`, `r"c\\d"`, `"e\\"f"`, `f"{x}"`, `b"g"`, `"h" "i"`].map(
        async (literal) => {
          const tree = await parsePython(`x = ${literal}`);
          const node = tree.rootNode.descendantsOfType("string")[0];
          return stringValue(node);
        },
      ),
    );
    expect(values).toEqual(["a", "b", "c\\d", 'e"f', undefined, undefined, undefined]);
  });

  it("writes a new value in the quotes the literal used", async () => {
    const tree = await parsePython(`x = '2024-12-18.acacia'`);
    const node = tree.rootNode.descendantsOfType("string")[0];
    expect(node && withStringValue(node, "2025-10-29.clover")).toBe(
      "'2025-10-29.clover'",
    );
  });
});

describe("imports", () => {
  it("names the top-level modules a file imports", async () => {
    const tree = await parsePython(
      [
        "import stripe",
        "import os.path as p",
        "from github import Github",
        "from . import local",
        "import openai, json",
      ].join("\n"),
    );
    expect([...importedModules(tree)].sort()).toEqual([
      "",
      "github",
      "json",
      "openai",
      "os",
      "stripe",
    ]);
  });
});
