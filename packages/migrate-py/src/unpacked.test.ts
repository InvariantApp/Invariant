import { describe, expect, it } from "vitest";
import { parsePython } from "./syntax.ts";
import { rejected, unpackingsIn, usesOfImported, writtenOut } from "./unpacked.ts";

describe("dictionaries unpacked into a call", () => {
  it("reads the keys a name is bound to in its scope, closures included", async () => {
    const text = [
      "def complete(request):",
      "    raw_request: Dict[str, Any] = {",
      '        "engine": request.model,',
      '        "prompt": request.prompt,',
      "    }",
      '    raw_request["best_of"] = 2',
      '    raw_request.update({"n": 1}, echo=True)',
      "",
      "    def do_it():",
      "        return openai.Completion.create(**raw_request)",
      "",
      "    return do_it()",
      "",
      'openai.Embedding.create(**{"engine": "e", "input": "i"})',
      'openai.Edit.create(**dict(engine="e"))',
    ].join("\n");
    const tree = await parsePython(text);
    const found = unpackingsIn(tree);
    expect(found.map((each) => [each.name, each.keys.map((key) => key.key)])).toEqual([
      ["raw_request", ["engine", "prompt", "best_of", "n", "echo"]],
      [undefined, ["engine", "input"]],
      [undefined, ["engine"]],
    ]);
    tree.delete();
  });

  it("follows nothing it cannot read whole", async () => {
    const text = [
      "def a(params):",
      "    return client.create(**params)",
      "",
      "def b(extra):",
      '    params = {"x": 1}',
      "    params = build(extra)",
      "    return client.create(**params)",
      "",
      "def c(key):",
      '    params = {"x": 1}',
      "    params[key] = 2",
      "    return client.create(**params)",
      "",
      "def d():",
      '    params = {"x": 1, **defaults}',
      "    return client.create(**params)",
      "",
      "def e():",
      '    params = {"x": 1, "y": 2}',
      '    del params["y"]',
      "    return client.create(**params)",
      "",
      "def f():",
      '    for params in [{"x": 1}]:',
      "        client.create(**params)",
    ].join("\n");
    const tree = await parsePython(text);
    expect(unpackingsIn(tree)).toEqual([]);
    tree.delete();
  });

  it("writes the keys out as keywords, and reads back which the checker refuses", async () => {
    const text = [
      'raw = {"engine": 1, "prompt": 2, "n": 3}',
      "create(prompt=0, **raw)",
      "",
    ].join("\n");
    const tree = await parsePython(text);
    const out = writtenOut(text, unpackingsIn(tree));
    // `prompt` is passed by name already, and writing it twice would be an
    // error of its own.
    expect(out.text).toBe(
      'raw = {"engine": 1, "prompt": 2, "n": 3}\ncreate(prompt=0, engine=raw["engine"], n=raw["n"])\n',
    );
    const at = (needle: string) => {
      const offset = out.text.indexOf(needle);
      const line = out.text.slice(0, offset).split("\n").length - 1;
      const character = offset - out.text.lastIndexOf("\n", offset - 1) - 1;
      return { line, character };
    };
    const refused = rejected(out.text, out.written, [
      {
        code: "reportCallIssue",
        message: 'No parameter named "engine"',
        range: { start: at("engine="), end: at('=raw["engine"]') },
      },
      {
        code: "reportArgumentType",
        message: 'Argument of type "int" cannot be assigned to parameter "n"',
        range: { start: at('raw["n"]'), end: at(")\n") },
      },
    ]);
    expect([...refused].map((keyword) => keyword.key.key)).toEqual(["engine"]);
    tree.delete();
  });
});

describe("the uses of an imported name", () => {
  it("are every read of it, and none where the file binds it again", async () => {
    const text = [
      "from kubernetes.client import V1beta1CustomResourceDefinition as CRD",
      "",
      'CRDS = [CRD(kind="a"), CRD(kind="b")]',
      "other.CRD = 1",
      "make(CRD=2)",
      "",
    ].join("\n");
    const tree = await parsePython(text);
    const statement = tree.rootNode.namedChildren[0];
    const uses = statement ? usesOfImported(tree, "CRD", statement) : [];
    expect(uses.map((node) => node.parent?.text)).toEqual([
      'CRD(kind="a")',
      'CRD(kind="b")',
    ]);
    tree.delete();
    const shadowed = await parsePython(`${text}\ndef f(CRD):\n    return CRD\n`);
    const first = shadowed.rootNode.namedChildren[0];
    expect(first ? usesOfImported(shadowed, "CRD", first) : undefined).toEqual([]);
    shadowed.delete();
  });
});
