/**
 * The API version a Python consumer pins, and where it is written.
 *
 * stripe-python sends `stripe.api_version` with every request when it is set,
 * and `stripe_version=` on a client or a single call does the same. Each
 * release is built for one version, and its classes describe that version's
 * objects, so a consumer that pinned the version the old release was built
 * for has to move the pin with the upgrade or read new objects through old
 * shapes. The type checker finds every assignment to the attribute, through
 * any import of the module, and every keyword it resolves to the SDK's own
 * parameter.
 *
 * Every pin is shown to a person, never moved. In TypeScript the SDK's types
 * make the old version a compile error, so moving it is the only edit that
 * compiles; in Python `api_version` is a `str`, and a pin left where it was
 * keeps working against the version it names. Moving it changes the shape of
 * every request and response at once, which learning-unlimited's
 * ESP-Website chose not to do when it took stripe-python from 2 to 7: the
 * engine moved its two pins and the humans had kept them. Where the version
 * is written, through a constant or a settings module, is what is reported.
 */
import type { SymbolMap } from "@invariant-app/migrate-core";
import { type EngineResult, manualAt, type Sources } from "./engine.ts";
import { isSpan, type ReferenceProvider, type Span } from "./references.ts";
import { descendantsOfType, type Node, nodeAt, stringValue } from "./syntax.ts";

const CHANGE = "sdk-upgrade";
/** How many names a version is followed through before it is shown to a person instead. */
const MAX_HOPS = 4;

export async function bumpPins(
  references: ReferenceProvider,
  sources: Sources,
  symbols: SymbolMap,
  result: EngineResult,
): Promise<void> {
  const pin = symbols.pin;
  if (!pin) return;
  const done = new Set<string>();
  const declaration = await references.moduleAttribute(pin.type, pin.property);
  const values: { file: string; node: Node }[] = [];
  if (declaration) {
    for (const span of await references.referencesTo(declaration)) {
      const node = await nodeFor(sources, span);
      const attribute = node?.parent;
      const assignment = attribute?.parent;
      if (
        attribute?.type !== "attribute" ||
        assignment?.type !== "assignment" ||
        assignment.childForFieldName("left")?.id !== attribute.id
      ) {
        continue;
      }
      const value = assignment.childForFieldName("right");
      if (value) values.push({ file: span.file, node: value });
    }
  }
  for (const keyword of pin.keywords ?? []) {
    for (const [file, text] of sources.texts) {
      if (!text.includes(keyword)) continue;
      const tree = await sources.tree(file);
      if (!tree) continue;
      for (const argument of descendantsOfType(tree.rootNode, ["keyword_argument"])) {
        const name = argument.childForFieldName("name");
        const value = argument.childForFieldName("value");
        if (name?.text !== keyword || !value) continue;
        // Only a keyword the checker resolves into the SDK is its pin; a
        // function of the consumer's own may take the same name.
        const points = await references.definitionAt(file, name.startIndex);
        if (!points.some((point) => !isSpan(point))) continue;
        values.push({ file, node: value });
      }
    }
  }
  for (const { file, node } of values) {
    await moveLiteral(references, sources, file, node, pin, done, result, 0);
  }
}

async function nodeFor(sources: Sources, span: Span): Promise<Node | undefined> {
  const tree = await sources.tree(span.file);
  return tree && nodeAt(tree, span.start, span.end);
}

/** Reports the literal a pin's value comes down to, or where else it comes from. */
async function moveLiteral(
  references: ReferenceProvider,
  sources: Sources,
  file: string,
  value: Node,
  pin: NonNullable<SymbolMap["pin"]>,
  done: Set<string>,
  result: EngineResult,
  hops: number,
): Promise<void> {
  const text = sources.texts.get(file) ?? "";
  const key = `${file}:${value.startIndex}`;
  if (done.has(key)) return;
  done.add(key);
  const literal = stringValue(value);
  if (literal !== undefined) {
    if (literal === pin.label) return;
    result.manual.push(
      manualAt(
        file,
        text,
        value.startIndex,
        value.endIndex,
        CHANGE,
        literal === pin.from
          ? `this pins API version ${literal}, the one the old release was built for; the upgraded SDK is built for ${pin.label}. Move it once the contract changes reported with it are handled: every request changes shape when it moves`
          : `this pins API version ${literal}; the upgraded SDK is built for ${pin.label}, and its types describe that version's objects`,
      ),
    );
    return;
  }
  // A name: the literal is wherever the consumer assigned it.
  const name =
    value.type === "identifier"
      ? value
      : value.type === "attribute"
        ? value.childForFieldName("attribute")
        : null;
  if (name && hops < MAX_HOPS) {
    for (const point of await references.definitionAt(file, name.startIndex)) {
      if (!isSpan(point)) continue;
      const target = await nodeFor(sources, point);
      const assignment = target?.parent;
      const assigned =
        assignment?.type === "assignment" &&
        assignment.childForFieldName("left")?.id === target?.id
          ? assignment.childForFieldName("right")
          : null;
      if (assigned) {
        await moveLiteral(
          references,
          sources,
          point.file,
          assigned,
          pin,
          done,
          result,
          hops + 1,
        );
        return;
      }
    }
  }
  result.manual.push(
    manualAt(
      file,
      text,
      value.startIndex,
      value.endIndex,
      CHANGE,
      `the API version comes from \`${value.text.slice(0, 60)}\`; make sure it is ${pin.label}, the one the upgraded SDK speaks`,
    ),
  );
}
