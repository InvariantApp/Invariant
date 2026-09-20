import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Change } from "./change.ts";
import { CompiledProgram } from "./program.ts";

export class IrValidationError extends Error {
  readonly issues: string[];

  constructor(what: string, issues: string[]) {
    super(`${what} is not valid IR:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "IrValidationError";
    this.issues = issues;
  }
}

function check<T extends TSchema>(schema: T, what: string, value: unknown): void {
  if (Value.Check(schema, value)) return;
  const issues = [...Value.Errors(schema, value)]
    .slice(0, 20)
    .map((error) => `${error.path || "/"}: ${error.message}`);
  throw new IrValidationError(what, issues);
}

/**
 * Unknown fields and unknown op kinds are hard errors. There is no lenient
 * mode: an IR document the compiler does not fully understand must never reach
 * a request path.
 */
export function parseChange(value: unknown): Change {
  check(Change, "Change", value);
  return value as Change;
}

export function parseCompiledProgram(value: unknown): CompiledProgram {
  check(CompiledProgram, "Compiled program", value);
  return value as CompiledProgram;
}

/** JSON Schema for the IR documents, for the language-neutral spec and tooling. */
export function irJsonSchemas(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Invariant IR",
    $defs: {
      Change: Change as unknown as Record<string, unknown>,
      CompiledProgram: CompiledProgram as unknown as Record<string, unknown>,
    },
  };
}
