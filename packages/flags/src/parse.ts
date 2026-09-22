import type { RuntimeFlags } from "@invariant-app/runtime";

/** Flags from their JSON text, or nothing when the text is not an object. Throws on invalid JSON. */
export function parseFlags(text: string): RuntimeFlags | undefined {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;

  const strings = (entry: unknown): string[] | undefined =>
    Array.isArray(entry)
      ? entry.filter((item): item is string => typeof item === "string")
      : undefined;

  const contracts = strings(record["disabledContracts"]);
  const changes = strings(record["disabledChanges"]);

  return {
    ...(record["allDisabled"] === true ? { allDisabled: true } : {}),
    ...(contracts ? { disabledContracts: contracts } : {}),
    ...(changes ? { disabledChanges: changes } : {}),
  };
}
