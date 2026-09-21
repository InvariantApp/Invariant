/**
 * `allOf` branches that disagree about a keyword the differ insists they agree
 * on, made to agree the way the rest of this system reads them.
 *
 * The differ merges `allOf` before comparing, and refuses the whole document
 * when two branches state different `default`s or `type`s: "unable to resolve
 * Default conflict". Real providers write exactly that on purpose. A schema
 * extending a base restates the base's default for its own case, which
 * JSON Schema allows, since a default is an annotation and not a constraint.
 * Okta, Mistral and PagerDuty do it, and every one of their pairs was lost.
 *
 * `resolveSchema` in `@invariant/contract` keeps the first statement of such
 * a keyword, reading the keywords beside an `allOf` before its branches, so
 * the differ is given the same: the first part that states it keeps it, and
 * later ones that state something else do not. Lists of
 * allowed values are intersected, as the differ does, except where the
 * intersection is empty, which describes no value and is read as the first
 * list, as the resolver reads it. A later
 * branch that is a `$ref` is replaced by a copy of what it refers to, so a
 * schema shared elsewhere is never changed for its other uses. Only the
 * document handed to the differ changes, never the contract.
 */
import type { OpenApiDocument } from "@invariant/contract";
import { isJsonObject, type JsonObject, type JsonValue } from "@invariant/ir";

/** The keywords the differ refuses to merge when branches disagree. */
const MUST_AGREE = ["default", "type"] as const;

function resolveLocal(document: JsonObject, ref: string): JsonValue | undefined {
  if (!ref.startsWith("#/")) return undefined;
  let node: JsonValue | undefined = document;
  for (const raw of ref.slice(2).split("/")) {
    let key: string;
    try {
      key = decodeURIComponent(raw).replaceAll("~1", "/").replaceAll("~0", "~");
    } catch {
      return undefined;
    }
    node = Array.isArray(node)
      ? node[Number(key)]
      : isJsonObject(node)
        ? node[key]
        : undefined;
    if (node === undefined) return undefined;
  }
  return node;
}

/** What a branch says, following one `$ref` as the differ does. */
function statementOf(document: JsonObject, branch: JsonValue): JsonObject | undefined {
  if (!isJsonObject(branch)) return undefined;
  const ref = branch["$ref"];
  if (typeof ref !== "string") return branch;
  const target = resolveLocal(document, ref);
  return isJsonObject(target) ? target : undefined;
}

/** A schema one branch contributes, and how to put a changed one in its place. */
interface Slot {
  raw: () => JsonValue | undefined;
  write: (next: JsonObject) => void;
  /**
   * The object to change in place, where `raw` hands back a copy: the
   * keywords beside an `allOf`, which are read as a branch of their own but
   * live on the schema that holds it.
   */
  live?: () => JsonObject;
}

/** Deepest nesting followed; only a schema that contains itself goes further. */
const MAX_DEPTH = 32;

/**
 * The slots a branch stands for once its own `allOf` is merged in: each of
 * its branches, then the keywords beside them, as the resolver reads it.
 */
function expand(document: JsonObject, slot: Slot, depth: number): Slot[] {
  const statement = statementOf(document, slot.raw() ?? null);
  if (!statement || !Array.isArray(statement["allOf"]) || depth > MAX_DEPTH)
    return [slot];
  const own = () => editable(document, slot);
  const branches = statement["allOf"];
  return [
    // Beside the `allOf` first, as the resolver reads them: that is where
    // OpenAPI 3.0 writes "this schema, but with this default here".
    {
      raw: () => {
        const { allOf: _, ...siblings } = statementOf(document, slot.raw() ?? null) ?? {};
        return siblings;
      },
      write: (next) => {
        const target = own();
        for (const key of Object.keys(target)) if (key !== "allOf") delete target[key];
        Object.assign(target, next);
      },
      live: own,
    },
    ...branches.flatMap((_, index) =>
      expand(
        document,
        {
          // Read without copying: only a write may replace a `$ref`.
          raw: () => {
            const current = statementOf(document, slot.raw() ?? null)?.["allOf"];
            return Array.isArray(current) ? current[index] : undefined;
          },
          write: (next) => {
            (own()["allOf"] as JsonValue[])[index] = next;
          },
        },
        depth + 1,
      ),
    ),
  ];
}

/**
 * The schema a slot holds, made safe to change: a `$ref` is replaced by a
 * copy of what it refers to, so the schema it names is untouched elsewhere.
 */
function editable(document: JsonObject, slot: Slot): JsonObject {
  if (slot.live) return slot.live();
  const raw = slot.raw();
  if (isJsonObject(raw) && typeof raw["$ref"] !== "string") return raw;
  const copy = structuredClone(statementOf(document, raw ?? null) ?? {});
  slot.write(copy);
  return copy;
}

/**
 * Makes schemas that must hold at once agree, the way the resolver merges
 * them: the first statement of `default` or `type` stands, and properties
 * and items stated by more than one of them are merged the same way. Returns
 * whether they disagreed; with `apply` false nothing is changed, so a
 * document can be checked without a copy.
 */
function agree(
  document: JsonObject,
  slots: Slot[],
  apply: boolean,
  depth: number,
): boolean {
  if (depth > MAX_DEPTH) return false;
  const parts = slots.flatMap((slot) => expand(document, slot, depth));
  if (parts.length < 2) return false;
  let disagreed = false;
  for (const keyword of MUST_AGREE) {
    let first: string | undefined;
    for (const part of parts) {
      const value = statementOf(document, part.raw() ?? null)?.[keyword];
      if (value === undefined) continue;
      const text = JSON.stringify(value);
      if (first === undefined) first = text;
      else if (text !== first) {
        disagreed = true;
        if (apply) delete editable(document, part)[keyword];
      }
    }
  }
  // Lists of allowed values that have none in common describe no value, and
  // the differ refuses them. The resolver keeps the first list in that case,
  // so the later ones that share nothing with it go.
  let allowed: Set<string> | undefined;
  for (const part of parts) {
    const values = statementOf(document, part.raw() ?? null)?.["enum"];
    if (!Array.isArray(values)) continue;
    const texts = values.map((value) => JSON.stringify(value));
    if (allowed === undefined) {
      allowed = new Set(texts);
    } else if (!texts.some((text) => (allowed as Set<string>).has(text))) {
      disagreed = true;
      if (apply) delete editable(document, part)["enum"];
    } else {
      allowed = new Set(texts.filter((text) => (allowed as Set<string>).has(text)));
    }
  }
  const nested = (keyword: "properties" | "items", name?: string): Slot[] =>
    parts.flatMap((part): Slot[] => {
      const statement = statementOf(document, part.raw() ?? null);
      const holder = keyword === "items" ? statement : statement?.["properties"];
      const key = keyword === "items" ? "items" : (name as string);
      if (!isJsonObject(holder) || holder[key] === undefined) return [];
      return [
        {
          raw: () => {
            const current = statementOf(document, part.raw() ?? null);
            const at = keyword === "items" ? current : current?.["properties"];
            return isJsonObject(at) ? at[key] : undefined;
          },
          write: (next) => {
            const own = editable(document, part);
            if (keyword === "items") own["items"] = next;
            else
              own["properties"] = { ...(own["properties"] as JsonObject), [key]: next };
          },
        },
      ];
    });
  const names = new Set(
    parts.flatMap((part) => {
      const properties = statementOf(document, part.raw() ?? null)?.["properties"];
      return isJsonObject(properties) ? Object.keys(properties) : [];
    }),
  );
  for (const name of names) {
    if (agree(document, nested("properties", name), apply, depth + 1)) disagreed = true;
  }
  if (agree(document, nested("items"), apply, depth + 1)) disagreed = true;
  return disagreed;
}

/** The slot for the schema at `node`, as the only branch of its own merge. */
function whole(node: JsonObject): Slot {
  return {
    raw: () => node,
    write: (next) => {
      for (const key of Object.keys(node)) delete node[key];
      Object.assign(node, next);
    },
  };
}

function eachAllOf(value: JsonValue, visit: (node: JsonObject) => boolean): boolean {
  if (Array.isArray(value)) return value.some((item) => eachAllOf(item, visit));
  if (!isJsonObject(value)) return false;
  if (Array.isArray(value["allOf"]) && visit(value)) return true;
  return Object.values(value).some((child) => eachAllOf(child, visit));
}

/**
 * The document with every `allOf` made consistent for the differ, or the
 * document itself when nothing needed to change. Most need nothing, so the
 * input is only copied when one does.
 */
export function agreeingAllOf(input: OpenApiDocument): OpenApiDocument {
  if (!eachAllOf(input, (node) => agree(input, [whole(node)], false, 0))) return input;
  const document = structuredClone(input);
  eachAllOf(document, (node) => {
    agree(document, [whole(node)], true, 0);
    return false;
  });
  return document;
}
