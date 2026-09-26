/**
 * A generated map in the shapes the language packs take: the TypeScript and
 * Python packs' `SymbolMap` (`@invariant-app/migrate-core`), and the Go
 * pack's, whose symbols are a package and a key.
 */
import type { SymbolMap } from "@invariant-app/migrate-core";
import type { GeneratedSymbols } from "./types.ts";

/** The part of a `SymbolMap` a symbol map generator knows. */
export function symbolMapOf(
  generated: Pick<GeneratedSymbols, "types" | "operations">,
): Required<Pick<SymbolMap, "types" | "operations">> {
  const types: Record<string, string> = {};
  for (const [schema, entry] of Object.entries(generated.types))
    types[schema] = entry.symbol;
  const operations: Record<string, { type: string; method: string }> = {};
  for (const [key, entry] of Object.entries(generated.operations)) {
    operations[key] = { type: entry.type, method: entry.method };
  }
  return { types, operations };
}

/** A Go SDK's object, as the Go pack names it. */
export interface GoSymbolRef {
  /** The package's path inside the module, `""` for its root. */
  package: string;
  /** `CheckoutSession`, or `CustomerService.New` for a method. */
  key: string;
}

/** The types and operations of a Go map, as the Go pack's `GoSymbolMap` holds them. */
export function goSymbolsOf(generated: Pick<GeneratedSymbols, "types" | "operations">): {
  types: Record<string, GoSymbolRef>;
  operations: Record<string, GoSymbolRef[]>;
} {
  const types: Record<string, GoSymbolRef> = {};
  for (const [schema, entry] of Object.entries(generated.types)) {
    const pkg = entry.package ?? "";
    const key = pkg === "" ? entry.symbol : entry.symbol.slice(pkg.length + 1);
    types[schema] = { package: pkg, key };
  }
  const operations: Record<string, GoSymbolRef[]> = {};
  for (const [operation, entry] of Object.entries(generated.operations)) {
    operations[operation] = [
      { package: entry.package ?? "", key: `${entry.type}.${entry.method}` },
    ];
  }
  return { types, operations };
}
