/**
 * The form declaration a site carries when its request body may arrive
 * form-encoded.
 *
 * A form carries every value as text and writes nested fields in a style its
 * declaration chooses, so the runtime needs two things the instructions do not
 * say: how each top-level field is written, from the OpenAPI `encoding`
 * object, and what each place an instruction reads holds, from the schema, so
 * `amount=49.99` reaches a scale as a number.
 */

import type { OpenApiDocument } from "@invariant/contract";
import { type RequestBodyMedia, resolveSchema } from "@invariant/contract";
import {
  type FormProgram,
  formatPointer,
  type Instr,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  parsePointer,
} from "@invariant/ir";

type FormType = FormProgram["types"][string];

function fieldsOf(encoding: JsonObject | undefined): FormProgram["fields"] {
  const fields: FormProgram["fields"] = {};
  if (!encoding) return fields;
  for (const [name, entry] of Object.entries(encoding)) {
    if (!isJsonObject(entry)) continue;
    const style = entry["style"] === "deepObject" ? "deepObject" : "form";
    const explode =
      typeof entry["explode"] === "boolean" ? entry["explode"] : style === "form";
    // A plain, exploded field is the default and needs no entry.
    if (style === "form" && explode) continue;
    fields[name] = { style, explode };
  }
  return fields;
}

function typeOf(schema: JsonValue | undefined): FormType | undefined {
  if (!isJsonObject(schema)) return undefined;
  const declared = schema["type"];
  const types = (Array.isArray(declared) ? declared : [declared]).filter(
    (type): type is string => typeof type === "string" && type !== "null",
  );
  const type = types[0];
  if (type === undefined) {
    if (isJsonObject(schema["properties"])) return "object";
    if (schema["items"] !== undefined) return "array";
    return undefined;
  }
  return ["string", "integer", "number", "boolean", "array", "object"].includes(type)
    ? (type as FormType)
    : undefined;
}

/** What the schema says is at each prefix of a pointer, where it says anything. */
function typesAlong(
  document: OpenApiDocument,
  root: JsonValue,
  pointer: string,
  into: Record<string, FormType>,
): void {
  const segments = parsePointer(pointer);
  let current: JsonValue | undefined = resolveSchema(document, root);
  for (const [index, segment] of segments.entries()) {
    if (!isJsonObject(current)) return;
    const next: JsonValue | undefined =
      segment === "*"
        ? current["items"]
        : isJsonObject(current["properties"])
          ? (current["properties"] as JsonObject)[segment]
          : undefined;
    if (next === undefined) return;
    current = resolveSchema(document, next);
    const type = typeOf(current);
    if (type !== undefined) into[formatPointer(segments.slice(0, index + 1))] = type;
  }
}

/**
 * The declaration for a site whose body instructions are `instrs`, with
 * pointers relative to the body. `old` is the operation's body as an old
 * caller sends it; `current`, where known, supplies how a field the program
 * writes under a new name is written.
 */
export function formProgramFor(
  oldDocument: OpenApiDocument,
  old: RequestBodyMedia,
  current: RequestBodyMedia | undefined,
  instrs: readonly Instr[],
  blocks: Readonly<Record<string, Instr[]>> = {},
): FormProgram {
  const types: Record<string, FormType> = {};
  for (const instr of instrs) {
    for (const pointer of readsOf(instr, blocks)) {
      typesAlong(oldDocument, old.schema, pointer, types);
    }
  }
  return {
    fields: { ...fieldsOf(current?.encoding), ...fieldsOf(old.encoding) },
    types,
  };
}

/**
 * Every place an instruction reads, from the root it runs at, looking inside
 * blocks: what a `within` block reads is read under each of its matches, and
 * a called block is read where it is called. A block that recurs is followed
 * once per path, which names each field at the depth it is first reached;
 * a form deep enough to recur further is typed down to there.
 */
function readsOf(
  instr: Instr,
  blocks: Readonly<Record<string, Instr[]>>,
  entered: ReadonlySet<string> = new Set(),
): string[] {
  const under = (base: string, inner: string) =>
    formatPointer([...parsePointer(base), ...parsePointer(inner)]);
  const inner = (block: readonly Instr[]) =>
    block.flatMap((each) => readsOf(each, blocks, entered));
  switch (instr.k) {
    case "move":
      return [instr.from];
    case "within":
      return [instr.path, ...inner(instr.block).map((read) => under(instr.path, read))];
    case "switch":
      return [instr.path, ...Object.values(instr.cases).flatMap(inner)];
    case "has":
    case "is":
      return [instr.path, ...inner(instr.block)];
    case "call": {
      if (entered.has(instr.block)) return [];
      const deeper = new Set(entered).add(instr.block);
      return (blocks[instr.block] ?? []).flatMap((each) => readsOf(each, blocks, deeper));
    }
    default:
      return [instr.path];
  }
}

/** Whether an operation's request body can arrive as a form. */
export function takesForm(
  media: RequestBodyMedia | undefined,
): media is RequestBodyMedia {
  return media !== undefined && (media.media === "form" || media.alsoForm === true);
}

/**
 * A pointer read at a later step, as the place in the original request its
 * value came from, by undoing the earlier steps' moves in reverse. A value is
 * typed once, when the form is decoded, so a field an earlier step moved has
 * to be typed where the caller wrote it.
 */
export function traceBack(pointer: string, earlier: readonly Instr[]): string {
  let segments = parsePointer(pointer);
  for (const instr of [...earlier].reverse()) {
    if (instr.k !== "move") continue;
    const to = parsePointer(instr.to);
    if (
      to.length > segments.length ||
      !to.every((segment, index) => segment === segments[index])
    ) {
      continue;
    }
    segments = [...parsePointer(instr.from), ...segments.slice(to.length)];
  }
  return formatPointer(segments);
}

/** Two steps' declarations as one, the later step's pointers traced to the original request. */
export function mergeForms(
  earlier: FormProgram | undefined,
  later: FormProgram | undefined,
  earlierInstrs: readonly Instr[],
): FormProgram | undefined {
  if (!earlier) return later;
  if (!later) return earlier;
  const types: Record<string, FormType> = { ...earlier.types };
  for (const [pointer, type] of Object.entries(later.types)) {
    const original = traceBack(pointer, earlierInstrs);
    if (!(original in types)) types[original] = type;
  }
  return { fields: { ...earlier.fields, ...later.fields }, types };
}
