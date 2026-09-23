/**
 * Bringing a declaration over from the new contract, with what it refers to.
 *
 * `add`, and a parameter or body field that arrives from the new contract,
 * copy their declaration from there. A declaration can refer to components
 * the old contract never defined, and copied on its own it would leave the
 * prediction pointing at nothing: the differ cannot even load that, and a
 * real Plaid release failed closure that way. Whatever it refers to, and
 * whatever that refers to in turn, comes with it when the prediction does not
 * already define it. A component the prediction does define is left as it is,
 * because a difference there is a change of its own, for closure to judge.
 */
import { type OpenApiDocument, resolveRef } from "@invariant-app/contract";
import { isJsonObject, type JsonObject, type JsonValue } from "@invariant-app/ir";

const LOCAL = /^#\/components\/([^/]+)\/([^/]+)$/;

function refsIn(value: JsonValue, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) refsIn(entry, found);
    return;
  }
  if (!isJsonObject(value)) return;
  const ref = value["$ref"];
  if (typeof ref === "string") found.add(ref);
  for (const [key, child] of Object.entries(value)) {
    if (key !== "$ref") refsIn(child, found);
  }
}

export function importReferences(
  document: OpenApiDocument,
  source: OpenApiDocument,
  declaration: JsonValue,
): void {
  const pending = new Set<string>();
  refsIn(declaration, pending);
  const seen = new Set<string>();
  while (pending.size > 0) {
    const ref = pending.values().next().value as string;
    pending.delete(ref);
    if (seen.has(ref)) continue;
    seen.add(ref);
    const match = LOCAL.exec(ref);
    if (!match) continue;
    if (resolveRef(document, ref) !== undefined) continue;
    const found = resolveRef(source, ref);
    if (found === undefined) continue;
    const kind = decodeURIComponent(
      (match[1] as string).replace(/~1/g, "/").replace(/~0/g, "~"),
    );
    const name = (match[2] as string).replace(/~1/g, "/").replace(/~0/g, "~");
    let components = document["components"];
    if (!isJsonObject(components)) {
      components = {};
      document["components"] = components;
    }
    let bucket = (components as JsonObject)[kind];
    if (!isJsonObject(bucket)) {
      bucket = {};
      (components as JsonObject)[kind] = bucket;
    }
    const copy = structuredClone(found);
    (bucket as JsonObject)[name] = copy;
    refsIn(copy, pending);
  }
}

/**
 * A restated declaration, brought over so that it means in the prediction
 * exactly what it means in the new contract.
 *
 * `importReferences` leaves a component the prediction already defines as it
 * is, which is right for an op that only borrows a shape. A restatement is
 * different: it was proved against the new contract's statement, references
 * and all. Plaid's `AccountIdentity` came to be built from `AccountBase`,
 * whose balances may now be null; written into the prediction, the reference
 * found the old `AccountBase`, the place said something nobody had proved,
 * and closure reported fifty-odd balances that became nullable in a release
 * where none had. So a component the prediction states differently, or one
 * that leads to such a component, comes over under a name of its own, and the
 * restated place refers to that. What other places refer to is untouched.
 */
export function importRestated(
  document: OpenApiDocument,
  source: OpenApiDocument,
  declaration: JsonValue,
): JsonValue {
  // Every local component the declaration reaches in the new contract.
  const reached = new Map<string, JsonValue>();
  const pending = new Set<string>();
  refsIn(declaration, pending);
  while (pending.size > 0) {
    const ref = pending.values().next().value as string;
    pending.delete(ref);
    if (reached.has(ref) || !LOCAL.test(ref)) continue;
    const found = resolveRef(source, ref);
    if (found === undefined) continue;
    reached.set(ref, found);
    refsIn(found, pending);
  }
  // Stated differently in the prediction, or leading to something that is.
  const moved = new Set<string>();
  for (const [ref, found] of reached) {
    const here = resolveRef(document, ref);
    if (here !== undefined && JSON.stringify(here) !== JSON.stringify(found))
      moved.add(ref);
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const [ref, found] of reached) {
      if (moved.has(ref) || resolveRef(document, ref) === undefined) continue;
      const leads = new Set<string>();
      refsIn(found, leads);
      if ([...leads].some((lead) => moved.has(lead))) {
        moved.add(ref);
        grew = true;
      }
    }
  }
  const renamed = new Map<string, string>();
  for (const ref of moved) {
    const match = LOCAL.exec(ref) as RegExpExecArray;
    let candidate = `${match[2]}_restated`;
    for (
      let n = 2;
      resolveRef(document, `#/components/${match[1]}/${candidate}`) !== undefined;
      n += 1
    ) {
      candidate = `${match[2]}_restated${n}`;
    }
    renamed.set(ref, `#/components/${match[1]}/${candidate}`);
  }
  const rewrite = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!isJsonObject(value)) return value;
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] =
        key === "$ref" && typeof child === "string"
          ? (renamed.get(child) ?? child)
          : rewrite(child);
    }
    return out;
  };
  for (const [ref, found] of reached) {
    const target =
      renamed.get(ref) ?? (resolveRef(document, ref) === undefined ? ref : undefined);
    if (target === undefined) continue;
    const match = LOCAL.exec(target) as RegExpExecArray;
    const kind = decodeURIComponent(
      (match[1] as string).replace(/~1/g, "/").replace(/~0/g, "~"),
    );
    const name = (match[2] as string).replace(/~1/g, "/").replace(/~0/g, "~");
    let components = document["components"];
    if (!isJsonObject(components)) {
      components = {};
      document["components"] = components;
    }
    let bucket = (components as JsonObject)[kind];
    if (!isJsonObject(bucket)) {
      bucket = {};
      (components as JsonObject)[kind] = bucket;
    }
    (bucket as JsonObject)[name] = rewrite(structuredClone(found));
  }
  return rewrite(structuredClone(declaration));
}
