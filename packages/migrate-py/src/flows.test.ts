import { describe, expect, it } from "vitest";
import { Sources } from "./engine.ts";
import { type FlowProvider, ValueFlow } from "./flows.ts";
import type { Span } from "./references.ts";
import { nodeAt, parsePython } from "./syntax.ts";

describe("ValueFlow", () => {
  it("ends a value that leads back to itself across an await, rather than waiting on itself", async () => {
    // `a` is `b` and `b` is `a`. Each step asks the checker first, so the
    // cycle closes only after an await, where the unfinished answer for `a`
    // had already been recorded and was handed back to `a` itself.
    const file = "/repo/cycle.py";
    const text = "a = b\nb = a\nprint(a.type)\n";
    const at = (needle: string, from = 0) => text.indexOf(needle, from);
    const texts = new Map([[file, text]]);
    const span = (start: number): Span => ({ file, start, end: start + 1 }) as Span;
    const provider = {
      typeAt: async () => undefined,
      definitionAt: async (_file: string, offset: number) => {
        const name = text[offset];
        // Each name is defined where it is assigned: `a` on the first line, `b` on the second.
        return [span(name === "a" ? at("a = b") : at("b = a"))];
      },
    } as unknown as FlowProvider;
    const flow = new ValueFlow(provider, new Sources(texts), "sdk");
    const tree = await parsePython(text);
    const read = nodeAt(tree, at("a.type"), at("a.type") + 1);
    if (!read) throw new Error("no node for the read of `a`");
    const settled = await Promise.race([
      flow.classOf(file, read).then((found) => ({ found })),
      new Promise((resolve) => setTimeout(() => resolve("waited on itself"), 2_000)),
    ]);
    expect(settled).toEqual({ found: undefined });
  });
});
