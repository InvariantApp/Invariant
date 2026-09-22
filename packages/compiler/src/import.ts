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
